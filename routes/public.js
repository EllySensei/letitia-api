// Storefront endpoints, open without a login: browse the catalog, place an order, and look
// an order up again. Orders arrive as Pending events for an admin to approve.
const express = require('express');
const db = require('../lib/db');
const { HttpError } = require('../lib/errors');
const { validate, parseId, nameFields, str, email, phone, int, date, time, list } = require('../lib/validate');
const { EVENT_STATUS, PAID, REMAINING, ON_HAND, ADDRESS_PARTS, VENUE_ADDRESS } = require('../lib/sql');
const { insertBooking } = require('../lib/bookings');
const { COUNTRIES } = require('../lib/phone');

const router = express.Router();

// Per-IP limit on a route, counted in memory (resets on restart like the login guard).
function rateLimit(max, windowMs, message) {
    const hits = new Map();
    return (req, res, next) => {
        const now = Date.now();
        for (const [ip, h] of hits) if (now - h.first > windowMs) hits.delete(ip);
        const h = hits.get(req.ip) || { count: 0, first: now };
        if (h.count >= max) throw new HttpError(429, message);
        h.count += 1;
        hits.set(req.ip, h);
        next();
    };
}

const orderSchema = {
    ...nameFields(),
    email: email({ required: true }),
    phone: phone({ required: true }),
    purpose: str({ required: true, max: 60 }),
    event_date: date({ required: true }),
    start_time: time(),
    street: str({ required: true, max: 150 }),
    barangay: str({ required: true, max: 100 }),
    city: str({ max: 100 }),
    municipality: str({ max: 100 }),
    province: str({ required: true, max: 100 }),
    notes: str({ max: 2000 }),
    package_id: int({ min: 1 }),
    items: list({ item_id: int({ required: true, min: 1 }), qty: int({ required: true, min: 1, max: 10000 }) }, { max: 50 }),
};

// What a customer may see about their own order.
async function orderSummary(id) {
    const [order] = await db.query(
        `SELECT e.event_id, e.event_type, e.event_date, e.start_time, ${VENUE_ADDRESS} AS venue_address, ${EVENT_STATUS} AS status,
                p.name AS package_name, e.custom_order, e.contract_value,
                ${PAID} AS paid_amount, ${REMAINING} AS remaining, e.created_at
         FROM events e LEFT JOIN packages p ON p.package_id = e.package_id WHERE e.event_id = ?`,
        [id]
    );
    order.items = await db.query(
        `SELECT ri.name, ei.qty FROM event_items ei JOIN rental_items ri ON ri.item_id = ei.item_id
         WHERE ei.event_id = ? ORDER BY ri.name`,
        [id]
    );
    return order;
}

// Country calling codes for phone dropdowns, default country first, with how many digits
// may follow each code (e.g. PH: +63 and 6 to 10 digits).
router.get('/phone-countries', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600').json(COUNTRIES);
});

// Packages and rentable items. Items priced at zero are treated as package-only stock.
router.get('/catalog', async (req, res) => {
    const packages = await db.query(
        'SELECT package_id, name, type, description, base_price, image FROM packages WHERE is_deleted = 0 ORDER BY base_price, name'
    );
    const contents = packages.length ? await db.query(
        `SELECT pi.package_id, ri.name, pi.qty FROM package_items pi JOIN rental_items ri ON ri.item_id = pi.item_id
         WHERE pi.package_id IN (?) ORDER BY ri.name`,
        [packages.map((p) => p.package_id)]
    ) : [];
    for (const p of packages) {
        p.items = contents.filter((c) => c.package_id === p.package_id).map(({ name, qty }) => ({ name, qty }));
    }
    const items = await db.query(
        `SELECT ri.item_id, ri.name, ri.category, ri.rental_price, ri.description, ri.image, ${ON_HAND} AS qty_available
         FROM rental_items ri WHERE ri.is_deleted = 0 AND ri.rental_price > 0 ORDER BY ri.category, ri.name`
    );
    res.json({ packages, items });
});

router.post('/orders', rateLimit(20, 60 * 60 * 1000, 'Too many orders from this connection, please try again later'), async (req, res) => {
    const input = validate(req.body, orderSchema);
    const { phone_country_code: code, phone_number: number } = input.phone;
    if (!input.city && !input.municipality) throw new HttpError(400, 'Enter a city or a municipality');
    const items = input.items ?? [];
    const custom = !input.package_id && !items.length;
    if (custom && (input.notes ?? '').length < 15) {
        throw new HttpError(400, 'Describe your custom order in the notes (at least 15 characters)');
    }

    const fullName = [input.first_name, input.middle_name, input.last_name].filter(Boolean).join(' ');
    // The form has separate City and Municipality boxes; a place is one or the other.
    const address = {
        street: input.street,
        barangay: input.barangay,
        city_municipality: input.city || input.municipality,
        province: input.province,
    };
    const addressValues = ADDRESS_PARTS.map((part) => address[part]);

    const eventId = await db.transaction(async (conn) => {
        // Returning customers are matched by email so their bookings stay under one client.
        const [existing] = await conn.query('SELECT client_id, is_deleted FROM clients WHERE email = ? FOR UPDATE', [input.email]);
        let clientId;
        if (!existing) {
            const r = await conn.query(
                `INSERT INTO clients (first_name, middle_name, last_name, phone_country_code, phone_number, email, ${ADDRESS_PARTS.join(', ')})
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [input.first_name, input.middle_name ?? null, input.last_name, code, number, input.email, ...addressValues]
            );
            clientId = r.insertId;
        } else if (existing.is_deleted) {
            // An archived client ordering again comes back with the details they just gave.
            clientId = existing.client_id;
            await conn.query(
                `UPDATE clients SET is_deleted = 0, first_name = ?, middle_name = ?, last_name = ?, phone_country_code = ?,
                 phone_number = ?, ${ADDRESS_PARTS.map((part) => `${part} = ?`).join(', ')} WHERE client_id = ?`,
                [input.first_name, input.middle_name ?? null, input.last_name, code, number, ...addressValues, clientId]
            );
        } else {
            // Existing details win; only fill in what's missing.
            clientId = existing.client_id;
            await conn.query(
                'UPDATE clients SET phone_country_code = ?, phone_number = ? WHERE client_id = ? AND phone_number IS NULL',
                [code, number, clientId]
            );
            await conn.query(
                `UPDATE clients SET ${ADDRESS_PARTS.map((part) => `${part} = ?`).join(', ')}
                 WHERE client_id = ? AND ${ADDRESS_PARTS.map((part) => `COALESCE(${part}, '') = ''`).join(' AND ')}`,
                [...addressValues, clientId]
            );
        }

        return insertBooking(conn, {
            client_id: clientId,
            package_id: input.package_id,
            event_type: input.purpose,
            source: 'online',
            custom_order: input.package_id ? undefined : (custom ? input.notes : 'Rental items only'),
            event_date: input.event_date,
            start_time: input.start_time,
            ...Object.fromEntries(ADDRESS_PARTS.map((part) => [`venue_${part}`, address[part]])),
            setup_notes: custom ? undefined : input.notes,
            status: 'Pending',
            items,
        }, { notice: `New online order: ${fullName} for ${input.event_date}` });
    });

    res.status(201).json(await orderSummary(eventId));
});

// Look an order up by its reference number plus the email it was placed with.
router.get('/orders/:id', rateLimit(30, 10 * 60 * 1000, 'Too many lookups, please try again in a few minutes'), async (req, res) => {
    const id = parseId(req.params.id, 'reference number');
    const { email: address } = validate(req.query, { email: email({ required: true }) });
    const [match] = await db.query(
        'SELECT e.event_id FROM events e JOIN clients c ON c.client_id = e.client_id WHERE e.event_id = ? AND c.email = ?',
        [id, address]
    );
    if (!match) throw new HttpError(404, 'No booking matches that reference number and email');
    res.json(await orderSummary(id));
});

module.exports = router;
