// Date-based views: Check Date Availability and the Daily Pull Sheet.
const express = require('express');
const db = require('../lib/db');
const { HttpError } = require('../lib/errors');
const { validate, int, date, bool, oneOf } = require('../lib/validate');
const { FREE_ON_DATE } = require('../lib/sql');

const router = express.Router();

const PULL_STATUSES = ['Pending', 'Pulled', 'Packed'];

// Items free on the date. ?all=true also lists fully booked ones (qty_free = 0).
router.get('/availability', async (req, res) => {
    const input = validate(req.query, { date: date({ required: true }), all: bool({ default: false }) });
    const rows = await db.query(
        `SELECT * FROM (
             SELECT ri.item_id, ri.name, ri.category, ri.qty_total, ri.rental_price, ${FREE_ON_DATE} AS qty_free
             FROM rental_items ri WHERE ri.is_deleted = 0
         ) x ${input.all ? '' : 'WHERE x.qty_free > 0'} ORDER BY x.name`,
        [input.date]
    );
    res.json({ date: input.date, items: rows });
});

// Every item needed across all events on the date, combined for printing. An item's status
// is the least-advanced status among its lines (Pending < Pulled < Packed).
router.get('/pullsheet', async (req, res) => {
    const input = validate(req.query, { date: date({ required: true }) });
    const items = await db.query(
        `SELECT ri.item_id, ri.name, ri.category, SUM(ei.qty) AS qty_needed,
                CASE MIN(FIELD(ei.pull_status, 'Pending', 'Pulled', 'Packed'))
                    WHEN 3 THEN 'Packed' WHEN 2 THEN 'Pulled' ELSE 'Pending' END AS status,
                GROUP_CONCAT(DISTINCT e.event_id ORDER BY e.event_id) AS event_ids
         FROM event_items ei
         JOIN events e ON e.event_id = ei.event_id
         JOIN rental_items ri ON ri.item_id = ei.item_id
         WHERE e.event_date = ? AND e.status <> 'Cancelled'
         GROUP BY ri.item_id, ri.name, ri.category
         ORDER BY ri.category, ri.name`,
        [input.date]
    );
    const consumables = await db.query(
        `SELECT c.consumable_id, c.name, c.unit, SUM(ec.qty_used) AS qty_needed
         FROM event_consumables ec
         JOIN events e ON e.event_id = ec.event_id
         JOIN consumables c ON c.consumable_id = ec.consumable_id
         WHERE e.event_date = ? AND e.status <> 'Cancelled'
         GROUP BY c.consumable_id, c.name, c.unit ORDER BY c.name`,
        [input.date]
    );
    const events = await db.query(
        `SELECT e.event_id, c.full_name AS client_name, e.start_time, e.venue_name, e.setup_notes
         FROM events e JOIN clients c ON c.client_id = e.client_id
         WHERE e.event_date = ? AND e.status <> 'Cancelled' ORDER BY e.start_time`,
        [input.date]
    );
    for (const item of items) item.event_ids = item.event_ids ? String(item.event_ids).split(',').map(Number) : [];
    res.json({ date: input.date, events, items, consumables });
});

// Updates the pull status of one item across every event on the date.
router.patch('/pullsheet', async (req, res) => {
    const input = validate(req.body, {
        date: date({ required: true }),
        item_id: int({ required: true, min: 1 }),
        pull_status: oneOf(PULL_STATUSES, { required: true }),
    });
    const result = await db.query(
        `UPDATE event_items ei JOIN events e ON e.event_id = ei.event_id
         SET ei.pull_status = ?
         WHERE e.event_date = ? AND e.status <> 'Cancelled' AND ei.item_id = ?
           AND ei.return_status NOT IN ('Returned', 'Damaged', 'Missing')`,
        [input.pull_status, input.date, input.item_id]
    );
    if (!result.affectedRows) {
        throw new HttpError(404, `Item ${input.item_id} is not on the pull sheet for ${input.date} (or has already been returned)`);
    }
    res.json({ message: `Updated ${result.affectedRows} line(s) to ${input.pull_status}`, updated: result.affectedRows });
});

module.exports = router;
