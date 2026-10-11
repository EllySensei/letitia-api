const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { HttpError } = require('./errors');
const { setUser } = require('./context');

const BCRYPT_ROUNDS = 12;

// Logged-out tokens (jti -> expiry in seconds). Kept in memory, so it resets on restart;
// the outline marks this login as a local demo, production needs a shared store.
const revoked = new Map();

function issueToken(user) {
    return jwt.sign({ sub: String(user.user_id), role: user.role }, process.env.JWT_SECRET, {
        algorithm: 'HS256',
        expiresIn: process.env.JWT_EXPIRES_IN || '8h',
        jwtid: crypto.randomUUID(),
    });
}

function revoke(payload) {
    const now = Math.floor(Date.now() / 1000);
    for (const [jti, exp] of revoked) if (exp < now) revoked.delete(jti);
    revoked.set(payload.jti, payload.exp);
}

async function requireAuth(req, res, next) {
    const match = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
    if (!match) throw new HttpError(401, 'Authentication required');

    let payload;
    try {
        payload = jwt.verify(match[1], process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch (err) {
        throw new HttpError(401, err.name === 'TokenExpiredError' ? 'Session expired, please log in again' : 'Invalid token');
    }
    if (revoked.has(payload.jti)) throw new HttpError(401, 'Session has been logged out');

    const [user] = await db.query(`${USER_SELECT} WHERE u.user_id = ?`, [Number(payload.sub)]);
    if (!user) throw new HttpError(401, 'User no longer exists');

    req.user = user;
    req.token = payload;
    setUser(user);
    next();
}

// A login as the app shows it. A customer's name and email come from their client record;
// staff have their own username and name.
const USER_SELECT = `
    SELECT u.user_id, COALESCE(u.username, c.email) AS username,
           COALESCE(u.full_name, CONCAT_WS(' ', c.first_name, c.last_name)) AS full_name, u.role, u.client_id
    FROM users u LEFT JOIN clients c ON c.client_id = u.client_id`;

const STAFF_ROLES = ['admin', 'staff'];

// For pages only admins may even look at (the Database tab).
function requireAdmin(req, res, next) {
    if (req.user?.role !== 'admin') throw new HttpError(403, 'Admin access required');
    next();
}

// The admin dashboard's data: staff only. Customers have their own routes (routes/account.js).
function requireStaff(req, res, next) {
    if (!STAFF_ROLES.includes(req.user?.role)) throw new HttpError(403, 'Staff access required');
    next();
}

function requireCustomer(req, res, next) {
    if (req.user?.role !== 'customer' || !req.user.client_id) throw new HttpError(403, 'Log in with a customer account to do this');
    next();
}

// Guests can look; only admins can change anything.
function adminForWrites(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.user.role !== 'admin') throw new HttpError(403, 'Admin access required');
    next();
}

// Brute-force guard: 5 failed logins per IP + username locks that pair for 15 minutes.
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const failures = new Map();

function checkLoginAllowed(key) {
    const entry = failures.get(key);
    if (entry && Date.now() - entry.first > LOCK_MS) failures.delete(key);
    else if (entry && entry.count >= MAX_FAILURES) {
        throw new HttpError(429, 'Too many failed login attempts, try again in 15 minutes');
    }
}

function recordLoginFailure(key) {
    const entry = failures.get(key) || { count: 0, first: Date.now() };
    entry.count += 1;
    failures.set(key, entry);
}

const clearLoginFailures = (key) => failures.delete(key);

// Comparing against a dummy hash when the username doesn't exist keeps response times
// the same, so the endpoint doesn't reveal which usernames are valid.
let dummyHash;
async function verifyPassword(password, hash) {
    if (!hash) {
        dummyHash ??= await bcrypt.hash('dummy-password', BCRYPT_ROUNDS);
        await bcrypt.compare(password, dummyHash);
        return false;
    }
    return bcrypt.compare(password, hash);
}

// Creates the first admin from .env when there is no admin yet (customer accounts don't count).
async function seedAdmin() {
    const [{ n }] = await db.query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
    if (n > 0) return;

    const { ADMIN_USERNAME: username, ADMIN_PASSWORD: password } = process.env;
    if (!username || !password) {
        console.warn('[auth] No users exist. Set ADMIN_USERNAME and ADMIN_PASSWORD in .env to create the first admin.');
        return;
    }
    if (password.length < 8) throw new Error('ADMIN_PASSWORD must be at least 8 characters');

    await db.query(
        'INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)',
        [username, await bcrypt.hash(password, BCRYPT_ROUNDS), 'Administrator', 'admin']
    );
    console.log(`[auth] Created admin user "${username}".`);
}

const hashPassword = (password) => bcrypt.hash(password, BCRYPT_ROUNDS);

module.exports = {
    USER_SELECT, STAFF_ROLES, issueToken, revoke, requireAuth, requireAdmin, requireStaff, requireCustomer, adminForWrites,
    verifyPassword, hashPassword, seedAdmin, checkLoginAllowed, recordLoginFailure, clearLoginFailures,
};
