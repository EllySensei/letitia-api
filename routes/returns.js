// Returns / Asset Watchlist. A "return" is an event_items line: :id is its event_item_id.
// Each check-in is also written to return_logs.
const express = require('express');
const db = require('../lib/db');
const { HttpError } = require('../lib/errors');
const { validate, parseId, paging, likePattern, str, int, money, oneOf } = require('../lib/validate');
const { LINE_DUE, RETURN_STATUS, CLIENT_NAME } = require('../lib/sql');

const router = express.Router();

const STATUSES = ['Reserved', 'Out', 'Overdue', 'Returned', 'Damaged', 'Missing', 'Cancelled'];

const RETURN_SELECT = `
    SELECT ei.event_item_id, ei.item_id, ri.item_code, ri.name AS item_name, ri.category, ei.qty,
           e.event_id, e.event_date, c.client_id, ${CLIENT_NAME} AS client_name,
           ${LINE_DUE} AS expected_return, ${RETURN_STATUS} AS status, ei.pull_status,
           rl.returned_at, rl.condition_on_return, rl.damage_fee
    FROM event_items ei
    JOIN events e ON e.event_id = ei.event_id
    JOIN clients c ON c.client_id = e.client_id
    JOIN rental_items ri ON ri.item_id = ei.item_id
    LEFT JOIN return_logs rl ON rl.return_id = (
        SELECT MAX(r2.return_id) FROM return_logs r2 WHERE r2.event_item_id = ei.event_item_id
    )`;

async function findReturn(id) {
    const [row] = await db.query(`${RETURN_SELECT} WHERE ei.event_item_id = ?`, [id]);
    if (!row) throw new HttpError(404, `Return ${id} not found`);
    return row;
}

// Locks the line and returns its current computed status.
async function lockLine(conn, id) {
    const [line] = await conn.query(
        `SELECT ei.event_item_id, ei.item_id, ei.qty, ${RETURN_STATUS} AS status
         FROM event_items ei JOIN events e ON e.event_id = ei.event_id
         WHERE ei.event_item_id = ? FOR UPDATE`,
        [id]
    );
    if (!line) throw new HttpError(404, `Return ${id} not found`);
    return line;
}

// By default the watchlist hides lines that haven't gone out yet or were cancelled.
router.get('/', async (req, res) => {
    const { status, q, event_id, limit, offset } = validate(req.query, {
        status: oneOf([...STATUSES, 'all']),
        q: str({ max: 100 }),
        event_id: int({ min: 1 }),
        ...paging,
    });
    const where = [];
    const params = [];
    if (q) {
        where.push(`(ri.name LIKE ? OR ri.item_code LIKE ? OR ${CLIENT_NAME} LIKE ?)`);
        params.push(likePattern(q), likePattern(q), likePattern(q));
    }
    if (event_id) { where.push('e.event_id = ?'); params.push(event_id); }

    let sql = `SELECT * FROM (${RETURN_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}) x`;
    if (status && status !== 'all') {
        sql += ' WHERE x.status = ?';
        params.push(status);
    } else if (!status) {
        sql += " WHERE x.status NOT IN ('Reserved', 'Cancelled')";
    }
    res.json(await db.query(`${sql} ORDER BY expected_return, item_name LIMIT ? OFFSET ?`, [...params, limit, offset]));
});

router.get('/:id', async (req, res) => {
    res.json(await findReturn(parseId(req.params.id)));
});

// Mark returned. The units count as on hand again because the line is no longer open.
router.patch('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const { condition_on_return } = validate(req.body, { condition_on_return: str({ max: 100 }) });

    await db.transaction(async (conn) => {
        const line = await lockLine(conn, id);
        if (!['Out', 'Overdue'].includes(line.status)) {
            throw new HttpError(409, `Cannot mark as returned: item is ${line.status}`);
        }
        await conn.query("UPDATE event_items SET return_status = 'Returned', is_reserved = FALSE WHERE event_item_id = ?", [id]);
        await conn.query('INSERT INTO return_logs (event_item_id, condition_on_return) VALUES (?, ?)', [id, condition_on_return ?? 'Good']);
    });
    res.json(await findReturn(id));
});

// Damaged or missing. Affected units go out of service until restocked, the rest of the
// line counts as back on hand, and any fee is recorded as a damage_fee payment.
router.patch('/:id/damage', async (req, res) => {
    const id = parseId(req.params.id);
    const input = validate(req.body, {
        status: oneOf(['Damaged', 'Missing'], { required: true }),
        qty_affected: int({ min: 1 }),
        damage_fee: money({ default: 0 }),
        condition_on_return: str({ max: 100 }),
        method: str({ max: 50 }),
        reference_no: str({ max: 100 }),
    });

    await db.transaction(async (conn) => {
        const line = await lockLine(conn, id);
        // Damage can also be found after the item was checked in as Returned.
        if (!['Out', 'Overdue', 'Returned'].includes(line.status)) {
            throw new HttpError(409, `Cannot report damage: item is ${line.status}`);
        }
        const qty = input.qty_affected ?? line.qty;
        if (qty > line.qty) throw new HttpError(400, `qty_affected cannot exceed the ${line.qty} unit(s) on this line`);

        await conn.query('UPDATE event_items SET return_status = ?, is_reserved = FALSE WHERE event_item_id = ?', [input.status, id]);
        await conn.query('UPDATE rental_items SET qty_out_of_service = LEAST(qty_total, qty_out_of_service + ?) WHERE item_id = ?', [qty, line.item_id]);
        await conn.query(
            'INSERT INTO return_logs (event_item_id, condition_on_return, damage_fee) VALUES (?, ?, ?)',
            [id, input.condition_on_return ?? `${input.status} (${qty} unit${qty === 1 ? '' : 's'})`, input.damage_fee]
        );
        if (input.damage_fee > 0) {
            await conn.query(
                `INSERT INTO payments (event_id, type, amount, method, reference_no)
                 SELECT event_id, 'damage_fee', ?, ?, ? FROM event_items WHERE event_item_id = ?`,
                [input.damage_fee, input.method ?? null, input.reference_no ?? null, id]
            );
        }
    });
    res.json(await findReturn(id));
});

module.exports = router;
