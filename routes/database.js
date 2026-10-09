// The admin Database tab: every table with its rows, and a console of the change log.
// Read-only, and admins only, even for looking.
const express = require('express');
const db = require('../lib/db');
const { HttpError } = require('../lib/errors');
const { requireAdmin } = require('../lib/auth');
const { validate, paging, str, int } = require('../lib/validate');

const router = express.Router();
router.use(requireAdmin);

// Shown as [hidden] instead of their values.
const HIDDEN_COLUMNS = { users: ['password_hash'] };
// Long text (pictures are data URLs of hundreds of KB) is cut to a preview in SQL, so the
// full values never leave the database.
const LONG_TEXT = ['text', 'mediumtext', 'longtext', 'blob', 'mediumblob', 'longblob'];
const PREVIEW_CHARS = 120;

// Table names can't be bound as parameters, so they're only ever taken from this list.
async function columnsByTable() {
    const rows = await db.query(
        `SELECT c.table_name AS tbl, c.column_name AS name, c.column_type AS type, c.data_type AS data_type,
                c.column_key = 'PRI' AS is_primary, c.is_nullable = 'YES' AS nullable
         FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         WHERE c.table_schema = DATABASE() AND t.table_type = 'BASE TABLE'
         ORDER BY c.table_name, c.ordinal_position`
    );
    const tables = new Map();
    for (const { tbl, ...col } of rows) {
        if (!tables.has(tbl)) tables.set(tbl, []);
        tables.get(tbl).push({ ...col, is_primary: Boolean(col.is_primary), nullable: Boolean(col.nullable) });
    }
    return tables;
}

const quote = (name) => `\`${name.replace(/`/g, '``')}\``;

router.get('/tables', async (req, res) => {
    const tables = await columnsByTable();
    const activity = new Map((await db.query(
        'SELECT table_name, COUNT(*) AS changes, MAX(created_at) AS last_change FROM change_log GROUP BY table_name'
    )).map((r) => [r.table_name, r]));

    const list = [];
    for (const [name, columns] of tables) {
        const [{ n }] = await db.query(`SELECT COUNT(*) AS n FROM ${quote(name)}`);
        list.push({
            name,
            rows: n,
            columns: columns.length,
            changes: activity.get(name)?.changes ?? 0,
            last_change: activity.get(name)?.last_change ?? null,
        });
    }
    res.json(list);
});

router.get('/tables/:name', async (req, res) => {
    const { limit, offset } = validate(req.query, { ...paging, limit: int({ min: 1, max: 200, default: 50 }) });
    const name = req.params.name;
    const columns = (await columnsByTable()).get(name);
    if (!columns) throw new HttpError(404, `Table ${name} not found`);

    const hidden = HIDDEN_COLUMNS[name] ?? [];
    const select = columns.map(({ name: col, data_type }) => {
        const c = quote(col);
        if (hidden.includes(col)) return `IF(${c} IS NULL, NULL, '[hidden]') AS ${c}`;
        if (LONG_TEXT.includes(data_type)) {
            return `IF(CHAR_LENGTH(${c}) > ${PREVIEW_CHARS}, CONCAT(LEFT(${c}, ${PREVIEW_CHARS}), '… (', CHAR_LENGTH(${c}), ' chars)'), ${c}) AS ${c}`;
        }
        return c;
    });
    // Newest first, by primary key where there is one.
    const keys = columns.filter((c) => c.is_primary).map((c) => `${quote(c.name)} DESC`);
    const rows = await db.query(
        `SELECT ${select.join(', ')} FROM ${quote(name)} ${keys.length ? `ORDER BY ${keys.join(', ')}` : ''} LIMIT ? OFFSET ?`,
        [limit, offset]
    );
    const [{ n }] = await db.query(`SELECT COUNT(*) AS n FROM ${quote(name)}`);
    res.json({ name, total: n, limit, offset, columns, rows });
});

// The console. Without `after` it returns the latest entries; with it, only newer ones, so
// the page can poll for what happened since it last looked. Oldest first either way.
router.get('/changes', async (req, res) => {
    const { after, table, limit } = validate(req.query, {
        after: int({ min: 0 }),
        table: str({ max: 64 }),
        limit: int({ min: 1, max: 500, default: 200 }),
    });
    const where = [];
    const params = [];
    if (after !== undefined) { where.push('log_id > ?'); params.push(after); }
    if (table) { where.push('table_name = ?'); params.push(table); }
    const rows = await db.query(
        `SELECT log_id, created_at, table_name, action, row_count, row_id, user_id, username, source, statement, params
         FROM change_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY log_id ${after !== undefined ? 'ASC' : 'DESC'} LIMIT ?`,
        [...params, limit]
    );
    res.json(after !== undefined ? rows : rows.reverse());
});

module.exports = router;
