// Storefront endpoints, open without a login: browse the catalog and look an order up again.
// Placing an order needs a customer account (routes/account.js).
const express = require('express');
const db = require('../lib/db');
const { HttpError } = require('../lib/errors');
const { validate, parseId, email } = require('../lib/validate');
const { ON_HAND } = require('../lib/sql');
const { orderSummary } = require('../lib/orders');
const { rateLimit } = require('../lib/rateLimit');
const { COUNTRIES } = require('../lib/phone');

const router = express.Router();

// Country calling codes for phone dropdowns, default country first, with how many digits
// may follow each code (e.g. PH: +63 and 6 to 10 digits).
router.get('/phone-countries', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600').json(COUNTRIES);
});

// Packages and rentable items. Items priced at zero are treated as package-only stock.
router.get('/catalog', async (req, res) => {
    const packages = await db.query(
        'SELECT package_id, name, type, description, base_price, image FROM packages WHERE is_deleted = 0 ORDER BY base_price, name'
    );
    const contents = packages.length ? await db.query(
        `SELECT pi.package_id, ri.name, pi.qty FROM package_items pi JOIN rental_items ri ON ri.item_id = pi.item_id
         WHERE pi.package_id IN (?) ORDER BY ri.name`,
        [packages.map((p) => p.package_id)]
    ) : [];
    for (const p of packages) {
        p.items = contents.filter((c) => c.package_id === p.package_id).map(({ name, qty }) => ({ name, qty }));
    }
    const items = await db.query(
        `SELECT ri.item_id, ri.name, ri.category, ri.rental_price, ri.description, ri.image, ${ON_HAND} AS qty_available
         FROM rental_items ri WHERE ri.is_deleted = 0 AND ri.rental_price > 0 ORDER BY ri.category, ri.name`
    );
    res.json({ packages, items });
});

// Look an order up by its reference number plus the email it was placed with.
router.get('/orders/:id', rateLimit(30, 10 * 60 * 1000, 'Too many lookups, please try again in a few minutes'), async (req, res) => {
    const id = parseId(req.params.id, 'reference number');
    const { email: address } = validate(req.query, { email: email({ required: true }) });
    const [match] = await db.query(
        'SELECT e.event_id FROM events e JOIN clients c ON c.client_id = e.client_id WHERE e.event_id = ? AND c.email = ?',
        [id, address]
    );
    if (!match) throw new HttpError(404, 'No booking matches that reference number and email');
    res.json(await orderSummary(id));
});

module.exports = router;
