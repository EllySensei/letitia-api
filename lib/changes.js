// Change tracking. Every write that goes through lib/db is
//  - counted against the parts of the data it touched, so a client can poll the heartbeat
//    (GET /heartbeat) and refetch only what changed, and
//  - written to change_log, which the admin Database tab shows as a console.
const { current } = require('./context');

// Tables -> the parts of the data they feed. A booking's item lines drive the event, stock
// and returns views alike.
const TABLE_SECTIONS = {
    clients: ['clients'],
    users: ['clients'], // a customer signing up shows on their client
    events: ['events'],
    event_items: ['events', 'inventory', 'returns'],
    event_consumables: ['events', 'consumables'],
    payments: ['payments'],
    rental_items: ['inventory'],
    consumables: ['consumables'],
    packages: ['packages'],
    package_items: ['packages'],
    return_logs: ['returns'],
    notifications: ['notifications'],
};

const SECTIONS = [...new Set(Object.values(TABLE_SECTIONS).flat())].sort();

// The bookkeeping tables themselves, never logged.
const UNTRACKED = new Set(['change_log', 'data_versions']);

// Tables whose values never go into the log (password hashes).
const HIDDEN_PARAMS = new Set(['users']);

// The table a statement writes to. For a multi-table UPDATE (UPDATE a JOIN b SET a.x = ...)
// that is the first one, which is how every such statement in this codebase is written.
const WRITE = /^\s*(INSERT(?:\s+IGNORE)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+IGNORE)?|DELETE\s+FROM)\s+`?(\w+)`?/i;

const statementText = (sql) => (typeof sql === 'string' ? sql : sql?.sql ?? '');

// Pictures arrive as data URLs of hundreds of KB; the log keeps a short, recognisable stub.
function paramsText(table, params) {
    if (params === undefined || params === null) return null;
    if (HIDDEN_PARAMS.has(table)) return '[hidden]';
    const text = JSON.stringify(params, (key, v) => (typeof v === 'string' && v.length > 120 ? `${v.slice(0, 40)}… (${v.length} chars)` : v));
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
}

// A change-log entry for a finished statement, or null for reads and for writes that
// matched no rows.
function describeWrite(sql, params, result) {
    const text = statementText(sql);
    const match = WRITE.exec(text);
    if (!match || !result?.affectedRows) return null;
    const table = match[2].toLowerCase();
    if (UNTRACKED.has(table)) return null;
    const action = match[1].split(/\s+/)[0].toUpperCase().replace('REPLACE', 'INSERT');
    const { user, source } = current();
    return {
        table,
        action,
        rows: result.affectedRows,
        rowId: action === 'INSERT' && result.insertId > 0 ? result.insertId : null,
        userId: user?.user_id ?? null,
        username: user?.username ?? null,
        source: source ?? null,
        statement: text.replace(/\s+/g, ' ').trim().slice(0, 2000),
        params: paramsText(table, params),
    };
}

// Records finished writes on conn: the pool, or a transaction connection, in which case
// they commit or roll back with the changes themselves. Version rows are bumped in sorted
// order so concurrent transactions lock them in one order.
async function record(conn, entries) {
    if (!entries.length) return;
    const sections = [...new Set(entries.flatMap((e) => TABLE_SECTIONS[e.table] ?? []))].sort();
    if (sections.length) {
        await conn.query(
            `INSERT INTO data_versions (section, version) VALUES ${sections.map(() => '(?, 1)').join(', ')}
             ON DUPLICATE KEY UPDATE version = version + 1`,
            sections
        );
    }
    await conn.query(
        `INSERT INTO change_log (table_name, action, row_count, row_id, user_id, username, source, statement, params)
         VALUES ${entries.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        entries.flatMap((e) => [e.table, e.action, e.rows, e.rowId, e.userId, e.username, e.source, e.statement, e.params])
    );
}

// Keeps the log from growing forever.
function pruneChangeLog(conn, days) {
    return conn.query('DELETE FROM change_log WHERE created_at < NOW() - INTERVAL ? DAY', [days]);
}

// Statuses like Ongoing, Overdue and on-hand stock are worked out from today's date, so these
// change at midnight without any write.
const DATE_SECTIONS = ['events', 'inventory', 'returns', 'notifications'];

// The heartbeat hands out a cursor ("day:2026-10-09,clients:4,events:17,...") and takes it
// back as ?since= to say what changed in between. Parsing is lenient: anything missing or
// unreadable counts as changed, so no cursor at all means everything.
function encodeCursor(versions, today) {
    return [`day:${today}`, ...SECTIONS.map((s) => `${s}:${versions[s] ?? 0}`)].join(',');
}

function changedSince(cursor, versions, today) {
    const seen = new Map(String(cursor ?? '').split(',').map((part) => part.split(':')));
    const newDay = seen.get('day') !== today;
    return SECTIONS.filter((s) => (newDay && DATE_SECTIONS.includes(s)) || seen.get(s) !== String(versions[s] ?? 0));
}

module.exports = { SECTIONS, describeWrite, record, pruneChangeLog, encodeCursor, changedSince };
