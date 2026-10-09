const mariadb = require('mariadb');
const { describeWrite, record } = require('./changes');

let pool;

function connect(config) {
    pool = mariadb.createPool({
        ...config,
        connectionLimit: 5,
        // Plain JS values: JSON can't serialise BigInt (COUNT/SUM/insertId), and Date objects
        // for DATE columns would shift with the server's timezone.
        bigIntAsNumber: true,
        insertIdAsNumber: true,
        decimalAsNumber: true,
        dateStrings: true,
    });
    return pool;
}

// Writes are also recorded for the heartbeat and the change log (lib/changes). Outside a
// transaction the write has already happened, so a failed record is logged rather than thrown.
async function query(sql, params) {
    const result = await pool.query(sql, params);
    const entry = describeWrite(sql, params, result);
    if (entry) await record(pool, [entry]).catch((err) => console.error('[changes] could not record a change:', err.message));
    return result;
}

// Runs fn(conn) inside a transaction: commits if it resolves, rolls back if it throws.
// fn gets a conn whose query() notes what it writes; the notes are recorded in the same
// transaction, so a rolled-back change leaves no trace.
async function transaction(fn) {
    const conn = await pool.getConnection();
    const touched = [];
    const tracked = {
        async query(sql, params) {
            const result = await conn.query(sql, params);
            const entry = describeWrite(sql, params, result);
            if (entry) touched.push(entry);
            return result;
        },
    };
    try {
        await conn.beginTransaction();
        const result = await fn(tracked);
        await record(conn, touched);
        await conn.commit();
        return result;
    } catch (err) {
        await conn.rollback().catch((rollbackErr) => console.error('[db] rollback failed:', rollbackErr.message));
        throw err;
    } finally {
        conn.release();
    }
}

module.exports = { connect, query, transaction };
