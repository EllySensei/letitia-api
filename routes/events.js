const express = require('express');
const db = require('../lib/db');
const { HttpError } = require('../lib/errors');
const {
    validate, parseId, paging, likePattern, nameFields, addressFields, str, email, phone, int, money, date, time, oneOf, list, object,
} = require('../lib/validate');
const {
    EVENT_STATUS, PAID, REMAINING, LINE_DUE, RETURN_STATUS, ADDRESS_PARTS, CLIENT_NAME, VENUE_ADDRESS, cents, freeOnDate, today,
} = require('../lib/sql');
const { insertBooking } = require('../lib/bookings');

const router = express.Router();

const STATUSES = ['Pending', 'Approved', 'Ongoing', 'Completed', 'Cancelled'];
// Ongoing is derived from the date, and Cancelled has its own endpoint.
const SETTABLE_STATUSES = ['Pending', 'Approved', 'Completed'];

const EVENT_SELECT = `
    SELECT e.event_id, e.client_id, ${CLIENT_NAME} AS client_name, e.package_id, p.name AS package_name,
           e.event_type, e.source, e.custom_order, e.event_date, e.start_time, e.venue_name,
           e.venue_street, e.venue_barangay, e.venue_city_municipality, e.venue_province,
           ${VENUE_ADDRESS} AS venue_address, e.setup_notes,
           ${EVENT_STATUS} AS status, e.contract_value, ${PAID} AS paid_amount, ${REMAINING} AS remaining,
           e.created_at
    FROM events e
    JOIN clients c ON c.client_id = e.client_id
    LEFT JOIN packages p ON p.package_id = e.package_id`;

const bookingSchema = {
    client_id: int({ min: 1 }),
    // A walk-in customer, saved as a new client together with the booking (instead of client_id).
    // Without an address of their own they get the venue's.
    new_client: object({
        ...nameFields(),
        phone: phone({ required: true }),
        email: email(),
        ...addressFields('', { required: false }),
    }),
    package_id: int({ min: 1 }),
    // What the event is for: Wedding, Birthday, ... or whatever was typed for "Other".
    event_type: str({ required: true, max: 60 }),
    // A "custom / self order" booked without a package, described in words.
    custom_order: str({ max: 2000 }),
    event_date: date({ required: true }),
    start_time: time(),
    venue_name: str({ max: 150 }),
    ...addressFields('venue_'),
    setup_notes: str({ max: 5000 }),
    status: oneOf(['Pending', 'Approved'], { default: 'Pending' }),
    contract_value: money(),
    return_due_date: date(),
    items: list({ item_id: int({ required: true, min: 1 }), qty: int({ required: true, min: 1, max: 100000 }) }),
    consumables: list({ consumable_id: int({ required: true, min: 1 }), qty: int({ required: true, min: 1, max: 1000000 }) }),
    downpayment: object({
        amount: money({ required: true, min: 0.01 }),
        method: str({ max: 50 }),
        reference_no: str({ max: 100 }),
    }),
};

async function loadEvent(conn, id) {
    const [event] = await conn.query(`${EVENT_SELECT} WHERE e.event_id = ?`, [id]);
    if (!event) return null;
    event.items = await conn.query(
        `SELECT ei.event_item_id, ei.item_id, ri.name, ri.category, ei.qty, ei.pull_status,
                ${LINE_DUE} AS return_due_date, ${RETURN_STATUS} AS return_status
         FROM event_items ei JOIN events e ON e.event_id = ei.event_id JOIN rental_items ri ON ri.item_id = ei.item_id
         WHERE ei.event_id = ? ORDER BY ri.name`,
        [id]
    );
    event.consumables = await conn.query(
        `SELECT ec.consumable_id, c.name, c.unit, ec.qty_used
         FROM event_consumables ec JOIN consumables c ON c.consumable_id = ec.consumable_id
         WHERE ec.event_id = ? ORDER BY c.name`,
        [id]
    );
    event.payments = await conn.query(
        'SELECT payment_id, type, amount, method, paid_at, reference_no FROM payments WHERE event_id = ? ORDER BY paid_at',
        [id]
    );
    return event;
}

async function findEvent(id) {
    const event = await loadEvent(db, id);
    if (!event) throw new HttpError(404, `Event ${id} not found`);
    return event;
}

router.get('/', async (req, res) => {
    const { q, status, from, to, limit, offset } = validate(req.query, {
        q: str({ max: 100 }),
        status: oneOf(STATUSES),
        from: date(),
        to: date(),
        ...paging,
    });
    if (from && to && from > to) throw new HttpError(400, '"from" must be on or before "to"');

    const where = [];
    const params = [];
    if (q) {
        where.push(`(${CLIENT_NAME} LIKE ? OR e.venue_name LIKE ? OR ${VENUE_ADDRESS} LIKE ? OR p.name LIKE ? OR e.event_type LIKE ?)`);
        params.push(...Array(5).fill(likePattern(q)));
    }
    if (from) { where.push('e.event_date >= ?'); params.push(from); }
    if (to) { where.push('e.event_date <= ?'); params.push(to); }

    let sql = `${EVENT_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
    if (status) {
        sql = `SELECT * FROM (${sql}) x WHERE x.status = ?`;
        params.push(status);
    }
    res.json(await db.query(`${sql} ORDER BY event_date, start_time LIMIT ? OFFSET ?`, [...params, limit, offset]));
});

// Dashboard list: the next few days (4 by default), excluding cancelled and completed events.
router.get('/upcoming', async (req, res) => {
    const { days } = validate(req.query, { days: int({ min: 0, max: 365, default: 4 }) });
    const rows = await db.query(
        `SELECT * FROM (${EVENT_SELECT} WHERE e.event_date BETWEEN CURDATE() AND CURDATE() + INTERVAL ? DAY) x
         WHERE x.status NOT IN ('Cancelled', 'Completed') ORDER BY event_date, start_time`,
        [days]
    );
    res.json(rows);
});

router.get('/:id', async (req, res) => {
    res.json(await findEvent(parseId(req.params.id)));
});

// Emails are unique per client, so a walk-in whose email is on file must be picked from the list.
async function insertWalkIn(conn, client, booking) {
    if (client.email) {
        const [row] = await conn.query('SELECT client_id FROM clients WHERE email = ?', [client.email]);
        if (row) throw new HttpError(409, `${client.email} already belongs to client #${row.client_id}; pick them from the client list`);
    }
    const ownAddress = ADDRESS_PARTS.some((part) => client[part]);
    const address = ADDRESS_PARTS.map((part) => (ownAddress ? client[part] : booking[`venue_${part}`]) ?? null);
    const result = await conn.query(
        `INSERT INTO clients (first_name, middle_name, last_name, phone_country_code, phone_number, email, ${ADDRESS_PARTS.join(', ')})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [client.first_name, client.middle_name ?? null, client.last_name, client.phone.phone_country_code, client.phone.phone_number,
            client.email ?? null, ...address]
    );
    return result.insertId;
}

// New booking. Everything (event, item lines, consumables, downpayment) is saved in one
// transaction, so a failure part-way leaves nothing behind.
router.post('/', async (req, res) => {
    const input = validate(req.body, bookingSchema);
    if (!input.client_id === !input.new_client) throw new HttpError(400, 'Send either client_id or new_client');
    const eventId = await db.transaction(async (conn) => {
        if (input.new_client) input.client_id = await insertWalkIn(conn, input.new_client, input);
        return insertBooking(conn, input);
    });
    res.status(201).json(await findEvent(eventId));
});

// Moves an event to another date, taking its item lines (and their return due dates) along.
// Only possible before anything has been pulled, and only if the items are free on the new date.
async function reschedule(conn, id, from, to) {
    if (to < await today(conn)) throw new HttpError(400, 'event_date cannot be in the past');
    const lines = await conn.query(
        `SELECT ei.item_id, ei.qty, ei.pull_status, ri.name FROM event_items ei JOIN rental_items ri ON ri.item_id = ei.item_id
         WHERE ei.event_id = ? AND ei.return_status NOT IN ('Returned', 'Damaged', 'Missing')`,
        [id]
    );
    if (lines.some((l) => l.pull_status !== 'Pending')) {
        throw new HttpError(409, 'Items for this event have already been pulled, so its date can no longer change');
    }
    const wanted = new Map();
    for (const l of lines) wanted.set(l.item_id, { name: l.name, qty: (wanted.get(l.item_id)?.qty || 0) + l.qty });
    const itemIds = [...wanted.keys()];
    if (itemIds.length) {
        // Same row locks as a new booking, so the two can't both take the last units.
        await conn.query('SELECT item_id FROM rental_items WHERE item_id IN (?) FOR UPDATE', [itemIds]);
        const free = await freeOnDate(conn, to, itemIds, { exceptEvent: id });
        const short = itemIds
            .filter((i) => wanted.get(i).qty > free.get(i))
            .map((i) => ({ item_id: i, name: wanted.get(i).name, requested: wanted.get(i).qty, available: free.get(i) }));
        if (short.length) throw new HttpError(409, `Not enough stock on ${to}`, short);
    }
    await conn.query(
        'UPDATE event_items SET return_due_date = return_due_date + INTERVAL DATEDIFF(?, ?) DAY WHERE event_id = ? AND return_due_date IS NOT NULL',
        [to, from, id]
    );
}

// Edits details, moves the date and moves the status along. Item lines are fixed once
// booked; cancel and rebook to change them.
router.patch('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const input = validate(req.body, {
        event_date: date({ required: true }),
        start_time: time(),
        event_type: str({ required: true, max: 60 }),
        venue_name: str({ max: 150 }),
        ...addressFields('venue_'),
        custom_order: str({ max: 2000 }),
        setup_notes: str({ max: 5000 }),
        status: oneOf(SETTABLE_STATUSES, { required: true }),
        contract_value: money({ required: true }),
    }, { partial: true });
    if (!Object.keys(input).length) throw new HttpError(400, 'No fields to update');

    await db.transaction(async (conn) => {
        const [event] = await conn.query(
            `SELECT e.status, e.event_date, ${PAID} AS paid FROM events e WHERE e.event_id = ? FOR UPDATE`, [id]
        );
        if (!event) throw new HttpError(404, `Event ${id} not found`);
        if (event.status === 'Cancelled') throw new HttpError(409, 'Cancelled events cannot be edited');
        if (input.contract_value !== undefined && cents(input.contract_value) < cents(event.paid)) {
            throw new HttpError(409, `contract_value cannot be less than the ${event.paid} already paid`);
        }
        if (input.event_date === event.event_date) delete input.event_date;
        if (input.event_date) await reschedule(conn, id, event.event_date, input.event_date);
        const fields = Object.keys(input);
        if (!fields.length) return;
        await conn.query(
            `UPDATE events SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE event_id = ?`,
            [...fields.map((f) => input[f]), id]
        );
    });
    res.json(await findEvent(id));
});

// Unpulled items are released back to stock straight away; anything already pulled stays
// on the returns watchlist until it's marked returned. Consumables go back too, unless the
// event is already under way and they've been used.
router.patch('/:id/cancel', async (req, res) => {
    const id = parseId(req.params.id);
    await db.transaction(async (conn) => {
        const [event] = await conn.query(`SELECT ${EVENT_STATUS} AS status FROM events e WHERE e.event_id = ? FOR UPDATE`, [id]);
        if (!event) throw new HttpError(404, `Event ${id} not found`);
        if (['Cancelled', 'Completed'].includes(event.status)) {
            throw new HttpError(409, `Event is already ${event.status.toLowerCase()}`);
        }
        await conn.query("UPDATE events SET status = 'Cancelled' WHERE event_id = ?", [id]);
        await conn.query("UPDATE event_items SET is_reserved = FALSE WHERE event_id = ? AND pull_status = 'Pending'", [id]);
        if (event.status !== 'Ongoing') {
            await conn.query(
                `UPDATE consumables c JOIN event_consumables ec ON ec.consumable_id = c.consumable_id
                 SET c.current_level = c.current_level + ec.qty_used WHERE ec.event_id = ?`,
                [id]
            );
        }
    });
    res.json(await findEvent(id));
});

module.exports = router;
