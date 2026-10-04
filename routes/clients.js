const express = require('express');
const db = require('../lib/db');
const { HttpError } = require('../lib/errors');
const { validate, parseId, paging, likePattern, requireConfirm, str, email } = require('../lib/validate');
const { PAID } = require('../lib/sql');

const router = express.Router();

const clientSchema = {
    full_name: str({ required: true, max: 150 }),
    phone: str({ max: 30 }),
    email: email(),
    billing_name: str({ max: 150 }),
    billing_address: str({ max: 2000 }),
};

// An event that hasn't happened yet and isn't cancelled blocks deleting its client.
const ACTIVE_EVENT = `e.status NOT IN ('Cancelled', 'Completed') AND e.event_date >= CURDATE()`;

// Nearest upcoming event plus contract totals and unpaid balance across non-cancelled events.
const CLIENT_SELECT = `
    SELECT c.client_id, c.full_name, c.phone, c.email, c.billing_name, c.billing_address, c.created_at,
           ne.event_id AS next_event_id, ne.event_date AS next_event_date, ne.venue_name AS next_event_venue,
           COALESCE(t.total_contract, 0) AS total_contract, COALESCE(t.balance, 0) AS balance
    FROM clients c
    LEFT JOIN (
        SELECT e.client_id, SUM(e.contract_value) AS total_contract,
               SUM(GREATEST(e.contract_value - ${PAID}, 0)) AS balance
        FROM events e WHERE e.status <> 'Cancelled' GROUP BY e.client_id
    ) t ON t.client_id = c.client_id
    LEFT JOIN events ne ON ne.event_id = (
        SELECT e2.event_id FROM events e2
        WHERE e2.client_id = c.client_id AND e2.status <> 'Cancelled' AND e2.event_date >= CURDATE()
        ORDER BY e2.event_date, e2.start_time LIMIT 1
    )
    WHERE c.is_deleted = 0`;

async function findClient(id) {
    const [client] = await db.query(`${CLIENT_SELECT} AND c.client_id = ?`, [id]);
    if (!client) throw new HttpError(404, `Client ${id} not found`);
    return client;
}

// Emails are unique even across soft-deleted clients, so explain that case instead of a bare 409.
async function assertEmailFree(address, exceptId = 0) {
    if (!address) return;
    const [row] = await db.query('SELECT client_id, is_deleted FROM clients WHERE email = ? AND client_id <> ?', [address, exceptId]);
    if (row) {
        throw new HttpError(409, row.is_deleted
            ? `Email ${address} belongs to a deleted client (#${row.client_id})`
            : `Email ${address} is already used by client #${row.client_id}`);
    }
}

router.get('/', async (req, res) => {
    const { q, limit, offset } = validate(req.query, { q: str({ max: 100 }), ...paging });
    const params = [];
    let where = '';
    if (q) {
        where = ' AND (c.full_name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)';
        const pattern = likePattern(q);
        params.push(pattern, pattern, pattern);
    }
    const rows = await db.query(`${CLIENT_SELECT}${where} ORDER BY c.full_name LIMIT ? OFFSET ?`, [...params, limit, offset]);
    res.json(rows);
});

router.get('/:id', async (req, res) => {
    res.json(await findClient(parseId(req.params.id)));
});

router.post('/', async (req, res) => {
    const input = validate(req.body, clientSchema);
    await assertEmailFree(input.email);
    const result = await db.query(
        'INSERT INTO clients (full_name, phone, email, billing_name, billing_address) VALUES (?, ?, ?, ?, ?)',
        [input.full_name, input.phone ?? null, input.email ?? null, input.billing_name ?? null, input.billing_address ?? null]
    );
    res.status(201).json(await findClient(result.insertId));
});

router.patch('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const input = validate(req.body, clientSchema, { partial: true });
    if (!Object.keys(input).length) throw new HttpError(400, 'No fields to update');
    await findClient(id);
    if (input.email) await assertEmailFree(input.email, id);

    const fields = Object.keys(input);
    await db.query(
        `UPDATE clients SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE client_id = ?`,
        [...fields.map((f) => input[f]), id]
    );
    res.json(await findClient(id));
});

// Delete all (soft). Clients with an active event are kept and reported back.
router.delete('/', async (req, res) => {
    requireConfirm(req);
    const result = await db.transaction(async (conn) => {
        const skipped = await conn.query(
            `SELECT DISTINCT c.client_id, c.full_name FROM clients c JOIN events e ON e.client_id = c.client_id
             WHERE c.is_deleted = 0 AND ${ACTIVE_EVENT} FOR UPDATE`
        );
        const deleted = await conn.query(
            `UPDATE clients c SET c.is_deleted = 1 WHERE c.is_deleted = 0
             AND NOT EXISTS (SELECT 1 FROM events e WHERE e.client_id = c.client_id AND ${ACTIVE_EVENT})`
        );
        return { deleted: deleted.affectedRows, skipped };
    });
    res.json({
        message: `Deleted ${result.deleted} client(s)` + (result.skipped.length ? `; kept ${result.skipped.length} with active events` : ''),
        ...result,
    });
});

router.delete('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    await db.transaction(async (conn) => {
        const [client] = await conn.query('SELECT client_id FROM clients WHERE client_id = ? AND is_deleted = 0 FOR UPDATE', [id]);
        if (!client) throw new HttpError(404, `Client ${id} not found`);
        const active = await conn.query(`SELECT e.event_id, e.event_date FROM events e WHERE e.client_id = ? AND ${ACTIVE_EVENT}`, [id]);
        if (active.length) {
            throw new HttpError(409, 'Client has active events; cancel or complete them first', active);
        }
        await conn.query('UPDATE clients SET is_deleted = 1 WHERE client_id = ?', [id]);
    });
    res.json({ message: `Client ${id} deleted` });
});

module.exports = router;
