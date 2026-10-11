// Consumables are used up by events (event_consumables) rather than rented and returned.
const express = require('express');
const db = require('../lib/db');
const { HttpError } = require('../lib/errors');
const { purge } = require('../lib/purge');
const { validate, parseId, paging, likePattern, archivedQuery, str, code, int, oneOf } = require('../lib/validate');
const { stockStatus, assertCodeFree, assignCode } = require('../lib/sql');

const router = express.Router();

const consumableSchema = {
    // Left blank, a code like CNS-0007 is assigned.
    item_code: code(),
    name: str({ required: true, max: 120 }),
    unit: str({ required: true, max: 30 }),
    current_level: int({ min: 0, default: 0 }),
    reorder_level: int({ min: 0, default: 0 }),
};

const CONSUMABLE_SELECT = `
    SELECT c.consumable_id, c.item_code, c.name, c.unit, c.current_level, c.reorder_level, c.last_restocked_at,
           c.is_deleted AS archived, ${stockStatus('c.current_level', 'c.reorder_level')} AS status
    FROM consumables c WHERE c.is_deleted = ?`;

async function findConsumable(id) {
    const [row] = await db.query(`${CONSUMABLE_SELECT} AND c.consumable_id = ?`, [false, id]);
    if (!row) throw new HttpError(404, `Consumable ${id} not found`);
    return row;
}

router.get('/', async (req, res) => {
    const { q, status, archived, limit, offset } = validate(req.query, {
        q: str({ max: 100 }),
        status: oneOf(['In Stock', 'Low Stock', 'Out of Stock']),
        ...archivedQuery,
        ...paging,
    });
    let sql = CONSUMABLE_SELECT;
    const params = [archived];
    if (q) {
        sql += ' AND (c.name LIKE ? OR c.item_code LIKE ?)';
        params.push(likePattern(q), likePattern(q));
    }
    if (status) {
        sql = `SELECT * FROM (${sql}) x WHERE x.status = ?`;
        params.push(status);
    }
    res.json(await db.query(`${sql} ORDER BY name LIMIT ? OFFSET ?`, [...params, limit, offset]));
});

router.get('/:id', async (req, res) => {
    res.json(await findConsumable(parseId(req.params.id)));
});

router.post('/', async (req, res) => {
    const input = validate(req.body, consumableSchema);
    const id = await db.transaction(async (conn) => {
        if (input.item_code) await assertCodeFree(conn, input.item_code);
        const result = await conn.query(
            'INSERT INTO consumables (item_code, name, unit, current_level, reorder_level) VALUES (?, ?, ?, ?, ?)',
            [input.item_code ?? null, input.name, input.unit, input.current_level, input.reorder_level]
        );
        if (!input.item_code) await assignCode(conn, 'consumables', 'consumable_id', result.insertId, 'CNS');
        return result.insertId;
    });
    res.status(201).json(await findConsumable(id));
});

router.patch('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const input = validate(req.body, consumableSchema, { partial: true });
    if (!Object.keys(input).length) throw new HttpError(400, 'No fields to update');
    await findConsumable(id);
    if (input.item_code) await assertCodeFree(db, input.item_code, { table: 'consumables', id });
    // A code can be changed but not removed.
    if (input.item_code === null) delete input.item_code;
    const fields = Object.keys(input);
    if (fields.length) await db.query(
        `UPDATE consumables SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE consumable_id = ?`,
        [...fields.map((f) => input[f]), id]
    );
    res.json(await findConsumable(id));
});

// Adds a delivery to the current level.
router.patch('/:id/restock', async (req, res) => {
    const id = parseId(req.params.id);
    const { qty } = validate(req.body, { qty: int({ required: true, min: 1, max: 1000000 }) });
    const result = await db.query(
        'UPDATE consumables SET current_level = current_level + ?, last_restocked_at = NOW() WHERE consumable_id = ? AND is_deleted = 0',
        [qty, id]
    );
    if (!result.affectedRows) throw new HttpError(404, `Consumable ${id} not found`);
    res.json(await findConsumable(id));
});

// Brings an archived consumable back into the inventory.
router.patch('/:id/restore', async (req, res) => {
    const id = parseId(req.params.id);
    const result = await db.query('UPDATE consumables SET is_deleted = 0 WHERE consumable_id = ? AND is_deleted = 1', [id]);
    if (!result.affectedRows) throw new HttpError(404, `Archived consumable ${id} not found`);
    res.json(await findConsumable(id));
});

// Archives (never deletes) so past events keep their consumable records.
router.delete('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const result = await db.query('UPDATE consumables SET is_deleted = 1 WHERE consumable_id = ? AND is_deleted = 0', [id]);
    if (!result.affectedRows) throw new HttpError(404, `Consumable ${id} not found`);
    res.json({ message: `Consumable ${id} archived` });
});

// Deletes an archived consumable for good, if no event used it.
router.delete('/:id/permanent', async (req, res) => {
    res.json(await purge({
        table: 'consumables', idColumn: 'consumable_id', id: parseId(req.params.id), label: 'Consumable',
        uses: [['SELECT COUNT(DISTINCT event_id) AS n FROM event_consumables WHERE consumable_id = ?', 'event(s)']],
    }));
});

module.exports = router;
