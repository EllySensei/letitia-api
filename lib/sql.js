// SQL fragments for the values the outline says are computed by the backend rather than
// typed in. Each assumes the aliases noted beside it.
const { HttpError } = require('./errors');

// Names and addresses are stored in parts. These join them into one display label when read;
// NULLIF drops blank parts so they don't leave stray separators.
const joinParts = (sep, cols) => `CONCAT_WS('${sep}', ${cols.map((col) => `NULLIF(${col}, '')`).join(', ')})`;
const ADDRESS_PARTS = ['street', 'barangay', 'city_municipality', 'province'];
// Alias c = clients.
const CLIENT_NAME = joinParts(' ', ['c.first_name', 'c.middle_name', 'c.last_name']);
const CLIENT_ADDRESS = `NULLIF(${joinParts(', ', ADDRESS_PARTS.map((p) => `c.${p}`))}, '')`;
// e.g. '+63 9171234567'.
const CLIENT_PHONE = `NULLIF(${joinParts(' ', ['c.phone_country_code', 'c.phone_number'])}, '')`;
// Alias e = events.
const VENUE_ADDRESS = `NULLIF(${joinParts(', ', ADDRESS_PARTS.map((p) => `e.venue_${p}`))}, '')`;

// Alias e = events. Stored statuses are Pending, Approved, Completed and Cancelled
// ('Inquired' was the original column default and counts as Pending). An Approved event
// becomes Ongoing on its date and Completed after it.
const EVENT_STATUS = `(CASE
    WHEN e.status IN ('Cancelled', 'Completed') THEN e.status
    WHEN e.status IN ('Pending', 'Inquired') THEN 'Pending'
    WHEN e.event_date = CURDATE() THEN 'Ongoing'
    WHEN e.event_date < CURDATE() THEN 'Completed'
    ELSE 'Approved' END)`;

// Alias e. Only downpayments and balance payments count toward the contract;
// deposits, damage fees and refunds are tracked separately.
const PAID = `(SELECT COALESCE(SUM(p.amount), 0) FROM payments p
    WHERE p.event_id = e.event_id AND p.type IN ('downpayment', 'balance'))`;
const REMAINING = `GREATEST(e.contract_value - ${PAID}, 0)`;

// Aliases ei = event_items, e = events.
// A line holds stock until it is returned or written off. Lines of a cancelled event are
// released immediately unless they were already pulled, in which case they must come back.
const LINE_OPEN = `(ei.return_status NOT IN ('Returned', 'Damaged', 'Missing')
    AND (e.status <> 'Cancelled' OR ei.pull_status <> 'Pending'))`;
const LINE_DUE = `COALESCE(ei.return_due_date, e.event_date + INTERVAL 1 DAY)`;
const LINE_OUT = `(e.event_date <= CURDATE() OR ei.pull_status <> 'Pending')`;

const RETURN_STATUS = `(CASE
    WHEN ei.return_status IN ('Returned', 'Damaged', 'Missing') THEN ei.return_status
    WHEN e.status = 'Cancelled' AND ei.pull_status = 'Pending' THEN 'Cancelled'
    WHEN ${LINE_DUE} < CURDATE() THEN 'Overdue'
    WHEN ${LINE_OUT} THEN 'Out'
    ELSE 'Reserved' END)`;

// Alias ri = rental_items. Units physically on the shelf right now.
const ON_HAND = `GREATEST(ri.qty_total - ri.qty_out_of_service - COALESCE((
    SELECT SUM(ei.qty) FROM event_items ei JOIN events e ON e.event_id = ei.event_id
    WHERE ei.item_id = ri.item_id AND ${LINE_OPEN} AND ${LINE_OUT}), 0), 0)`;

// Alias ri, one "?" placeholder for the date. Units not committed to any event whose rental
// window (event date through return due date) covers that date. Items pulled early are
// busy from today, and overdue items are treated as busy until they come back.
// `except` narrows the lines counted, e.g. to leave out an event that is being moved.
const freeOn = (except = '') => `GREATEST(ri.qty_total - ri.qty_out_of_service - COALESCE((
    SELECT SUM(ei.qty) FROM event_items ei JOIN events e ON e.event_id = ei.event_id
    WHERE ei.item_id = ri.item_id AND ${LINE_OPEN}${except}
      AND ? BETWEEN (CASE WHEN ei.pull_status <> 'Pending' THEN LEAST(e.event_date, CURDATE()) ELSE e.event_date END)
                AND (CASE WHEN ${LINE_DUE} < CURDATE() THEN DATE '9999-12-31' ELSE ${LINE_DUE} END)), 0), 0)`;
const FREE_ON_DATE = freeOn();

const stockStatus = (qty, reorder) => `(CASE
    WHEN ${qty} <= 0 THEN 'Out of Stock'
    WHEN ${qty} <= ${reorder} THEN 'Low Stock'
    ELSE 'In Stock' END)`;

// Item codes are unique across rental items and consumables, so a code finds one thing.
// `except` skips the record being edited, e.g. { table: 'rental_items', id: 4 }.
async function assertCodeFree(conn, code, except = {}) {
    const [taken] = await conn.query(
        `SELECT 'rental item' AS kind, name FROM rental_items WHERE item_code = ? AND NOT (? = 'rental_items' AND item_id = ?)
         UNION ALL
         SELECT 'consumable', name FROM consumables WHERE item_code = ? AND NOT (? = 'consumables' AND consumable_id = ?)`,
        [code, except.table ?? '', except.id ?? 0, code, except.table ?? '', except.id ?? 0]
    );
    if (taken) throw new HttpError(409, `Item code ${code} is already used by the ${taken.kind} "${taken.name}"`);
}

// New records without a code get one from their id, e.g. RNT-0007; on the rare clash with a
// hand-typed code, a suffix is added.
async function assignCode(conn, table, idColumn, id, prefix) {
    const base = `${prefix}-${String(id).padStart(4, '0')}`;
    for (let n = 0; ; n += 1) {
        const candidate = n ? `${base}-${n}` : base;
        const [taken] = await conn.query(
            'SELECT 1 FROM rental_items WHERE item_code = ? UNION ALL SELECT 1 FROM consumables WHERE item_code = ?',
            [candidate, candidate]
        );
        if (!taken) {
            await conn.query(`UPDATE ${table} SET item_code = ? WHERE ${idColumn} = ?`, [candidate, id]);
            return candidate;
        }
    }
}

// Item ids -> units free on `date`. `exceptEvent` leaves that event's own lines out, to check
// whether it can move to `date`.
async function freeOnDate(conn, date, itemIds, { exceptEvent } = {}) {
    if (!itemIds.length) return new Map();
    const rows = await conn.query(
        `SELECT ri.item_id, ${freeOn(exceptEvent ? ' AND e.event_id <> ?' : '')} AS qty_free FROM rental_items ri WHERE ri.item_id IN (?)`,
        exceptEvent ? [exceptEvent, date, itemIds] : [date, itemIds]
    );
    return new Map(rows.map((r) => [r.item_id, r.qty_free]));
}

// The database's idea of today, so date comparisons agree with CURDATE() in queries.
async function today(conn) {
    const [row] = await conn.query('SELECT CURDATE() AS d');
    return row.d;
}

function addDays(isoDate, days) {
    return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

// Money comparisons in whole cents to avoid floating-point drift.
const cents = (n) => Math.round(Number(n) * 100);

module.exports = {
    ADDRESS_PARTS, CLIENT_NAME, CLIENT_ADDRESS, CLIENT_PHONE, VENUE_ADDRESS, EVENT_STATUS, PAID, REMAINING, LINE_OPEN, LINE_DUE, LINE_OUT, RETURN_STATUS, ON_HAND, FREE_ON_DATE,
    stockStatus, freeOnDate, today, addDays, cents, assertCodeFree, assignCode,
};
