const mariadb = require('mariadb');
const { parsePhone } = require('./lib/phone');

// Tables in foreign-key dependency order: a table only references tables above it.
// Every statement uses IF NOT EXISTS, so existing tables and their data are never touched.
const TABLES = [
    {
        name: 'users',
        columns: ['user_id', 'username', 'password_hash', 'full_name', 'role', 'created_at'],
        sql: `CREATE TABLE IF NOT EXISTS users (
            user_id       INT AUTO_INCREMENT PRIMARY KEY,
            username      VARCHAR(60)  NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL,
            full_name     VARCHAR(150),
            role          VARCHAR(30)  NOT NULL DEFAULT 'admin',
            created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB`,
    },
    {
        name: 'clients',
        columns: ['client_id', 'first_name', 'middle_name', 'last_name', 'phone_country_code', 'phone_number', 'email',
            'billing_name', 'street', 'barangay', 'city_municipality', 'province', 'is_deleted', 'created_at'],
        sql: `CREATE TABLE IF NOT EXISTS clients (
            client_id         INT AUTO_INCREMENT PRIMARY KEY,
            first_name        VARCHAR(100) NOT NULL DEFAULT '',
            middle_name       VARCHAR(100),
            last_name         VARCHAR(100) NOT NULL DEFAULT '',
            phone_country_code VARCHAR(5),
            phone_number      VARCHAR(20),
            email             VARCHAR(150) UNIQUE,
            billing_name      VARCHAR(150),
            street            TEXT,
            barangay          VARCHAR(100),
            city_municipality VARCHAR(100),
            province          VARCHAR(100),
            is_deleted       BOOLEAN NOT NULL DEFAULT FALSE,
            created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB`,
    },
    {
        name: 'packages',
        columns: ['package_id', 'name', 'type', 'description', 'base_price', 'image', 'is_deleted'],
        sql: `CREATE TABLE IF NOT EXISTS packages (
            package_id  INT AUTO_INCREMENT PRIMARY KEY,
            name        VARCHAR(120) NOT NULL,
            type        VARCHAR(50),
            description TEXT,
            base_price  DECIMAL(10,2) NOT NULL DEFAULT 0.00,
            image       MEDIUMTEXT,
            is_deleted  BOOLEAN NOT NULL DEFAULT FALSE
        ) ENGINE=InnoDB`,
    },
    {
        name: 'consumables',
        columns: ['consumable_id', 'item_code', 'name', 'unit', 'current_level', 'reorder_level', 'last_restocked_at', 'is_deleted'],
        sql: `CREATE TABLE IF NOT EXISTS consumables (
            consumable_id     INT AUTO_INCREMENT PRIMARY KEY,
            item_code         VARCHAR(30) UNIQUE,
            name              VARCHAR(120) NOT NULL,
            unit              VARCHAR(30)  NOT NULL,
            current_level     INT NOT NULL DEFAULT 0,
            reorder_level     INT NOT NULL DEFAULT 0,
            last_restocked_at DATETIME,
            is_deleted        BOOLEAN NOT NULL DEFAULT FALSE
        ) ENGINE=InnoDB`,
    },
    {
        name: 'rental_items',
        columns: ['item_id', 'item_code', 'name', 'category', 'qty_total', 'rental_price', 'item_condition',
            'qty_out_of_service', 'description', 'image', 'is_deleted'],
        sql: `CREATE TABLE IF NOT EXISTS rental_items (
            item_id        INT AUTO_INCREMENT PRIMARY KEY,
            item_code      VARCHAR(30) UNIQUE,
            name           VARCHAR(150) NOT NULL,
            category       VARCHAR(100),
            qty_total      INT NOT NULL DEFAULT 1,
            rental_price   DECIMAL(10,2) NOT NULL DEFAULT 0.00,
            item_condition VARCHAR(50),
            qty_out_of_service INT NOT NULL DEFAULT 0,
            description        TEXT,
            image              MEDIUMTEXT,
            is_deleted         BOOLEAN NOT NULL DEFAULT FALSE
        ) ENGINE=InnoDB`,
    },
    {
        name: 'package_items',
        columns: ['package_item_id', 'package_id', 'item_id', 'qty'],
        sql: `CREATE TABLE IF NOT EXISTS package_items (
            package_item_id INT AUTO_INCREMENT PRIMARY KEY,
            package_id      INT NOT NULL,
            item_id         INT NOT NULL,
            qty             INT NOT NULL DEFAULT 1,
            CONSTRAINT fk_pi_package FOREIGN KEY (package_id) REFERENCES packages (package_id) ON DELETE CASCADE,
            CONSTRAINT fk_pi_item    FOREIGN KEY (item_id)    REFERENCES rental_items (item_id) ON DELETE RESTRICT,
            CONSTRAINT uq_package_item UNIQUE (package_id, item_id)
        ) ENGINE=InnoDB`,
    },
    {
        name: 'events',
        columns: ['event_id', 'client_id', 'package_id', 'event_type', 'source', 'event_date', 'start_time', 'venue_name',
            'venue_street', 'venue_barangay', 'venue_city_municipality', 'venue_province', 'status',
            'contract_value', 'custom_order', 'setup_notes', 'created_at'],
        sql: `CREATE TABLE IF NOT EXISTS events (
            event_id       INT AUTO_INCREMENT PRIMARY KEY,
            client_id      INT NOT NULL,
            package_id     INT NULL,
            event_type     VARCHAR(60),
            source         VARCHAR(20) NOT NULL DEFAULT 'admin',
            event_date     DATE NOT NULL,
            start_time     TIME,
            venue_name     VARCHAR(150),
            venue_street            TEXT,
            venue_barangay          VARCHAR(100),
            venue_city_municipality VARCHAR(100),
            venue_province          VARCHAR(100),
            status         VARCHAR(50) NOT NULL DEFAULT 'Pending',
            contract_value DECIMAL(10,2) NOT NULL DEFAULT 0.00,
            custom_order   TEXT,
            setup_notes    TEXT,
            created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_events_client  FOREIGN KEY (client_id)  REFERENCES clients (client_id)   ON DELETE RESTRICT,
            CONSTRAINT fk_events_package FOREIGN KEY (package_id) REFERENCES packages (package_id) ON DELETE SET NULL
        ) ENGINE=InnoDB`,
    },
    {
        name: 'payments',
        columns: ['payment_id', 'event_id', 'type', 'amount', 'method', 'paid_at', 'reference_no'],
        sql: `CREATE TABLE IF NOT EXISTS payments (
            payment_id   INT AUTO_INCREMENT PRIMARY KEY,
            event_id     INT NOT NULL,
            type         VARCHAR(50),
            amount       DECIMAL(10,2) NOT NULL,
            method       VARCHAR(50),
            paid_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
            reference_no VARCHAR(100),
            CONSTRAINT fk_payments_event FOREIGN KEY (event_id) REFERENCES events (event_id) ON DELETE CASCADE
        ) ENGINE=InnoDB`,
    },
    {
        name: 'event_consumables',
        columns: ['id', 'event_id', 'consumable_id', 'qty_used'],
        sql: `CREATE TABLE IF NOT EXISTS event_consumables (
            id            INT AUTO_INCREMENT PRIMARY KEY,
            event_id      INT NOT NULL,
            consumable_id INT NOT NULL,
            qty_used      INT NOT NULL DEFAULT 1,
            CONSTRAINT fk_ec_event      FOREIGN KEY (event_id)      REFERENCES events (event_id)           ON DELETE CASCADE,
            CONSTRAINT fk_ec_consumable FOREIGN KEY (consumable_id) REFERENCES consumables (consumable_id) ON DELETE RESTRICT
        ) ENGINE=InnoDB`,
    },
    {
        name: 'event_items',
        columns: ['event_item_id', 'event_id', 'item_id', 'qty', 'is_reserved', 'return_due_date', 'return_status',
            'pull_status'],
        sql: `CREATE TABLE IF NOT EXISTS event_items (
            event_item_id   INT AUTO_INCREMENT PRIMARY KEY,
            event_id        INT NOT NULL,
            item_id         INT NOT NULL,
            qty             INT NOT NULL DEFAULT 1,
            is_reserved     BOOLEAN DEFAULT FALSE,
            return_due_date DATE,
            return_status   VARCHAR(50) NOT NULL DEFAULT 'Pending',
            pull_status     VARCHAR(20) NOT NULL DEFAULT 'Pending',
            CONSTRAINT fk_ei_event FOREIGN KEY (event_id) REFERENCES events (event_id)      ON DELETE CASCADE,
            CONSTRAINT fk_ei_item  FOREIGN KEY (item_id)  REFERENCES rental_items (item_id) ON DELETE RESTRICT
        ) ENGINE=InnoDB`,
    },
    {
        name: 'return_logs',
        columns: ['return_id', 'event_item_id', 'returned_at', 'condition_on_return', 'damage_fee', 'deposit_charged'],
        sql: `CREATE TABLE IF NOT EXISTS return_logs (
            return_id           INT AUTO_INCREMENT PRIMARY KEY,
            event_item_id       INT NOT NULL,
            returned_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
            condition_on_return VARCHAR(100),
            damage_fee          DECIMAL(10,2) DEFAULT 0.00,
            deposit_charged     DECIMAL(10,2) DEFAULT 0.00,
            CONSTRAINT fk_rl_event_item FOREIGN KEY (event_item_id) REFERENCES event_items (event_item_id) ON DELETE CASCADE
        ) ENGINE=InnoDB`,
    },
    {
        name: 'notifications',
        columns: ['notification_id', 'message', 'type', 'event_id', 'is_read', 'ref_key', 'created_at'],
        sql: `CREATE TABLE IF NOT EXISTS notifications (
            notification_id INT AUTO_INCREMENT PRIMARY KEY,
            message         VARCHAR(500) NOT NULL,
            type            VARCHAR(30)  NOT NULL,
            event_id        INT NULL,
            is_read         BOOLEAN NOT NULL DEFAULT FALSE,
            ref_key         VARCHAR(100) UNIQUE,
            created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB`,
    },
    {
        // One row per part of the data (clients, events, ...), bumped on every write to it,
        // so the heartbeat can tell clients what changed. See lib/changes.js.
        name: 'data_versions',
        columns: ['section', 'version', 'updated_at'],
        sql: `CREATE TABLE IF NOT EXISTS data_versions (
            section    VARCHAR(30) PRIMARY KEY,
            version    INT UNSIGNED NOT NULL DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB`,
    },
    {
        // Every write to any other table: what, who and from which request. Shown in the admin
        // Database tab's console. See lib/changes.js.
        name: 'change_log',
        columns: ['log_id', 'created_at', 'table_name', 'action', 'row_count', 'row_id', 'user_id', 'username', 'source', 'statement', 'params'],
        sql: `CREATE TABLE IF NOT EXISTS change_log (
            log_id     BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            table_name VARCHAR(64) NOT NULL,
            action     VARCHAR(10) NOT NULL,
            row_count  INT UNSIGNED NOT NULL,
            row_id     BIGINT UNSIGNED NULL,
            user_id    INT NULL,
            username   VARCHAR(60) NULL,
            source     VARCHAR(160) NULL,
            statement  TEXT NOT NULL,
            params     TEXT NULL,
            INDEX idx_change_log_table (table_name, log_id),
            INDEX idx_change_log_created (created_at)
        ) ENGINE=InnoDB`,
    },
];

// Columns added after the first schema. CREATE TABLE IF NOT EXISTS leaves existing tables
// alone, so databases created earlier get them here; on fresh databases these are no-ops.
// The optional fourth entry fills the new column from existing data, once, when it's added.
const ADDED_COLUMNS = [
    ['clients', 'is_deleted', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['consumables', 'is_deleted', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['rental_items', 'qty_out_of_service', 'INT NOT NULL DEFAULT 0'],
    ['rental_items', 'is_deleted', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['events', 'created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP'],
    ['event_items', 'pull_status', "VARCHAR(20) NOT NULL DEFAULT 'Pending'"],
    ['packages', 'type', 'VARCHAR(50)'],
    ['packages', 'image', 'MEDIUMTEXT'],
    ['packages', 'is_deleted', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['events', 'custom_order', 'TEXT'],
    ['rental_items', 'description', 'TEXT'],
    ['rental_items', 'image', 'MEDIUMTEXT'],
    ['clients', 'first_name', "VARCHAR(100) NOT NULL DEFAULT ''"],
    ['clients', 'middle_name', 'VARCHAR(100)'],
    ['clients', 'last_name', "VARCHAR(100) NOT NULL DEFAULT ''"],
    ['clients', 'street', 'TEXT'],
    ['clients', 'barangay', 'VARCHAR(100)'],
    ['clients', 'city_municipality', 'VARCHAR(100)'],
    ['clients', 'province', 'VARCHAR(100)'],
    ['events', 'venue_street', 'TEXT'],
    ['events', 'venue_barangay', 'VARCHAR(100)'],
    ['events', 'venue_city_municipality', 'VARCHAR(100)'],
    ['events', 'venue_province', 'VARCHAR(100)'],
    ['clients', 'phone_country_code', 'VARCHAR(5)'],
    ['clients', 'phone_number', 'VARCHAR(20)'],
    // The event a notification is about, so clicking it can open the event. Older ones
    // named it in their text as "(event #12)".
    ['notifications', 'event_id', 'INT NULL', `UPDATE notifications
        SET event_id = CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(message, '(event #', -1), ')', 1) AS UNSIGNED)
        WHERE message LIKE '%(event #%)%'`],
    // Early storefront orders kept the purpose in their notes as "Event: <purpose>".
    ['events', 'event_type', 'VARCHAR(60)', `UPDATE events
        SET event_type = LEFT(TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(setup_notes, 'Event: ', -1), '\\n', 1)), 60)
        WHERE setup_notes LIKE 'Online order%Event: %'`],
    ['events', 'source', "VARCHAR(20) NOT NULL DEFAULT 'admin'", "UPDATE events SET source = 'online' WHERE setup_notes LIKE 'Online order%'"],
    ['rental_items', 'item_code', 'VARCHAR(30) UNIQUE', "UPDATE rental_items SET item_code = CONCAT('RNT-', LPAD(item_id, 4, '0'))"],
    ['consumables', 'item_code', 'VARCHAR(30) UNIQUE', "UPDATE consumables SET item_code = CONCAT('CNS-', LPAD(consumable_id, 4, '0'))"],
];

// Columns that grew. Each is widened only while it's still the old type.
const WIDENED_COLUMNS = [
    ['events', 'custom_order', 'TEXT'],
];

// The last word of an old one-piece name becomes the last name and the rest the first name.
const SPLIT_NAME = `UPDATE clients SET
    last_name = IF(LOCATE(' ', TRIM(full_name)) > 0, SUBSTRING_INDEX(TRIM(full_name), ' ', -1), ''),
    first_name = IF(LOCATE(' ', TRIM(full_name)) > 0,
        TRIM(LEFT(TRIM(full_name), CHAR_LENGTH(TRIM(full_name)) - CHAR_LENGTH(SUBSTRING_INDEX(TRIM(full_name), ' ', -1)))),
        TRIM(full_name))
    WHERE first_name = '' AND last_name = ''`;

// Old one-piece phone numbers ('0917 123 4567', '+639171234567', ...) split into a country
// code and the number after it, by the same rules as new input. One that doesn't fit them
// (a landline, a typo) is kept whole in phone_number with no code, so nothing is lost; it
// shows as typed until someone edits the client.
async function splitPhones(conn) {
    const rows = await conn.query("SELECT client_id, phone FROM clients WHERE COALESCE(phone, '') <> ''");
    for (const { client_id: id, phone } of rows) {
        const { code = null, number = phone.trim().slice(0, 20) } = parsePhone(phone.trim());
        await conn.query('UPDATE clients SET phone_country_code = ?, phone_number = ? WHERE client_id = ?', [code, number, id]);
    }
}

// Columns no longer used. Where an entry has a `move` statement (or function), it copies the old values
// into the columns that replace them (which ADDED_COLUMNS has already created) right before
// the drop, so no data is lost. Old free-text addresses can't be split reliably, so they go
// into the street line for someone to tidy up. Rental items come back after every event, so
// they don't need a reorder level; consumables keep theirs.
const DROPPED_COLUMNS = [
    ['clients', 'full_name', SPLIT_NAME],
    ['clients', 'billing_address', 'UPDATE clients SET street = billing_address WHERE street IS NULL'],
    ['clients', 'phone', splitPhones],
    ['events', 'venue_address', 'UPDATE events SET venue_street = venue_address WHERE venue_street IS NULL'],
    ['rental_items', 'reorder_level'],
];

// Identifiers can't be bound as query parameters, so only allow a safe character set.
function assertSafeIdentifier(name) {
    if (!name || !/^[A-Za-z0-9_]{1,64}$/.test(name)) {
        throw new Error(`Invalid database name "${name}". Use only letters, digits and underscores.`);
    }
}

async function existingTables(conn, dbName) {
    const rows = await conn.query(
        'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ?',
        [dbName]
    );
    return new Set(rows.map((r) => r.name));
}

// A pre-existing table with the same name but a different shape would make the app
// fail at query time, so catch it at boot instead.
async function verifyColumns(conn, dbName) {
    const rows = await conn.query(
        'SELECT table_name AS tbl, column_name AS col FROM information_schema.columns WHERE table_schema = ?',
        [dbName]
    );
    const actual = new Map();
    for (const { tbl, col } of rows) {
        if (!actual.has(tbl)) actual.set(tbl, new Set());
        actual.get(tbl).add(col);
    }

    const problems = [];
    for (const table of TABLES) {
        const cols = actual.get(table.name);
        if (!cols) {
            problems.push(`table "${table.name}" is missing`);
            continue;
        }
        const missing = table.columns.filter((c) => !cols.has(c));
        if (missing.length) problems.push(`table "${table.name}" is missing columns: ${missing.join(', ')}`);
    }
    if (problems.length) {
        throw new Error(`Schema check failed in "${dbName}":\n  - ${problems.join('\n  - ')}`);
    }
}

async function columnInfo(conn, dbName) {
    const rows = await conn.query(
        `SELECT table_name AS tbl, column_name AS col, data_type AS type
         FROM information_schema.columns WHERE table_schema = ?`,
        [dbName]
    );
    return new Map(rows.map((r) => [`${r.tbl}.${r.col}`, r]));
}

// Brings a database made by an older version up to the current shape, keeping its data.
async function upgradeColumns(conn, dbName) {
    let cols = await columnInfo(conn, dbName);
    for (const [table, column, ddl, backfill] of ADDED_COLUMNS) {
        if (cols.has(`${table}.${column}`)) continue;
        await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${ddl}`);
        if (backfill) await conn.query(backfill);
        console.log(`[db] ${table}.${column}: added`);
    }

    cols = await columnInfo(conn, dbName);
    for (const [table, column, ddl] of WIDENED_COLUMNS) {
        if (cols.get(`${table}.${column}`).type.toUpperCase() === ddl) continue;
        await conn.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${ddl}`);
        console.log(`[db] ${table}.${column}: widened to ${ddl}`);
    }

    for (const [table, column, move] of DROPPED_COLUMNS) {
        if (!cols.has(`${table}.${column}`)) continue;
        if (typeof move === 'function') await move(conn);
        else if (move) await conn.query(move);
        await conn.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
        console.log(`[db] ${table}.${column}: ${move ? 'moved into its replacement columns and removed' : 'removed'}`);
    }
}

async function initDatabase({ host, port, user, password, database }) {
    assertSafeIdentifier(database);

    let conn;
    try {
        conn = await mariadb.createConnection({ host, port, user, password });

        await conn.query(
            `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
        );
        await conn.query(`USE \`${database}\``);

        const before = await existingTables(conn, database);
        for (const table of TABLES) {
            await conn.query(table.sql);
            console.log(`[db] ${table.name}: ${before.has(table.name) ? 'already exists, skipped' : 'created'}`);
        }
        await upgradeColumns(conn, database);

        await verifyColumns(conn, database);
        console.log(`[db] Schema for "${database}" is ready.`);
    } finally {
        if (conn) await conn.end();
    }
}

module.exports = { initDatabase };
