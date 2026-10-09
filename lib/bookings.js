// Saving a booking, shared by the admin "New booking" form (routes/events.js) and online
// orders from the storefront (routes/public.js).
const { HttpError } = require('./errors');
const { ADDRESS_PARTS, CLIENT_NAME, freeOnDate, today, addDays, cents } = require('./sql');
const { notify } = require('./notify');

// Adds up quantities so the same id listed twice (or in both the package and the extras) is one line.
function mergeQty(lines, key) {
    const totals = new Map();
    for (const line of lines) totals.set(line[key], (totals.get(line[key]) || 0) + line.qty);
    return totals;
}

// Saves the event, its item lines, consumables and downpayment on `conn`, which must be
// inside a transaction so a failure part-way leaves nothing behind. `input` is a validated
// booking (see bookingSchema in routes/events.js); `input.source` is 'online' for storefront
// orders and defaults to 'admin'. `notice` overrides the "new inquiry"
// alert text. Returns the new event id.
async function insertBooking(conn, input, { notice } = {}) {
    const now = await today(conn);
    if (input.event_date < now) throw new HttpError(400, 'event_date cannot be in the past');
    const dueDate = input.return_due_date ?? addDays(input.event_date, 1);
    if (dueDate < input.event_date) throw new HttpError(400, 'return_due_date cannot be before event_date');

    const [client] = await conn.query(`SELECT ${CLIENT_NAME} AS full_name FROM clients c WHERE c.client_id = ? AND c.is_deleted = 0`, [input.client_id]);
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

    const venue = ADDRESS_PARTS.map((part) => `venue_${part}`);
    const result = await conn.query(
        `INSERT INTO events (client_id, package_id, event_type, source, custom_order, event_date, start_time, venue_name,
                             ${venue.join(', ')}, status, contract_value, setup_notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.client_id, input.package_id ?? null, input.event_type, input.source ?? 'admin', input.custom_order ?? null,
            input.event_date, input.start_time ?? null, input.venue_name ?? null, ...venue.map((v) => input[v] ?? null),
            input.status, contractValue, input.setup_notes ?? null]
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
        await notify(conn, notice ? `${notice} (event #${id})` : `New inquiry: ${client.full_name} for ${input.event_date} (event #${id})`, 'new_inquiry', { eventId: id });
    }
    return id;
}

module.exports = { insertBooking };
