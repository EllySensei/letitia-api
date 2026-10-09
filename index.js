require('dotenv').config();
const path = require('path');
const express = require('express');
const db = require('./lib/db');
const { initDatabase } = require('./db_init');
const { requireAuth, adminForWrites, seedAdmin } = require('./lib/auth');
const { notFound, errorHandler } = require('./lib/errors');
const { requestContext } = require('./lib/context');
const { pruneChangeLog } = require('./lib/changes');

const app = express();
const port = Number(process.env.PORT) || 3000;

const dbConfig = {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
};

// Packages and rental items carry a picture, so they get a bigger body limit than everything else.
app.use(['/packages', '/inventory'], express.json({ limit: '2mb' }));
app.use(express.json({ limit: '100kb' }));
// After the body parsers, whose stream callbacks would lose it. Labels each request's database writes.
app.use(requestContext);

// Lets the frontend call the API from another origin (e.g. a separate dev server).
if (process.env.CORS_ORIGIN) {
    app.use((req, res, next) => {
        res.set({
            'Access-Control-Allow-Origin': process.env.CORS_ORIGIN,
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
            Vary: 'Origin',
        });
        if (req.method === 'OPTIONS') return res.sendStatus(204);
        next();
    });
}

// Serves the frontend: http://localhost:3000 is the storefront and /admin the dashboard, and
// their API calls stay same-origin.
app.use(express.static(path.resolve(__dirname, process.env.FRONTEND_DIR || '../Laetitia-frontend'), { extensions: ['html'] }));

// Login and the storefront are public; every other route needs a token, and only admins can make changes.
app.use('/auth', require('./routes/auth'));
app.use('/public', require('./routes/public'));
app.use(requireAuth, adminForWrites);
app.use('/clients', require('./routes/clients'));
app.use('/events', require('./routes/events'));
app.use('/inventory', require('./routes/inventory'));
app.use('/consumables', require('./routes/consumables'));
app.use('/packages', require('./routes/packages'));
app.use('/payments', require('./routes/payments'));
app.use('/returns', require('./routes/returns'));
app.use(require('./routes/schedule'));
app.use(require('./routes/dashboard'));
app.use(require('./routes/notifications'));
app.use(require('./routes/heartbeat'));
app.use('/database', require('./routes/database'));

app.use(notFound);
app.use(errorHandler);

async function start() {
    if (!process.env.JWT_SECRET) {
        console.error('JWT_SECRET is not set. Add a long random string to .env.');
        process.exit(1);
    }
    if (process.env.JWT_SECRET.length < 32) console.warn('[auth] JWT_SECRET is shorter than 32 characters; use a longer random value.');

    try {
        await initDatabase(dbConfig);
    } catch (err) {
        console.error('Error initializing database:', err.message);
        process.exit(1);
    }

    // Created after init so the pool's default database is guaranteed to exist.
    db.connect(dbConfig);

    // The change log keeps CHANGE_LOG_DAYS (default 90) days of history, trimmed daily.
    const keepDays = Number(process.env.CHANGE_LOG_DAYS) || 90;
    const prune = () => pruneChangeLog(db, keepDays).catch((err) => console.error('[changes] pruning the change log failed:', err.message));
    await prune();
    setInterval(prune, 24 * 60 * 60 * 1000).unref();

    try {
        await seedAdmin();
    } catch (err) {
        console.error('Error creating admin user:', err.message);
        process.exit(1);
    }

    app.listen(port, (err) => {
        if (err) {
            console.error(`Could not start server on PORT ${port}:`, err.message);
            process.exit(1);
        }
        console.log(`Server is online on PORT ${port}`);
    })
}

start();
