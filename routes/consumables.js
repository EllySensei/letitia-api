// Consumables are used up by events (event_consumables) rather than rented and returned.
const express = require('express');
const db = require('../lib/db');
const { HttpError } = require('../lib/errors');
const { validate, parseId, paging, likePattern, str, int, oneOf } = require('../lib/validate');
const { stockStatus } = require('../lib/sql');

const router = express.Router();

const consumableSchema = {
    name: str({ required: true, max: 120 }),
    unit: str({ required: true, max: 30 }),
    current_level: int({ min: 0, default: 0 }),
    reorder_level: int({ min: 0, default: 0 }),
};

const CONSUMABLE_SELECT = `
    SELECT c.consumable_id, c.name, c.unit, c.current_level, c.reorder_level, c.last_restocked_at,
           ${stockStatus('c.current_level', 'c.reorder_level')} AS status
    FROM consumables c WHERE c.is_deleted = 0`;

async function findConsumable(id) {
    const [row] = await db.query(`${CONSUMABLE_SELECT} AND c.consumable_id = ?`, [id]);
    if (!row) throw new HttpError(404, `Consumable ${id} not found`);
    return row;
}

router.get('/', async (req, res) => {
    const { q, status, limit, offset } = validate(req.query, {
        q: str({ max: 100 }),
        status: oneOf(['In Stock', 'Low Stock', 'Out of Stock']),
        ...paging,
    });
    let sql = CONSUMABLE_SELECT;
    const params = [];
    if (q) {
        sql += ' AND c.name LIKE ?';
        params.push(likePattern(q));
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
    const result = await db.query(
        'INSERT INTO consumables (name, unit, current_level, reorder_level) VALUES (?, ?, ?, ?)',
        [input.name, input.unit, input.current_level, input.reorder_level]
    );
    res.status(201).json(await findConsumable(result.insertId));
});

router.patch('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const input = validate(req.body, consumableSchema, { partial: true });
    if (!Object.keys(input).length) throw new HttpError(400, 'No fields to update');
    await findConsumable(id);
    const fields = Object.keys(input);
    await db.query(
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

router.delete('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const result = await db.query('UPDATE consumables SET is_deleted = 1 WHERE consumable_id = ? AND is_deleted = 0', [id]);
    if (!result.affectedRows) throw new HttpError(404, `Consumable ${id} not found`);
    res.json({ message: `Consumable ${id} deleted` });
});

module.exports = router;
