const express = require('express');
const db = require('../lib/db');
const { validate, paging } = require('../lib/validate');
const { EVENT_STATUS, PAID, REMAINING, LINE_OPEN, LINE_OUT, ON_HAND } = require('../lib/sql');
const { syncAlerts } = require('../lib/notify');

const router = express.Router();

// The five stat cards plus the next 4 days of events.
router.get('/dashboard', async (req, res) => {
    await syncAlerts();
    const [stats] = await db.query(
        `SELECT
            (SELECT COUNT(*) FROM events e
             WHERE e.event_date BETWEEN CURDATE() AND CURDATE() + INTERVAL 7 DAY
               AND ${EVENT_STATUS} NOT IN ('Cancelled', 'Completed')) AS upcoming_events,
            (SELECT COUNT(*) FROM events e WHERE ${EVENT_STATUS} = 'Pending') AS pending_inquiries,
            (SELECT COALESCE(SUM(ei.qty), 0) FROM event_items ei JOIN events e ON e.event_id = ei.event_id
             WHERE ${LINE_OPEN} AND ${LINE_OUT}) AS items_out_on_rent,
            (SELECT COUNT(*) FROM rental_items ri WHERE ri.is_deleted = 0 AND ${ON_HAND} <= ri.reorder_level)
              + (SELECT COUNT(*) FROM consumables c WHERE c.is_deleted = 0 AND c.current_level <= c.reorder_level) AS low_stock_alerts,
            (SELECT COALESCE(SUM(${REMAINING}), 0) FROM events e WHERE e.status <> 'Cancelled') AS outstanding_balance`
    );
    const upcoming = await db.query(
        `SELECT * FROM (
             SELECT e.event_id, c.full_name AS client_name, e.event_date, e.start_time, e.venue_name,
                    p.name AS package_name, ${EVENT_STATUS} AS status
             FROM events e JOIN clients c ON c.client_id = e.client_id LEFT JOIN packages p ON p.package_id = e.package_id
             WHERE e.event_date BETWEEN CURDATE() AND CURDATE() + INTERVAL 4 DAY
         ) x WHERE x.status NOT IN ('Cancelled', 'Completed') ORDER BY event_date, start_time`
    );
    res.json({ stats, upcoming_events: upcoming });
});

// Receivables / Payment Pending: events that still have money owing.
router.get('/receivables', async (req, res) => {
    const { limit, offset } = validate(req.query, paging);
    const rows = await db.query(
        `SELECT * FROM (
             SELECT e.event_id, e.client_id, c.full_name AS client_name, c.email, c.phone, e.event_date,
                    ${EVENT_STATUS} AS status, e.contract_value AS total_contract,
                    ${PAID} AS paid_amount, ${REMAINING} AS remaining
             FROM events e JOIN clients c ON c.client_id = e.client_id
             WHERE e.status <> 'Cancelled'
         ) x WHERE x.remaining > 0 ORDER BY event_date LIMIT ? OFFSET ?`,
        [limit, offset]
    );
    res.json(rows);
});

module.exports = router;
