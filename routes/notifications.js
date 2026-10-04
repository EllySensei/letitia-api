const express = require('express');
const db = require('../lib/db');
const { HttpError } = require('../lib/errors');
const { validate, parseId, paging, int, bool } = require('../lib/validate');
const { REMAINING } = require('../lib/sql');
const { notify, syncAlerts } = require('../lib/notify');

const router = express.Router();

router.get('/notifications', async (req, res) => {
    const { unread, limit, offset } = validate(req.query, { unread: bool({ default: false }), ...paging });
    await syncAlerts();
    const rows = await db.query(
        `SELECT notification_id, message, type, is_read, created_at FROM notifications
         ${unread ? 'WHERE is_read = 0' : ''} ORDER BY created_at DESC, notification_id DESC LIMIT ? OFFSET ?`,
        [limit, offset]
    );
    const [{ n }] = await db.query('SELECT COUNT(*) AS n FROM notifications WHERE is_read = 0');
    res.json({ unread_count: n, notifications: rows });
});

// Registered before /:id/read so "read-all" isn't parsed as an id.
router.patch('/notifications/read-all', async (req, res) => {
    const result = await db.query('UPDATE notifications SET is_read = 1 WHERE is_read = 0');
    res.json({ message: `Marked ${result.affectedRows} notification(s) as read` });
});

router.patch('/notifications/:id/read', async (req, res) => {
    const id = parseId(req.params.id);
    const result = await db.query('UPDATE notifications SET is_read = 1 WHERE notification_id = ?', [id]);
    if (!result.affectedRows) throw new HttpError(404, `Notification ${id} not found`);
    res.json({ message: `Notification ${id} marked as read` });
});

// Send Reminder (one client) / Send All Reminders (no client_id).
// No email/SMS provider is configured yet, so reminders are only logged to notifications;
// plug the provider in where marked below.
router.post('/reminders', async (req, res) => {
    const { client_id } = validate(req.body, { client_id: int({ min: 1 }) });

    if (client_id) {
        const [client] = await db.query('SELECT client_id FROM clients WHERE client_id = ? AND is_deleted = 0', [client_id]);
        if (!client) throw new HttpError(404, `Client ${client_id} not found`);
    }

    const owing = await db.query(
        `SELECT c.client_id, c.full_name, c.email, c.phone, SUM(${REMAINING}) AS balance
         FROM clients c JOIN events e ON e.client_id = c.client_id
         WHERE c.is_deleted = 0 AND e.status <> 'Cancelled' ${client_id ? 'AND c.client_id = ?' : ''}
         GROUP BY c.client_id, c.full_name, c.email, c.phone
         HAVING balance > 0 ORDER BY c.full_name`,
        client_id ? [client_id] : []
    );
    if (client_id && !owing.length) throw new HttpError(409, `Client ${client_id} has no outstanding balance`);

    const reminders = [];
    for (const c of owing) {
        const contact = c.email || c.phone;
        if (!contact) {
            reminders.push({ client_id: c.client_id, full_name: c.full_name, balance: c.balance, sent: false, reason: 'No email or phone on file' });
            continue;
        }
        // TODO: send via the email/SMS provider here once one is configured.
        await notify(db, `Payment reminder logged for ${c.full_name} (${contact}): balance ${c.balance.toFixed(2)}`, 'reminder');
        reminders.push({ client_id: c.client_id, full_name: c.full_name, balance: c.balance, sent: true, contact });
    }

    res.json({
        message: `Logged ${reminders.filter((r) => r.sent).length} reminder(s)`,
        delivery: 'log-only',
        reminders,
    });
});

module.exports = router;
