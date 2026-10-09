// "Inventory" in the outline = the rental_items table. Consumables live in /consumables.
const express = require('express');
const db = require('../lib/db');
const { HttpError } = require('../lib/errors');
const {
    validate, parseId, paging, likePattern, requireConfirm, archivedQuery, str, code, int, money, oneOf, image,
} = require('../lib/validate');
const { ON_HAND, LINE_OPEN, LINE_OUT, stockStatus, assertCodeFree, assignCode } = require('../lib/sql');

const router = express.Router();

// Rental items have no reorder level (they come back after every event), so no Low Stock.
const STATUSES = ['In Stock', 'Out of Stock'];

const itemSchema = {
    // Left blank, a code like RNT-0007 is assigned.
    item_code: code(),
    name: str({ required: true, max: 150 }),
    category: str({ max: 100 }),
    qty_total: int({ required: true, min: 0 }),
    rental_price: money({ default: 0 }),
    item_condition: str({ max: 50 }),
    description: str({ max: 2000 }),
    image: image(),
};

// qty_available and status are derived (see lib/sql.js), never stored. The first "?" is
// whether to list archived items.
const ITEM_SELECT = `
    SELECT x.*, ${stockStatus('x.qty_available', 0)} AS status FROM (
        SELECT ri.item_id, ri.item_code, ri.name, ri.category, ri.qty_total, ri.rental_price, ri.item_condition,
               ri.qty_out_of_service, ri.description, ri.image, ri.is_deleted AS archived, ${ON_HAND} AS qty_available
        FROM rental_items ri WHERE ri.is_deleted = ? {filter}
    ) x`;

// Open lines on events that haven't finished: deleting their item would strand a booking.
const ACTIVE_LINES = `
    SELECT ei.event_id, ei.qty FROM event_items ei JOIN events e ON e.event_id = ei.event_id
    WHERE ei.item_id = ? AND ${LINE_OPEN} AND (e.event_date >= CURDATE() OR ${LINE_OUT})`;

async function findItem(id) {
    const [item] = await db.query(ITEM_SELECT.replace('{filter}', 'AND ri.item_id = ?'), [false, id]);
    if (!item) throw new HttpError(404, `Inventory item ${id} not found`);
    return item;
}

router.get('/', async (req, res) => {
    const { q, category, status, archived, limit, offset } = validate(req.query, {
        q: str({ max: 100 }),
        category: str({ max: 100 }),
        status: oneOf(STATUSES),
        ...archivedQuery,
        ...paging,
    });
    let filter = '';
    const params = [archived];
    if (q) {
        filter += ' AND (ri.name LIKE ? OR ri.category LIKE ? OR ri.item_code LIKE ?)';
        params.push(likePattern(q), likePattern(q), likePattern(q));
    }
    if (category) {
        filter += ' AND ri.category = ?';
        params.push(category);
    }
    let sql = ITEM_SELECT.replace('{filter}', filter);
    if (status) {
        sql = `SELECT * FROM (${sql}) y WHERE y.status = ?`;
        params.push(status);
    }
    res.json(await db.query(`${sql} ORDER BY name LIMIT ? OFFSET ?`, [...params, limit, offset]));
});

// Must be registered before /:id. Returns every damaged or missing unit to service.
router.patch('/restock', async (req, res) => {
    requireConfirm(req);
    const result = await db.query('UPDATE rental_items SET qty_out_of_service = 0 WHERE is_deleted = 0 AND qty_out_of_service > 0');
    res.json({ message: `Restocked ${result.affectedRows} item(s)`, restocked: result.affectedRows });
});

router.get('/:id', async (req, res) => {
    res.json(await findItem(parseId(req.params.id)));
});

router.post('/', async (req, res) => {
    const input = validate(req.body, itemSchema);
    const id = await db.transaction(async (conn) => {
        if (input.item_code) await assertCodeFree(conn, input.item_code);
        const result = await conn.query(
            `INSERT INTO rental_items (item_code, name, category, qty_total, rental_price, item_condition, description, image)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [input.item_code ?? null, input.name, input.category ?? null, input.qty_total, input.rental_price,
                input.item_condition ?? null, input.description ?? null, input.image ?? null]
        );
        if (!input.item_code) await assignCode(conn, 'rental_items', 'item_id', result.insertId, 'RNT');
        return result.insertId;
    });
    res.status(201).json(await findItem(id));
});

router.patch('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const input = validate(req.body, itemSchema, { partial: true });
    if (!Object.keys(input).length) throw new HttpError(400, 'No fields to update');

    await db.transaction(async (conn) => {
        const [item] = await conn.query('SELECT item_id FROM rental_items WHERE item_id = ? AND is_deleted = 0 FOR UPDATE', [id]);
        if (!item) throw new HttpError(404, `Inventory item ${id} not found`);
        if (input.item_code) await assertCodeFree(conn, input.item_code, { table: 'rental_items', id });
        // A code can be changed but not removed.
        if (input.item_code === null) delete input.item_code;

        if (input.qty_total !== undefined) {
            // Can't own fewer units than are currently out or out of service.
            const [{ in_use }] = await conn.query(
                `SELECT ri.qty_total - ${ON_HAND} AS in_use FROM rental_items ri WHERE ri.item_id = ?`, [id]
            );
            if (input.qty_total < in_use) {
                throw new HttpError(409, `qty_total cannot be lower than the ${in_use} unit(s) currently out or out of service`);
            }
        }

        const fields = Object.keys(input);
        if (!fields.length) return;
        await conn.query(
            `UPDATE rental_items SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE item_id = ?`,
            [...fields.map((f) => input[f]), id]
        );
    });
    res.json(await findItem(id));
});

// Brings an archived item back into the inventory.
router.patch('/:id/restore', async (req, res) => {
    const id = parseId(req.params.id);
    const result = await db.query('UPDATE rental_items SET is_deleted = 0 WHERE item_id = ? AND is_deleted = 1', [id]);
    if (!result.affectedRows) throw new HttpError(404, `Archived inventory item ${id} not found`);
    res.json(await findItem(id));
});

// Archive all. Nothing is deleted: archived items keep their booking history and can be
// restored. Items still booked on unfinished events are kept and reported back.
router.delete('/', async (req, res) => {
    requireConfirm(req);
    const result = await db.transaction(async (conn) => {
        const skipped = await conn.query(
            `SELECT DISTINCT ri.item_id, ri.name FROM rental_items ri
             JOIN event_items ei ON ei.item_id = ri.item_id JOIN events e ON e.event_id = ei.event_id
             WHERE ri.is_deleted = 0 AND ${LINE_OPEN} AND (e.event_date >= CURDATE() OR ${LINE_OUT}) FOR UPDATE`
        );
        const ids = skipped.map((s) => s.item_id);
        const archived = await conn.query(
            `UPDATE rental_items SET is_deleted = 1 WHERE is_deleted = 0${ids.length ? ' AND item_id NOT IN (?)' : ''}`,
            ids.length ? [ids] : []
        );
        return { archived: archived.affectedRows, skipped };
    });
    res.json({
        message: `Archived ${result.archived} item(s)` + (result.skipped.length ? `; kept ${result.skipped.length} still booked` : ''),
        ...result,
    });
});

router.delete('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    await db.transaction(async (conn) => {
        const [item] = await conn.query('SELECT item_id FROM rental_items WHERE item_id = ? AND is_deleted = 0 FOR UPDATE', [id]);
        if (!item) throw new HttpError(404, `Inventory item ${id} not found`);
        const lines = await conn.query(ACTIVE_LINES, [id]);
        if (lines.length) throw new HttpError(409, 'Item is booked on unfinished events', lines);
        await conn.query('UPDATE rental_items SET is_deleted = 1 WHERE item_id = ?', [id]);
    });
    res.json({ message: `Inventory item ${id} archived` });
});

module.exports = router;
