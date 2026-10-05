const express = require('express');
const db = require('../lib/db');
const { HttpError } = require('../lib/errors');
const {
    validate, parseId, paging, likePattern, str, int, money, date, time, oneOf, list, object,
} = require('../lib/validate');
const {
    EVENT_STATUS, PAID, REMAINING, LINE_DUE, RETURN_STATUS, freeOnDate, today, addDays, cents,
} = require('../lib/sql');
const { notify } = require('../lib/notify');

const router = express.Router();

const STATUSES = ['Pending', 'Approved', 'Ongoing', 'Completed', 'Cancelled'];
// Ongoing is derived from the date, and Cancelled has its own endpoint.
const SETTABLE_STATUSES = ['Pending', 'Approved', 'Completed'];

const EVENT_SELECT = `
    SELECT e.event_id, e.client_id, c.full_name AS client_name, e.package_id, p.name AS package_name,
           e.custom_order, e.event_date, e.start_time, e.venue_name, e.venue_address, e.setup_notes,
           ${EVENT_STATUS} AS status, e.contract_value, ${PAID} AS paid_amount, ${REMAINING} AS remaining,
           e.created_at
    FROM events e
    JOIN clients c ON c.client_id = e.client_id
    LEFT JOIN packages p ON p.package_id = e.package_id`;

const bookingSchema = {
    client_id: int({ required: true, min: 1 }),
    package_id: int({ min: 1 }),
    // A "custom / self order" booked without a package, described in words.
    custom_order: str({ max: 255 }),
    event_date: date({ required: true }),
    start_time: time(),
    venue_name: str({ max: 150 }),
    venue_address: str({ max: 2000 }),
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

// Adds up quantities so the same id listed twice (or in both the package and the extras) is one line.
function mergeQty(lines, key) {
    const totals = new Map();
    for (const line of lines) totals.set(line[key], (totals.get(line[key]) || 0) + line.qty);
    return totals;
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
        where.push('(c.full_name LIKE ? OR e.venue_name LIKE ? OR e.venue_address LIKE ? OR p.name LIKE ?)');
        params.push(...Array(4).fill(likePattern(q)));
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

// New booking. Everything (event, item lines, consumables, downpayment) is saved in one
// transaction, so a failure part-way leaves nothing behind.
router.post('/', async (req, res) => {
    const input = validate(req.body, bookingSchema);

    const eventId = await db.transaction(async (conn) => {
        const now = await today(conn);
        if (input.event_date < now) throw new HttpError(400, 'event_date cannot be in the past');
        const dueDate = input.return_due_date ?? addDays(input.event_date, 1);
        if (dueDate < input.event_date) throw new HttpError(400, 'return_due_date cannot be before event_date');

        const [client] = await conn.query('SELECT full_name FROM clients WHERE client_id = ? AND is_deleted = 0', [input.client_id]);
        if (!client) throw new HttpError(400, `Client ${input.client_id} does not exist`);

        let basePrice = 0;
        let packageLines = [];
        if (input.package_id) {
            const [pkg] = await conn.query('SELECT base_price FROM packages WHERE package_id = ? AND is_deleted = 0', [input.package_id]);
            if (!pkg) throw new HttpError(400, `Package ${input.package_id} does not exist`);
            basePrice = pkg.base_price;
            packageLines = await conn.query('SELECT item_id, qty FROM package_items WHERE package_id = ?', [input.package_id]);
        }

        // Rental items: package contents plus any extras.
        const extras = input.items ?? [];
        const wanted = mergeQty([...packageLines, ...extras], 'item_id');
        const itemIds = [...wanted.keys()];
        const items = new Map();
        if (itemIds.length) {
            // Row locks serialise concurrent bookings of the same items until this commits.
            const rows = await conn.query(
                'SELECT item_id, name, rental_price, is_deleted FROM rental_items WHERE item_id IN (?) FOR UPDATE',
                [itemIds]
            );
            for (const r of rows) items.set(r.item_id, r);
            const unknown = itemIds.filter((id) => !items.has(id) || items.get(id).is_deleted);
            if (unknown.length) throw new HttpError(400, `Unknown or deleted inventory item(s): ${unknown.join(', ')}`);

            const free = await freeOnDate(conn, input.event_date, itemIds);
            const short = itemIds
                .filter((id) => wanted.get(id) > free.get(id))
                .map((id) => ({ item_id: id, name: items.get(id).name, requested: wanted.get(id), available: free.get(id) }));
            if (short.length) throw new HttpError(409, `Not enough stock on ${input.event_date}`, short);
        }

        // Consumables are used up, so they're deducted now.
        const usage = mergeQty((input.consumables ?? []), 'consumable_id');
        const consumableIds = [...usage.keys()];
        if (consumableIds.length) {
            const rows = await conn.query(
                'SELECT consumable_id, name, current_level, is_deleted FROM consumables WHERE consumable_id IN (?) FOR UPDATE',
                [consumableIds]
            );
            const byId = new Map(rows.map((r) => [r.consumable_id, r]));
            const unknown = consumableIds.filter((id) => !byId.has(id) || byId.get(id).is_deleted);
            if (unknown.length) throw new HttpError(400, `Unknown or deleted consumable(s): ${unknown.join(', ')}`);
            const short = consumableIds
                .filter((id) => usage.get(id) > byId.get(id).current_level)
                .map((id) => ({ consumable_id: id, name: byId.get(id).name, requested: usage.get(id), available: byId.get(id).current_level }));
            if (short.length) throw new HttpError(409, 'Not enough consumables in stock', short);
        }

        // Default contract: package price plus the rental price of any extra items.
        const contractValue = input.contract_value
            ?? (cents(basePrice) + extras.reduce((sum, l) => sum + cents(items.get(l.item_id).rental_price) * l.qty, 0)) / 100;
        if (contractValue > 99999999.99) throw new HttpError(400, 'contract_value is too large');
        if (input.downpayment && cents(input.downpayment.amount) > cents(contractValue)) {
            throw new HttpError(400, 'Downpayment cannot exceed the contract value');
        }

        const result = await conn.query(
            `INSERT INTO events (client_id, package_id, custom_order, event_date, start_time, venue_name, venue_address,
                                 status, contract_value, setup_notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [input.client_id, input.package_id ?? null, input.custom_order ?? null, input.event_date, input.start_time ?? null, input.venue_name ?? null,
                input.venue_address ?? null, input.status, contractValue, input.setup_notes ?? null]
        );
        const id = result.insertId;

        for (const [itemId, qty] of wanted) {
            await conn.query(
                `INSERT INTO event_items (event_id, item_id, qty, is_reserved, return_due_date, return_status, pull_status)
                 VALUES (?, ?, ?, TRUE, ?, 'Pending', 'Pending')`,
                [id, itemId, qty, dueDate]
            );
        }
        for (const [consumableId, qty] of usage) {
            await conn.query('INSERT INTO event_consumables (event_id, consumable_id, qty_used) VALUES (?, ?, ?)', [id, consumableId, qty]);
            await conn.query('UPDATE consumables SET current_level = current_level - ? WHERE consumable_id = ?', [qty, consumableId]);
        }
        if (input.downpayment) {
            const { amount, method, reference_no } = input.downpayment;
            await conn.query(
                "INSERT INTO payments (event_id, type, amount, method, reference_no) VALUES (?, 'downpayment', ?, ?, ?)",
                [id, amount, method ?? null, reference_no ?? null]
            );
        }
        if (input.status === 'Pending') {
            await notify(conn, `New inquiry: ${client.full_name} for ${input.event_date} (event #${id})`, 'new_inquiry');
        }
        return id;
    });

    res.status(201).json(await findEvent(eventId));
});

// Edits details and moves the status along. Dates and items are fixed once booked
// because changing them means re-checking availability; cancel and rebook instead.
router.patch('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const input = validate(req.body, {
        start_time: time(),
        venue_name: str({ max: 150 }),
        venue_address: str({ max: 2000 }),
        custom_order: str({ max: 255 }),
        setup_notes: str({ max: 5000 }),
        status: oneOf(SETTABLE_STATUSES, { required: true }),
        contract_value: money({ required: true }),
    }, { partial: true });
    if (!Object.keys(input).length) throw new HttpError(400, 'No fields to update');

    await db.transaction(async (conn) => {
        const [event] = await conn.query(
            `SELECT e.status, ${PAID} AS paid FROM events e WHERE e.event_id = ? FOR UPDATE`, [id]
        );
        if (!event) throw new HttpError(404, `Event ${id} not found`);
        if (event.status === 'Cancelled') throw new HttpError(409, 'Cancelled events cannot be edited');
        if (input.contract_value !== undefined && cents(input.contract_value) < cents(event.paid)) {
            throw new HttpError(409, `contract_value cannot be less than the ${event.paid} already paid`);
        }
        const fields = Object.keys(input);
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
