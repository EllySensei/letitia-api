const mariadb = require('mariadb');

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
        columns: ['client_id', 'full_name', 'phone', 'email', 'billing_name', 'billing_address', 'is_deleted', 'created_at'],
        sql: `CREATE TABLE IF NOT EXISTS clients (
            client_id       INT AUTO_INCREMENT PRIMARY KEY,
            full_name       VARCHAR(150) NOT NULL,
            phone           VARCHAR(30),
            email           VARCHAR(150) UNIQUE,
            billing_name    VARCHAR(150),
            billing_address TEXT,
            is_deleted      BOOLEAN NOT NULL DEFAULT FALSE,
            created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB`,
    },
    {
        name: 'packages',
        columns: ['package_id', 'name', 'description', 'base_price'],
        sql: `CREATE TABLE IF NOT EXISTS packages (
            package_id  INT AUTO_INCREMENT PRIMARY KEY,
            name        VARCHAR(120) NOT NULL,
            description TEXT,
            base_price  DECIMAL(10,2) NOT NULL DEFAULT 0.00
        ) ENGINE=InnoDB`,
    },
    {
        name: 'consumables',
        columns: ['consumable_id', 'name', 'unit', 'current_level', 'reorder_level', 'last_restocked_at', 'is_deleted'],
        sql: `CREATE TABLE IF NOT EXISTS consumables (
            consumable_id     INT AUTO_INCREMENT PRIMARY KEY,
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
        columns: ['item_id', 'name', 'category', 'qty_total', 'rental_price', 'item_condition',
            'reorder_level', 'qty_out_of_service', 'is_deleted'],
        sql: `CREATE TABLE IF NOT EXISTS rental_items (
            item_id        INT AUTO_INCREMENT PRIMARY KEY,
            name           VARCHAR(150) NOT NULL,
            category       VARCHAR(100),
            qty_total      INT NOT NULL DEFAULT 1,
            rental_price   DECIMAL(10,2) NOT NULL DEFAULT 0.00,
            item_condition VARCHAR(50),
            reorder_level      INT NOT NULL DEFAULT 0,
            qty_out_of_service INT NOT NULL DEFAULT 0,
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
        columns: ['event_id', 'client_id', 'package_id', 'event_date', 'start_time', 'venue_name',
            'venue_address', 'status', 'contract_value', 'setup_notes', 'created_at'],
        sql: `CREATE TABLE IF NOT EXISTS events (
            event_id       INT AUTO_INCREMENT PRIMARY KEY,
            client_id      INT NOT NULL,
            package_id     INT NULL,
            event_date     DATE NOT NULL,
            start_time     TIME,
            venue_name     VARCHAR(150),
            venue_address  TEXT,
            status         VARCHAR(50) NOT NULL DEFAULT 'Pending',
            contract_value DECIMAL(10,2) NOT NULL DEFAULT 0.00,
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
        columns: ['notification_id', 'message', 'type', 'is_read', 'ref_key', 'created_at'],
        sql: `CREATE TABLE IF NOT EXISTS notifications (
            notification_id INT AUTO_INCREMENT PRIMARY KEY,
            message         VARCHAR(500) NOT NULL,
            type            VARCHAR(30)  NOT NULL,
            is_read         BOOLEAN NOT NULL DEFAULT FALSE,
            ref_key         VARCHAR(100) UNIQUE,
            created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB`,
    },
];

// Columns added after the first schema. CREATE TABLE IF NOT EXISTS leaves existing tables
// alone, so databases created earlier get them here; on fresh databases these are no-ops.
const ADDED_COLUMNS = [
    ['clients', 'is_deleted', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['consumables', 'is_deleted', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['rental_items', 'reorder_level', 'INT NOT NULL DEFAULT 0'],
    ['rental_items', 'qty_out_of_service', 'INT NOT NULL DEFAULT 0'],
    ['rental_items', 'is_deleted', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['events', 'created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP'],
    ['event_items', 'pull_status', "VARCHAR(20) NOT NULL DEFAULT 'Pending'"],
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
        for (const [table, column, ddl] of ADDED_COLUMNS) {
            await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN IF NOT EXISTS \`${column}\` ${ddl}`);
        }

        await verifyColumns(conn, database);
        console.log(`[db] Schema for "${database}" is ready.`);
    } finally {
        if (conn) await conn.end();
    }
}

module.exports = { initDatabase };
