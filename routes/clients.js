const express = require('express');
const db = require('../lib/db');
const { HttpError } = require('../lib/errors');
const {
    validate, parseId, paging, likePattern, requireConfirm, nameFields, addressFields, archivedQuery, str, email, phone,
} = require('../lib/validate');
const { PAID, CLIENT_NAME, CLIENT_ADDRESS, CLIENT_PHONE } = require('../lib/sql');

const router = express.Router();

const clientSchema = {
    ...nameFields(),
    phone: phone({ required: true }),
    email: email(),
    billing_name: str({ max: 150 }),
    ...addressFields(),
};

// An event that hasn't happened yet and isn't cancelled blocks archiving its client.
const ACTIVE_EVENT = `e.status NOT IN ('Cancelled', 'Completed') AND e.event_date >= CURDATE()`;

// Nearest upcoming event plus contract totals and unpaid balance across non-cancelled events.
// full_name and billing_address are display labels joined from the stored parts.
const CLIENT_SELECT = `
    SELECT c.client_id, c.first_name, c.middle_name, c.last_name, ${CLIENT_NAME} AS full_name, ${CLIENT_PHONE} AS phone,
           c.phone_country_code, c.phone_number, c.email, c.billing_name,
           c.street, c.barangay, c.city_municipality, c.province, ${CLIENT_ADDRESS} AS billing_address,
           c.is_deleted AS archived, c.created_at,
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
    WHERE c.is_deleted = ?`;

async function findClient(id, archived = false) {
    const [client] = await db.query(`${CLIENT_SELECT} AND c.client_id = ?`, [archived, id]);
    if (!client) throw new HttpError(404, `Client ${id} not found`);
    return client;
}

// Emails are unique even across archived clients, so explain that case instead of a bare 409.
async function assertEmailFree(address, exceptId = 0) {
    if (!address) return;
    const [row] = await db.query('SELECT client_id, is_deleted FROM clients WHERE email = ? AND client_id <> ?', [address, exceptId]);
    if (row) {
        throw new HttpError(409, row.is_deleted
            ? `Email ${address} belongs to an archived client (#${row.client_id}); restore them instead`
            : `Email ${address} is already used by client #${row.client_id}`);
    }
}

router.get('/', async (req, res) => {
    const { q, archived, limit, offset } = validate(req.query, { q: str({ max: 100 }), ...archivedQuery, ...paging });
    const params = [archived];
    let where = '';
    if (q) {
        // Numbers match with or without the code, and with a local leading 0 ('0917...').
        where = ` AND (${CLIENT_NAME} LIKE ? OR c.email LIKE ? OR CONCAT(COALESCE(c.phone_country_code, ''), c.phone_number) LIKE ?)`;
        const pattern = likePattern(q);
        params.push(pattern, pattern, likePattern(q.replace(/[\s().-]/g, '').replace(/^0/, '')));
    }
    const rows = await db.query(`${CLIENT_SELECT}${where} ORDER BY c.last_name, c.first_name LIMIT ? OFFSET ?`, [...params, limit, offset]);
    res.json(rows);
});

router.get('/:id', async (req, res) => {
    res.json(await findClient(parseId(req.params.id)));
});

// The phone rule gives back its two columns; put them in the row in its place.
const toRow = ({ phone: phoneParts, ...rest }) => ({ ...rest, ...phoneParts });

router.post('/', async (req, res) => {
    const input = toRow(validate(req.body, clientSchema));
    await assertEmailFree(input.email);
    const fields = Object.keys(input);
    const result = await db.query(
        `INSERT INTO clients (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
        fields.map((f) => input[f])
    );
    res.status(201).json(await findClient(result.insertId));
});

router.patch('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const input = toRow(validate(req.body, clientSchema, { partial: true }));
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

// Brings an archived client back, with their history intact.
router.patch('/:id/restore', async (req, res) => {
    const id = parseId(req.params.id);
    const result = await db.query('UPDATE clients SET is_deleted = 0 WHERE client_id = ? AND is_deleted = 1', [id]);
    if (!result.affectedRows) throw new HttpError(404, `Archived client ${id} not found`);
    res.json(await findClient(id));
});

// Archive all. Nothing is deleted: archived clients keep their events and payments and can
// be restored. Clients with an active event are kept and reported back.
router.delete('/', async (req, res) => {
    requireConfirm(req);
    const result = await db.transaction(async (conn) => {
        const skipped = await conn.query(
            `SELECT DISTINCT c.client_id, ${CLIENT_NAME} AS full_name FROM clients c JOIN events e ON e.client_id = c.client_id
             WHERE c.is_deleted = 0 AND ${ACTIVE_EVENT} FOR UPDATE`
        );
        const archived = await conn.query(
            `UPDATE clients c SET c.is_deleted = 1 WHERE c.is_deleted = 0
             AND NOT EXISTS (SELECT 1 FROM events e WHERE e.client_id = c.client_id AND ${ACTIVE_EVENT})`
        );
        return { archived: archived.affectedRows, skipped };
    });
    res.json({
        message: `Archived ${result.archived} client(s)` + (result.skipped.length ? `; kept ${result.skipped.length} with active events` : ''),
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
    res.json({ message: `Client ${id} archived` });
});

module.exports = router;
