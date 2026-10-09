const express = require('express');
const db = require('../lib/db');
const { validate, str } = require('../lib/validate');
const { SECTIONS, encodeCursor, changedSince } = require('../lib/changes');

const router = express.Router();

// Polled by the dashboard (every 30-60s is plenty) to learn which parts of the data changed
// since it last looked, instead of refetching every page. Send the previous response's
// cursor as ?since= and refetch whatever `changed` lists; without one everything is listed.
// Reads only: new low-stock and overdue alerts still appear when the bell is fetched.
router.get('/heartbeat', async (req, res) => {
    const { since } = validate(req.query, { since: str({ max: 500 }) });
    const [clock] = await db.query('SELECT CURDATE() AS today, NOW() AS server_time');
    const rows = await db.query('SELECT section, version, updated_at FROM data_versions');
    const byName = new Map(rows.map((r) => [r.section, r]));
    const versions = Object.fromEntries(SECTIONS.map((s) => [s, byName.get(s)?.version ?? 0]));

    res.json({
        cursor: encodeCursor(versions, clock.today),
        changed: changedSince(since, versions, clock.today),
        today: clock.today,
        server_time: clock.server_time,
        sections: Object.fromEntries(SECTIONS.map((s) => [s, { version: versions[s], updated_at: byName.get(s)?.updated_at ?? null }])),
    });
});

module.exports = router;
