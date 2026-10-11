const express = require('express');
const db = require('../lib/db');
const { HttpError } = require('../lib/errors');
const { addStarterPackages, describeCounts } = require('../lib/sampleData');
const { purge } = require('../lib/purge');
const { validate, parseId, requireConfirm, archivedQuery, str, int, money, list, image } = require('../lib/validate');

const router = express.Router();

async function loadPackages(conn, id, archived = false) {
    const packages = await conn.query(
        `SELECT package_id, name, type, description, base_price, image, is_deleted AS archived FROM packages
         WHERE is_deleted = ?${id ? ' AND package_id = ?' : ''} ORDER BY name`,
        id ? [archived, id] : [archived]
    );
    if (!packages.length) return packages;
    const items = await conn.query(
        `SELECT pi.package_id, pi.item_id, ri.name, ri.category, pi.qty
         FROM package_items pi JOIN rental_items ri ON ri.item_id = pi.item_id
         WHERE pi.package_id IN (?) ORDER BY ri.name`,
        [packages.map((p) => p.package_id)]
    );
    for (const p of packages) {
        p.items = items.filter((i) => i.package_id === p.package_id).map(({ package_id, ...rest }) => rest);
    }
    return packages;
}

router.get('/', async (req, res) => {
    const { archived } = validate(req.query, archivedQuery);
    res.json(await loadPackages(db, null, archived));
});

router.get('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const [pkg] = await loadPackages(db, id);
    if (!pkg) throw new HttpError(404, `Package ${id} not found`);
    res.json(pkg);
});

const packageSchema = {
    name: str({ required: true, max: 120 }),
    type: str({ max: 50 }),
    description: str({ max: 2000 }),
    base_price: money({ default: 0 }),
    image: image(),
    items: list({ item_id: int({ required: true, min: 1 }), qty: int({ required: true, min: 1, max: 100000 }) }),
};

function assertUniqueItems(items) {
    const ids = items.map((i) => i.item_id);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Each item may only appear once in a package');
}

// The collation is case-insensitive, so "Gold Package" and "gold package" clash.
async function assertNameFree(conn, name, exceptId = 0) {
    const [dupe] = await conn.query('SELECT package_id FROM packages WHERE name = ? AND is_deleted = 0 AND package_id <> ?', [name, exceptId]);
    if (dupe) throw new HttpError(409, `A package named "${name}" already exists`);
}

async function insertItems(conn, packageId, items) {
    const ids = items.map((i) => i.item_id);
    if (!ids.length) return;
    const found = await conn.query('SELECT item_id FROM rental_items WHERE item_id IN (?) AND is_deleted = 0', [ids]);
    const missing = ids.filter((i) => !found.some((f) => f.item_id === i));
    if (missing.length) throw new HttpError(400, `Unknown inventory item(s): ${missing.join(', ')}`);
    for (const item of items) {
        await conn.query('INSERT INTO package_items (package_id, item_id, qty) VALUES (?, ?, ?)', [packageId, item.item_id, item.qty]);
    }
}

router.post('/', async (req, res) => {
    const input = validate(req.body, packageSchema);
    const items = input.items ?? [];
    assertUniqueItems(items);

    const id = await db.transaction(async (conn) => {
        await assertNameFree(conn, input.name);
        const result = await conn.query(
            'INSERT INTO packages (name, type, description, base_price, image) VALUES (?, ?, ?, ?, ?)',
            [input.name, input.type ?? null, input.description ?? null, input.base_price, input.image ?? null]
        );
        await insertItems(conn, result.insertId, items);
        return result.insertId;
    });
    const [pkg] = await loadPackages(db, id);
    res.status(201).json(pkg);
});

// Sent fields replace the stored ones: image null removes the picture, and items (if sent)
// replace the whole contents. Events already booked keep the items they reserved.
// "Add starter packages": the standard packages with their items (missing items are added too).
router.post('/starter', async (req, res) => {
    const result = await db.transaction(addStarterPackages);
    res.status(201).json({ message: describeCounts([['packages', result.packages], ['rental items', result.items]]), ...result });
});

router.patch('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const { items, ...input } = validate(req.body, packageSchema, { partial: true });
    if (!Object.keys(input).length && !items) throw new HttpError(400, 'No fields to update');
    if (items) assertUniqueItems(items);

    await db.transaction(async (conn) => {
        const [pkg] = await conn.query('SELECT package_id FROM packages WHERE package_id = ? AND is_deleted = 0 FOR UPDATE', [id]);
        if (!pkg) throw new HttpError(404, `Package ${id} not found`);
        if (input.name) await assertNameFree(conn, input.name, id);
        const fields = Object.keys(input);
        if (fields.length) {
            await conn.query(
                `UPDATE packages SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE package_id = ?`,
                [...fields.map((f) => input[f]), id]
            );
        }
        if (items) {
            await conn.query('DELETE FROM package_items WHERE package_id = ?', [id]);
            await insertItems(conn, id, items);
        }
    });
    const [pkg] = await loadPackages(db, id);
    res.json(pkg);
});

// Brings an archived package back so it can be booked again.
router.patch('/:id/restore', async (req, res) => {
    const id = parseId(req.params.id);
    const result = await db.query('UPDATE packages SET is_deleted = 0 WHERE package_id = ? AND is_deleted = 1', [id]);
    if (!result.affectedRows) throw new HttpError(404, `Archived package ${id} not found`);
    const [pkg] = await loadPackages(db, id);
    res.json(pkg);
});

// Archives (never deletes): events already booked with a package keep showing its name,
// but it can't be picked for new bookings until it's restored.
router.delete('/', async (req, res) => {
    requireConfirm(req);
    const result = await db.query('UPDATE packages SET is_deleted = 1 WHERE is_deleted = 0');
    res.json({ message: `Archived ${result.affectedRows} package(s)`, archived: result.affectedRows });
});

router.delete('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const result = await db.query('UPDATE packages SET is_deleted = 1 WHERE package_id = ? AND is_deleted = 0', [id]);
    if (!result.affectedRows) throw new HttpError(404, `Package ${id} not found`);
    res.json({ message: `Package ${id} archived` });
});

// Deletes an archived package for good, if no event was ever booked with it. Its item
// list (package_items) goes with it.
router.delete('/:id/permanent', async (req, res) => {
    res.json(await purge({
        table: 'packages', idColumn: 'package_id', id: parseId(req.params.id), label: 'Package',
        uses: [['SELECT COUNT(*) AS n FROM events WHERE package_id = ?', 'event(s)']],
    }));
});

module.exports = router;
