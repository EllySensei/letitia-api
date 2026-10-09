const db = require('./db');
const { LINE_OPEN, LINE_DUE, ON_HAND, CLIENT_NAME } = require('./sql');

// conn can be the pool helper or a transaction connection. `eventId` links the notification
// to the event it's about, so the bell can open it.
function notify(conn, message, type, { refKey = null, eventId = null } = {}) {
    return conn.query(
        `INSERT INTO notifications (message, type, event_id, ref_key) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE notification_id = notification_id`,
        [message.slice(0, 500), type, eventId, refKey]
    );
}

// Low stock and overdue returns are conditions, not events, so they are checked when
// someone looks (bell or dashboard). ref_key makes each alert fire once per occurrence.
async function syncAlerts() {
    await db.query(
        `INSERT IGNORE INTO notifications (message, type, event_id, ref_key)
         SELECT LEFT(CONCAT('Overdue return: ', ei.qty, ' x ', ri.name, ' for ', ${CLIENT_NAME},
                     ' (event #', e.event_id, ') was due ', ${LINE_DUE}), 500),
                'overdue_return', e.event_id, CONCAT('overdue:', ei.event_item_id)
         FROM event_items ei
         JOIN events e ON e.event_id = ei.event_id
         JOIN clients c ON c.client_id = e.client_id
         JOIN rental_items ri ON ri.item_id = ei.item_id
         WHERE ${LINE_OPEN} AND ${LINE_DUE} < CURDATE()`
    );

    // Rental items have no reorder level (they come back after each event), so only running out alerts.
    const rental = await db.query(
        `SELECT x.item_id, x.name, x.qty FROM (
             SELECT ri.item_id, ri.name, ${ON_HAND} AS qty
             FROM rental_items ri WHERE ri.is_deleted = 0) x
         WHERE x.qty <= 0`
    );
    const consumables = await db.query(
        `SELECT consumable_id, name, unit, current_level FROM consumables
         WHERE is_deleted = 0 AND current_level <= reorder_level`
    );

    // Alerts already raised are skipped up front: re-sending them would be a no-op, but one
    // the database still reports as a write, which would bump the heartbeat on every look.
    const raised = new Set((await db.query("SELECT ref_key FROM notifications WHERE ref_key LIKE 'low\\_stock:%'")).map((n) => n.ref_key));
    const keys = [];
    for (const r of rental) {
        keys.push(`low_stock:item:${r.item_id}`);
        if (!raised.has(keys.at(-1))) await notify(db, `Out of stock: ${r.name} (${r.qty} on hand)`, 'low_stock', { refKey: keys.at(-1) });
    }
    for (const c of consumables) {
        keys.push(`low_stock:consumable:${c.consumable_id}`);
        if (!raised.has(keys.at(-1))) {
            await notify(db, `${c.current_level === 0 ? 'Out of stock' : 'Low stock'}: ${c.name} (${c.current_level} ${c.unit} left)`, 'low_stock', { refKey: keys.at(-1) });
        }
    }

    // Release the key of anything that recovered, so the next dip alerts again.
    if (keys.length) {
        await db.query("UPDATE notifications SET ref_key = NULL WHERE ref_key LIKE 'low\\_stock:%' AND ref_key NOT IN (?)", [keys]);
    } else {
        await db.query("UPDATE notifications SET ref_key = NULL WHERE ref_key LIKE 'low\\_stock:%'");
    }
}

module.exports = { notify, syncAlerts };
