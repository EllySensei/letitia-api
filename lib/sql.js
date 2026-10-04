// SQL fragments for the values the outline says are computed by the backend rather than
// typed in. Each assumes the aliases noted beside it.

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
const FREE_ON_DATE = `GREATEST(ri.qty_total - ri.qty_out_of_service - COALESCE((
    SELECT SUM(ei.qty) FROM event_items ei JOIN events e ON e.event_id = ei.event_id
    WHERE ei.item_id = ri.item_id AND ${LINE_OPEN}
      AND ? BETWEEN (CASE WHEN ei.pull_status <> 'Pending' THEN LEAST(e.event_date, CURDATE()) ELSE e.event_date END)
                AND (CASE WHEN ${LINE_DUE} < CURDATE() THEN DATE '9999-12-31' ELSE ${LINE_DUE} END)), 0), 0)`;

const stockStatus = (qty, reorder) => `(CASE
    WHEN ${qty} <= 0 THEN 'Out of Stock'
    WHEN ${qty} <= ${reorder} THEN 'Low Stock'
    ELSE 'In Stock' END)`;

// Item ids -> units free on `date`.
async function freeOnDate(conn, date, itemIds) {
    if (!itemIds.length) return new Map();
    const rows = await conn.query(
        `SELECT ri.item_id, ${FREE_ON_DATE} AS qty_free FROM rental_items ri WHERE ri.item_id IN (?)`,
        [date, itemIds]
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
    EVENT_STATUS, PAID, REMAINING, LINE_OPEN, LINE_DUE, LINE_OUT, RETURN_STATUS, ON_HAND, FREE_ON_DATE,
    stockStatus, freeOnDate, today, addDays, cents,
};
