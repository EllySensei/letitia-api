// Writes the whole database (CREATE DATABASE, every CREATE TABLE with its keys, and the rows
// as INSERTs) to database/laetitia.sql, for the project submission.
// Run with: npm run export-sql
//
// User accounts and the change log are exported empty: the dump shouldn't carry password
// hashes, and on first start the app creates the admin from .env again.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// mariadb-dump from MARIADB_DUMP, else a standard Windows MariaDB install, else the PATH.
function findDump() {
    if (process.env.MARIADB_DUMP) return process.env.MARIADB_DUMP;
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    if (fs.existsSync(programFiles)) {
        const installs = fs.readdirSync(programFiles).filter((d) => /^MariaDB/i.test(d)).sort().reverse();
        for (const dir of installs) {
            const exe = path.join(programFiles, dir, 'bin', 'mariadb-dump.exe');
            if (fs.existsSync(exe)) return exe;
        }
    }
    return 'mariadb-dump';
}

const db = process.env.DB_NAME;
const out = path.join(__dirname, '..', 'database', `${db}.sql`);
fs.mkdirSync(path.dirname(out), { recursive: true });

const sql = execFileSync(findDump(), [
    `--host=${process.env.DB_HOST || 'localhost'}`,
    `--port=${process.env.DB_PORT || 3306}`,
    `--user=${process.env.DB_USER}`,
    '--databases', db,
    // One INSERT per row, so the sample data is readable.
    '--skip-extended-insert',
    '--skip-dump-date',
    `--ignore-table-data=${db}.users`,
    `--ignore-table-data=${db}.change_log`,
], {
    // Passed through the environment so the password never shows in the process list.
    env: { ...process.env, MYSQL_PWD: process.env.DB_PASS || '' },
    maxBuffer: 256 * 1024 * 1024,
});

fs.writeFileSync(out, sql);
console.log(`Wrote ${path.relative(process.cwd(), out)} (${(sql.length / 1024).toFixed(1)} KB)`);
