const express = require('express');
const db = require('../lib/db');
const { HttpError } = require('../lib/errors');
const { validate, parseId, str, int, money, list } = require('../lib/validate');

const router = express.Router();

async function loadPackages(conn, id) {
    const packages = await conn.query(
        `SELECT package_id, name, description, base_price FROM packages${id ? ' WHERE package_id = ?' : ''} ORDER BY name`,
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
        description: str({ max: 2000 }),
        base_price: money({ default: 0 }),
        items: list({ item_id: int({ required: true, min: 1 }), qty: int({ required: true, min: 1, max: 100000 }) }),
    });
    const items = input.items ?? [];
    const ids = items.map((i) => i.item_id);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Each item may only appear once in a package');

    const id = await db.transaction(async (conn) => {
        if (ids.length) {
            const found = await conn.query('SELECT item_id FROM rental_items WHERE item_id IN (?) AND is_deleted = 0', [ids]);
            const missing = ids.filter((i) => !found.some((f) => f.item_id === i));
            if (missing.length) throw new HttpError(400, `Unknown inventory item(s): ${missing.join(', ')}`);
        }
        const result = await conn.query(
            'INSERT INTO packages (name, description, base_price) VALUES (?, ?, ?)',
            [input.name, input.description ?? null, input.base_price]
        );
        for (const item of items) {
            await conn.query('INSERT INTO package_items (package_id, item_id, qty) VALUES (?, ?, ?)', [result.insertId, item.item_id, item.qty]);
        }
        return result.insertId;
    });
    const [pkg] = await loadPackages(db, id);
    res.status(201).json(pkg);
});

module.exports = router;
