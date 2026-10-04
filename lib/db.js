const mariadb = require('mariadb');

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

function query(sql, params) {
    return pool.query(sql, params);
}

// Runs fn(conn) inside a transaction: commits if it resolves, rolls back if it throws.
async function transaction(fn) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const result = await fn(conn);
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
