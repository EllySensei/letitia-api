// The admin Accounts tab: every login (admin, staff, customer). Admins create staff accounts,
// change roles, reset passwords and delete accounts. A role change applies on the user's next
// request, since every request reads the role from the database (lib/auth.js).
const express = require('express');
const db = require('../lib/db');
const { HttpError } = require('../lib/errors');
const { validate, parseId, likePattern, str, oneOf } = require('../lib/validate');
const { requireAdmin, USER_SELECT, hashPassword } = require('../lib/auth');

const router = express.Router();
router.use(requireAdmin);

const ROLES = ['admin', 'staff', 'customer'];
const MIN_PASSWORD = 8;

const LIST_SELECT = `
    SELECT x.*, c.is_deleted AS client_archived,
           (SELECT COUNT(*) FROM events e WHERE e.client_id = x.client_id) AS bookings
    FROM (${USER_SELECT.replace('u.client_id', 'u.client_id, u.created_at')}) x
    LEFT JOIN clients c ON c.client_id = x.client_id`;

async function findUser(conn, id) {
    const [user] = await conn.query(`${USER_SELECT} WHERE u.user_id = ? FOR UPDATE`, [id]);
    if (!user) throw new HttpError(404, `Account ${id} not found`);
    return user;
}

function checkPassword(password) {
    if (password.length < MIN_PASSWORD) {
        throw new HttpError(400, 'Validation failed', [{ field: 'password', message: `password must be at least ${MIN_PASSWORD} characters` }]);
    }
}

// Removing or demoting an admin must leave at least one.
async function assertAnotherAdmin(conn, id) {
    const [{ n }] = await conn.query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND user_id <> ? FOR UPDATE", [id]);
    if (!n) throw new HttpError(409, 'There must always be at least one admin account');
}

router.get('/', async (req, res) => {
    const { q, role } = validate(req.query, { q: str({ max: 100 }), role: oneOf(ROLES) });
    const where = [];
    const params = [];
    if (q) { where.push('(x.username LIKE ? OR x.full_name LIKE ?)'); params.push(likePattern(q), likePattern(q)); }
    if (role) { where.push('x.role = ?'); params.push(role); }
    const rows = await db.query(
        `${LIST_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY FIELD(x.role, 'admin', 'staff', 'customer'), x.full_name`,
        params
    );
    res.json(rows.map((u) => ({ ...u, is_self: u.user_id === req.user.user_id })));
});

// A new staff or admin login. Customers make their own accounts on the storefront.
router.post('/', async (req, res) => {
    const input = validate(req.body, {
        username: str({ required: true, max: 60 }),
        full_name: str({ required: true, max: 150 }),
        password: str({ required: true, max: 200 }),
        role: oneOf(['admin', 'staff'], { required: true }),
    });
    if (!/^[A-Za-z0-9._-]{3,60}$/.test(input.username)) {
        throw new HttpError(400, 'Validation failed', [{ field: 'username', message: 'username must be 3 to 60 letters, digits, dots, dashes or underscores' }]);
    }
    checkPassword(input.password);
    const [taken] = await db.query('SELECT user_id FROM users WHERE username = ?', [input.username]);
    if (taken) throw new HttpError(409, `The username ${input.username} is already taken`);
    const result = await db.query(
        'INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)',
        [input.username, await hashPassword(input.password), input.full_name, input.role]
    );
    const [user] = await db.query(`${LIST_SELECT} WHERE x.user_id = ?`, [result.insertId]);
    res.status(201).json(user);
});

// Changes an account's role. Customer is only possible for accounts linked to a client.
router.patch('/:id/role', async (req, res) => {
    const id = parseId(req.params.id);
    const { role } = validate(req.body, { role: oneOf(ROLES, { required: true }) });
    if (id === req.user.user_id) throw new HttpError(409, 'You can\'t change your own role; ask another admin');
    await db.transaction(async (conn) => {
        const user = await findUser(conn, id);
        if (role === 'customer' && !user.client_id) {
            throw new HttpError(409, 'Only accounts that signed up on the storefront can be customers');
        }
        if (user.role === 'admin' && role !== 'admin') await assertAnotherAdmin(conn, id);
        await conn.query('UPDATE users SET role = ? WHERE user_id = ?', [role, id]);
    });
    const [user] = await db.query(`${LIST_SELECT} WHERE x.user_id = ?`, [id]);
    res.json({ ...user, message: `${user.full_name} is now ${role === 'admin' ? 'an admin' : role}` });
});

router.patch('/:id/password', async (req, res) => {
    const id = parseId(req.params.id);
    const { password } = validate(req.body, { password: str({ required: true, max: 200 }) });
    checkPassword(password);
    const hash = await hashPassword(password);
    const result = await db.query('UPDATE users SET password_hash = ? WHERE user_id = ?', [hash, id]);
    if (!result.affectedRows) throw new HttpError(404, `Account ${id} not found`);
    res.json({ message: 'Password changed' });
});

// Deletes a login. A customer's client record and bookings stay (they belong to the business).
router.delete('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (id === req.user.user_id) throw new HttpError(409, 'You can\'t delete your own account');
    const user = await db.transaction(async (conn) => {
        const found = await findUser(conn, id);
        if (found.role === 'admin') await assertAnotherAdmin(conn, id);
        await conn.query('DELETE FROM users WHERE user_id = ?', [id]);
        return found;
    });
    res.json({ message: `Account of ${user.full_name} deleted` });
});

module.exports = router;
