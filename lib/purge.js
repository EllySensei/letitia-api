// Permanent deletes, offered from the "View archived" lists. Only an archived record can be
// deleted for good (archiving first makes it a deliberate second step), and only when nothing
// else refers to it: records with history stay archived so past events and payments stay whole.
const db = require('./db');
const { HttpError } = require('./errors');

// `uses`: [[SQL counting the rows that refer to the record (one "?" for its id), what they are], ...]
async function purge({ table, idColumn, id, label, uses = [] }) {
    await db.transaction(async (conn) => {
        const [row] = await conn.query(`SELECT is_deleted FROM ${table} WHERE ${idColumn} = ? FOR UPDATE`, [id]);
        if (!row) throw new HttpError(404, `${label} ${id} not found`);
        if (!row.is_deleted) throw new HttpError(409, `Archive ${label.toLowerCase()} ${id} first; only archived records can be deleted permanently`);

        const blocking = [];
        for (const [sql, what] of uses) {
            const [{ n }] = await conn.query(sql, [id]);
            if (n) blocking.push(`${n} ${what}`);
        }
        if (blocking.length) {
            throw new HttpError(409, `${label} ${id} can't be deleted because ${blocking.join(' and ')} still refer to it. Keep it archived instead.`);
        }
        await conn.query(`DELETE FROM ${table} WHERE ${idColumn} = ?`, [id]);
    });
    return { message: `${label} ${id} deleted permanently` };
}

module.exports = { purge };
