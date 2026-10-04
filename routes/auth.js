const express = require('express');
const db = require('../lib/db');
const { HttpError } = require('../lib/errors');
const { validate, str } = require('../lib/validate');
const auth = require('../lib/auth');

const router = express.Router();

router.post('/login', async (req, res) => {
    const { username, password } = validate(req.body, {
        username: str({ required: true, max: 60 }),
        password: str({ required: true, max: 200 }),
    });

    const key = `${req.ip}|${username.toLowerCase()}`;
    auth.checkLoginAllowed(key);

    const [user] = await db.query(
        'SELECT user_id, username, full_name, role, password_hash FROM users WHERE username = ?',
        [username]
    );
    if (!(await auth.verifyPassword(password, user?.password_hash))) {
        auth.recordLoginFailure(key);
        throw new HttpError(401, 'Invalid username or password');
    }
    auth.clearLoginFailures(key);

    const { password_hash, ...safeUser } = user;
    res.json({ token: auth.issueToken(user), user: safeUser });
});

router.post('/logout', auth.requireAuth, (req, res) => {
    auth.revoke(req.token);
    res.json({ message: 'Logged out' });
});

router.get('/me', auth.requireAuth, (req, res) => {
    res.json(req.user);
});

module.exports = router;
