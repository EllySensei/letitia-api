const express = require('express');
const db = require('../lib/db');
const { HttpError } = require('../lib/errors');
const { validate, nameFields, str, email, phone } = require('../lib/validate');
const { rateLimit } = require('../lib/rateLimit');
const auth = require('../lib/auth');

const router = express.Router();

const MIN_PASSWORD = 8;

// Staff sign in with their username, customers with their email (as do customers an admin made
// staff); one form serves both and the app checks the role it gets back (the storefront takes
// customers, /admin takes staff).
router.post('/login', async (req, res) => {
    const { username, password } = validate(req.body, {
        username: str({ required: true, max: 150 }),
        password: str({ required: true, max: 200 }),
    });

    const key = `${req.ip}|${username.toLowerCase()}`;
    auth.checkLoginAllowed(key);

    const [user] = await db.query(
        `SELECT u.user_id, u.password_hash FROM users u LEFT JOIN clients c ON c.client_id = u.client_id
         WHERE u.username = ? OR c.email = ?`,
        [username, username]
    );
    if (!(await auth.verifyPassword(password, user?.password_hash))) {
        auth.recordLoginFailure(key);
        throw new HttpError(401, 'Invalid username or password');
    }
    auth.clearLoginFailures(key);

    const [account] = await db.query(`${auth.USER_SELECT} WHERE u.user_id = ?`, [user.user_id]);
    res.json({ token: auth.issueToken(account), user: account });
});

// Customer sign-up. The account is linked to a client record: a new one, or the existing
// client with that email (someone who booked before), who then sees those bookings too.
router.post('/register', rateLimit(10, 60 * 60 * 1000, 'Too many sign-ups from this connection, please try again later'), async (req, res) => {
    const input = validate(req.body, {
        ...nameFields(),
        email: email({ required: true }),
        phone: phone({ required: true }),
        password: str({ required: true, max: 200 }),
    });
    if (input.password.length < MIN_PASSWORD) {
        throw new HttpError(400, 'Validation failed', [{ field: 'password', message: `password must be at least ${MIN_PASSWORD} characters` }]);
    }
    const { phone_country_code: code, phone_number: number } = input.phone;
    const hash = await auth.hashPassword(input.password);

    const userId = await db.transaction(async (conn) => {
        const [existing] = await conn.query('SELECT client_id FROM clients WHERE email = ? FOR UPDATE', [input.email]);
        let clientId = existing?.client_id;
        if (clientId) {
            const [taken] = await conn.query('SELECT user_id FROM users WHERE client_id = ?', [clientId]);
            if (taken) throw new HttpError(409, 'An account with this email already exists. Log in instead.');
            // A past (or archived) client is brought back; details already on file are kept.
            await conn.query(
                `UPDATE clients SET is_deleted = 0,
                        phone_country_code = COALESCE(phone_country_code, ?), phone_number = COALESCE(phone_number, ?)
                 WHERE client_id = ?`,
                [code, number, clientId]
            );
        } else {
            const r = await conn.query(
                `INSERT INTO clients (first_name, middle_name, last_name, phone_country_code, phone_number, email)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [input.first_name, input.middle_name ?? null, input.last_name, code, number, input.email]
            );
            clientId = r.insertId;
        }
        const r = await conn.query(
            "INSERT INTO users (password_hash, role, client_id) VALUES (?, 'customer', ?)",
            [hash, clientId]
        );
        return r.insertId;
    });

    const [account] = await db.query(`${auth.USER_SELECT} WHERE u.user_id = ?`, [userId]);
    res.status(201).json({ token: auth.issueToken(account), user: account });
});

router.post('/logout', auth.requireAuth, (req, res) => {
    auth.revoke(req.token);
    res.json({ message: 'Logged out' });
});

router.get('/me', auth.requireAuth, (req, res) => {
    res.json(req.user);
});

module.exports = router;
