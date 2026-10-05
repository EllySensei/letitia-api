const express = require('express');
const db = require('../lib/db');
const { HttpError } = require('../lib/errors');
const { validate, parseId, requireConfirm, str, int, money, list } = require('../lib/validate');

const router = express.Router();

// Pictures arrive as data URLs (the frontend shrinks them to ~700px JPEGs first).
const IMAGE_DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_IMAGE_CHARS = 1500000;

async function loadPackages(conn, id) {
    const packages = await conn.query(
        `SELECT package_id, name, type, description, base_price, image FROM packages
         WHERE is_deleted = 0${id ? ' AND package_id = ?' : ''} ORDER BY name`,
        id ? [id] : []
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
    res.json(await loadPackages(db));
});

router.get('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const [pkg] = await loadPackages(db, id);
    if (!pkg) throw new HttpError(404, `Package ${id} not found`);
    res.json(pkg);
});

router.post('/', async (req, res) => {
    const input = validate(req.body, {
        name: str({ required: true, max: 120 }),
        type: str({ max: 50 }),
        description: str({ max: 2000 }),
        base_price: money({ default: 0 }),
        image: str({ max: MAX_IMAGE_CHARS }),
        items: list({ item_id: int({ required: true, min: 1 }), qty: int({ required: true, min: 1, max: 100000 }) }),
    });
    if (input.image && !IMAGE_DATA_URL.test(input.image)) {
        throw new HttpError(400, 'image must be a JPEG, PNG or WebP data URL');
    }
    const items = input.items ?? [];
    const ids = items.map((i) => i.item_id);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Each item may only appear once in a package');

    const id = await db.transaction(async (conn) => {
        // The collation is case-insensitive, so "Gold Package" and "gold package" clash.
        const [dupe] = await conn.query('SELECT package_id FROM packages WHERE name = ? AND is_deleted = 0', [input.name]);
        if (dupe) throw new HttpError(409, `A package named "${input.name}" already exists`);
        if (ids.length) {
            const found = await conn.query('SELECT item_id FROM rental_items WHERE item_id IN (?) AND is_deleted = 0', [ids]);
            const missing = ids.filter((i) => !found.some((f) => f.item_id === i));
            if (missing.length) throw new HttpError(400, `Unknown inventory item(s): ${missing.join(', ')}`);
        }
        const result = await conn.query(
            'INSERT INTO packages (name, type, description, base_price, image) VALUES (?, ?, ?, ?, ?)',
            [input.name, input.type ?? null, input.description ?? null, input.base_price, input.image ?? null]
        );
        for (const item of items) {
            await conn.query('INSERT INTO package_items (package_id, item_id, qty) VALUES (?, ?, ?)', [result.insertId, item.item_id, item.qty]);
        }
        return result.insertId;
    });
    const [pkg] = await loadPackages(db, id);
    res.status(201).json(pkg);
});

// Soft deletes: events already booked with a package keep showing its name,
// but it can't be picked for new bookings.
router.delete('/', async (req, res) => {
    requireConfirm(req);
    const result = await db.query('UPDATE packages SET is_deleted = 1 WHERE is_deleted = 0');
    res.json({ message: `Deleted ${result.affectedRows} package(s)`, deleted: result.affectedRows });
});

router.delete('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const result = await db.query('UPDATE packages SET is_deleted = 1 WHERE package_id = ? AND is_deleted = 0', [id]);
    if (!result.affectedRows) throw new HttpError(404, `Package ${id} not found`);
    res.json({ message: `Package ${id} deleted` });
});

module.exports = router;
