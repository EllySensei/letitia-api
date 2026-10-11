// Sample data for demos and the project submission: a small event-styling business in
// Cabuyao, Laguna. generateSampleData() replaces every business table's rows with this set
// (admin accounts are kept). Event dates are relative to today, so there is always a mix of
// finished, overdue, tomorrow's and upcoming events whatever day it is run.
const { addDays, assignCode } = require('./sql');
const { hashPassword } = require('./auth');

// Customer logins for the demo: these clients can sign in on the storefront with their email
// (angelica.santos@example.com, bea.ocampo@example.com) and this password.
const DEMO_CUSTOMER_PASSWORD = 'customer123';
const CUSTOMER_ACCOUNTS = [1, 8];

// Tables cleared before inserting, children before parents.
const WIPE_ORDER = [
    'return_logs', 'payments', 'event_consumables', 'event_items', 'notifications', 'events',
    'package_items', 'packages', 'rental_items', 'consumables', 'clients',
];

// [first, middle, last, phone (after +63), billing name, street, barangay, city/municipality]
const CLIENTS = [
    ['Angelica', 'Ramos', 'Santos', '9171234501', null, 'Blk 4 Lot 12, Mabuhay City Subd.', 'Mamatid', 'Cabuyao'],
    ['Mark Anthony', 'Cruz', 'Villanueva', '9182345602', null, '23 Rizal St.', 'Poblacion Uno', 'Cabuyao'],
    ['Kristine Joy', 'Mendoza', 'Bautista', '9273456703', null, 'Phase 2 Blk 7 Lot 3, Southville 1', 'Pulo', 'Cabuyao'],
    ['Ramon', 'Aquino', 'Dizon', '9154567804', 'Dizon Hardware Trading', '118 National Highway', 'Banay-Banay', 'Cabuyao'],
    ['Patricia Mae', 'Garcia', 'Lim', '9065678905', null, 'Unit 5B, Palm Residences', 'Balibago', 'Santa Rosa'],
    ['Jerome', 'Castillo', 'Navarro', '9396789006', null, '45 Sampaguita St., Villa Olympia', 'San Antonio', 'San Pedro'],
    ['Camille', 'Torres', 'Aguilar', '9457890107', null, '7 Mabini St.', 'Real', 'Calamba'],
    ['Bea Nicole', 'Flores', 'Ocampo', '9988901208', null, 'Blk 12 Lot 9, Ciudad de Calamba', 'Paciano Rizal', 'Calamba'],
    ['Joseph', 'Manalo', 'Ramirez', '9179012309', 'Southlake Manufacturing Corp.', 'Lot 8, Light Industry Park', 'Pittland', 'Cabuyao'],
    ['Liza', 'Pascual', 'Hernandez', '9260123410', null, 'Purok 3, Sitio Ilaya', 'Marinig', 'Cabuyao'],
];

// [name, category, qty owned, rental price, description]
const RENTAL_ITEMS = [
    ['Adjustable Balloon Arch Frame', 'Balloon Stand', 6, 800, 'Steel arch frame, adjustable from 2 to 3 meters wide.'],
    ['Round Backdrop Stand (2 m)', 'Backdrop', 5, 650, 'Circular metal backdrop frame with white spandex cover.'],
    ['Panel Backdrop Set (3 panels)', 'Backdrop', 3, 1500, 'Three arched wooden panels in white, for photo walls.'],
    ['Tiffany Chair (White)', 'Furniture', 120, 45, 'White resin Tiffany chair with seat cushion.'],
    ['Round Table (8-seater)', 'Furniture', 15, 250, '5 ft round banquet table, seats eight.'],
    ['Cake Table with Gold Rim', 'Furniture', 4, 500, 'Cylinder cake table with gold metal rim.'],
    ['Warm White Fairy Lights (10 m)', 'Lighting', 20, 120, 'Plug-in LED string lights for backdrops and ceilings.'],
    ['LED Marquee Letters "LOVE"', 'Signage', 2, 1200, 'Four 4-ft light-up letters.'],
    ['Neon Sign "Happy Birthday"', 'Signage', 3, 900, 'Pink LED neon sign on clear acrylic.'],
    ['Satin Tablecloth (White)', 'Linens', 40, 80, 'Round satin tablecloth for 5 ft tables.'],
    ['Gold Charger Plate', 'Tableware', 100, 15, '13-inch gold-beaded charger plate.'],
    ['Artificial Flower Wall Panel', 'Florals', 8, 450, '60 x 40 cm panel of white and blush silk roses.'],
    ['Pillar Balloon Stand', 'Balloon Stand', 10, 250, 'Weighted base with 1.5 m pole for balloon columns.'],
];
const ITEM = Object.fromEntries(RENTAL_ITEMS.map(([name], i) => [name, i + 1]));

// [name, unit, current level, reorder level, days since last restock]
const CONSUMABLES = [
    ['Latex Balloons 12" (100 pcs)', 'packs', 34, 10, 9],
    ['Chrome Gold Balloons 12" (50 pcs)', 'packs', 6, 8, 30],
    ['Foil Number Balloons 32"', 'pcs', 40, 15, 14],
    ['Balloon Decorating Strip', 'rolls', 12, 5, 9],
    ['Glue Dots', 'rolls', 3, 5, 45],
    ['Curling Ribbon', 'rolls', 25, 8, 20],
    ['Floral Foam Block', 'boxes', 9, 4, 14],
    ['Clear Fishing Line (50 m)', 'rolls', 14, 4, 20],
];
const CONSUMABLE = Object.fromEntries(CONSUMABLES.map(([name], i) => [name, i + 1]));

// [name, type, base price, description, [[item, qty], ...]]
const PACKAGES = [
    ['Classic Birthday Balloon Setup', 'Birthday', 8500,
        'Balloon arch, round backdrop with neon sign, cake table and two balloon pillars.',
        [['Adjustable Balloon Arch Frame', 1], ['Round Backdrop Stand (2 m)', 1], ['Neon Sign "Happy Birthday"', 1],
            ['Cake Table with Gold Rim', 1], ['Pillar Balloon Stand', 2]]],
    ['Debut Elegance Package', 'Debut', 25000,
        'Panel backdrop with flower walls, fairy lights, cake table and 18 chairs for the 18 roses.',
        [['Panel Backdrop Set (3 panels)', 1], ['Artificial Flower Wall Panel', 4], ['Warm White Fairy Lights (10 m)', 6],
            ['Cake Table with Gold Rim', 1], ['Tiffany Chair (White)', 18]]],
    ['Garden Wedding Styling', 'Wedding', 45000,
        'Flower-wall stage, LOVE marquee letters, and full styling for 96 guests: tables, linens, chairs and chargers.',
        [['Artificial Flower Wall Panel', 6], ['LED Marquee Letters "LOVE"', 1], ['Tiffany Chair (White)', 100],
            ['Round Table (8-seater)', 12], ['Satin Tablecloth (White)', 12], ['Gold Charger Plate', 96],
            ['Warm White Fairy Lights (10 m)', 10]]],
    ['Baptism Pastel Setup', 'Christening / Baptism', 12000,
        'Pastel balloon arch on a round backdrop, cake table, and five tables for 40 guests.',
        [['Round Backdrop Stand (2 m)', 1], ['Adjustable Balloon Arch Frame', 1], ['Cake Table with Gold Rim', 1],
            ['Round Table (8-seater)', 5], ['Tiffany Chair (White)', 40], ['Satin Tablecloth (White)', 5]]],
    ['Corporate Launch Backdrop', 'Corporate', 18000,
        'Branded panel backdrop with two balloon arches, lighting and four balloon pillars.',
        [['Panel Backdrop Set (3 panels)', 1], ['Adjustable Balloon Arch Frame', 2], ['Warm White Fairy Lights (10 m)', 4],
            ['Pillar Balloon Stand', 4]]],
    ['Gender Reveal Party Setup', 'Gender Reveal', 9500,
        'Pink-and-blue balloon arch on a round backdrop, two pillars and a cake table.',
        [['Round Backdrop Stand (2 m)', 1], ['Adjustable Balloon Arch Frame', 1], ['Pillar Balloon Stand', 2],
            ['Cake Table with Gold Rim', 1]]],
];
const PACKAGE = Object.fromEntries(PACKAGES.map(([name], i) => [name, i + 1]));

// Events, by days from today. `stage` decides the state of the item lines:
//   done     all returned          overdue  one line never came back
//   out      deployed, due back     pulled   some lines pulled for tomorrow
//   booked   reserved              cancelled released
// payments: [type, amount, method, days relative to the event date]
const EVENTS = [
    { client: 1, pkg: 'Classic Birthday Balloon Setup', type: 'Birthday', day: -38, time: '15:00', status: 'Completed', stage: 'done',
        venue: ['Santos Residence', 'Blk 4 Lot 12, Mabuhay City Subd.', 'Mamatid', 'Cabuyao'],
        notes: 'Theme: pink and gold, 7th birthday. Set up by 12 NN.',
        consumables: [['Latex Balloons 12" (100 pcs)', 3], ['Foil Number Balloons 32"', 2]],
        payments: [['downpayment', 4250, 'Cash', -20], ['balance', 4250, 'GCash', -1]] },
    { client: 4, pkg: 'Corporate Launch Backdrop', type: 'Corporate', day: -27, time: '09:00', status: 'Completed', stage: 'done',
        venue: ['Casa Laguna Events Place', 'Km. 43 National Highway', 'Banay-Banay', 'Cabuyao'],
        notes: 'Dizon Hardware 10th anniversary. Company logo on the center panel (client provides tarpaulin).',
        damaged: 'Adjustable Balloon Arch Frame',
        payments: [['downpayment', 9000, 'Bank Transfer', -21], ['balance', 9000, 'Bank Transfer', -2], ['damage_fee', 1500, 'Cash', 2]] },
    { client: 7, pkg: 'Gender Reveal Party Setup', type: 'Gender Reveal', day: -15, time: '16:00', status: 'Completed', stage: 'done', source: 'online',
        venue: ['Aguilar Residence', '7 Mabini St.', 'Real', 'Calamba'],
        consumables: [['Latex Balloons 12" (100 pcs)', 2], ['Chrome Gold Balloons 12" (50 pcs)', 1]],
        payments: [['downpayment', 4750, 'GCash', -10], ['balance', 4750, 'Cash', 0]] },
    { client: 2, pkg: 'Baptism Pastel Setup', type: 'Christening / Baptism', day: -6, time: '11:00', status: 'Approved', stage: 'done',
        venue: ['St. Polycarp Parish Hall', 'J.P. Rizal St.', 'Poblacion Uno', 'Cabuyao'],
        payments: [['downpayment', 6000, 'GCash', -14], ['balance', 6000, 'Cash', -1]] },
    { client: 3, pkg: 'Classic Birthday Balloon Setup', type: 'Birthday', day: -4, time: '14:00', status: 'Approved', stage: 'overdue',
        extras: [['Warm White Fairy Lights (10 m)', 4]],
        venue: ['Southville 1 Clubhouse', 'Phase 2, Southville 1', 'Pulo', 'Cabuyao'],
        consumables: [['Latex Balloons 12" (100 pcs)', 3], ['Foil Number Balloons 32"', 1]],
        payments: [['downpayment', 4490, 'GCash', -12]] },
    { client: 10, pkg: null, type: 'Birthday', day: -1, time: '10:00', status: 'Approved', stage: 'out', contract: 3500,
        custom: 'Simple pastel balloon garland on two pillars for a 1st birthday, plus one balloon arch at the entrance.',
        extras: [['Pillar Balloon Stand', 2], ['Adjustable Balloon Arch Frame', 1]],
        venue: ['Barangay Marinig Covered Court', 'Purok 3', 'Marinig', 'Cabuyao'],
        payments: [['downpayment', 1750, 'Cash', -7]] },
    { client: 5, pkg: 'Debut Elegance Package', type: 'Debut', day: 1, time: '18:00', status: 'Approved', stage: 'pulled',
        venue: ['The Glasshouse Events Venue', 'Sta. Rosa-Tagaytay Rd.', 'Balibago', 'Santa Rosa'],
        notes: 'Color motif: champagne and blush. 18 chairs for the roses ceremony on stage left.',
        consumables: [['Latex Balloons 12" (100 pcs)', 4], ['Chrome Gold Balloons 12" (50 pcs)', 2], ['Balloon Decorating Strip', 2]],
        payments: [['downpayment', 12500, 'GCash', -25]] },
    { client: 6, pkg: 'Garden Wedding Styling', type: 'Wedding', day: 4, time: '15:30', status: 'Approved', stage: 'booked',
        venue: ['Villa Olympia Garden Pavilion', 'Villa Olympia', 'San Antonio', 'San Pedro'],
        notes: 'Ceremony and reception in the same garden. Ingress allowed from 8 AM.',
        consumables: [['Floral Foam Block', 3], ['Clear Fishing Line (50 m)', 2]],
        payments: [['downpayment', 22500, 'Bank Transfer', -40], ['deposit', 5000, 'Cash', -40]] },
    { client: 8, pkg: 'Gender Reveal Party Setup', type: 'Gender Reveal', day: 16, time: '17:00', status: 'Pending', stage: 'booked', source: 'online',
        venue: ['Ocampo Residence', 'Blk 12 Lot 9, Ciudad de Calamba', 'Paciano Rizal', 'Calamba'],
        notes: 'Online order. Asked if the arch can be half pink, half blue.', receivedHoursAgo: 3 },
    { client: 9, pkg: 'Corporate Launch Backdrop', type: 'Corporate', day: 24, time: '08:00', status: 'Approved', stage: 'booked',
        venue: ['Southlake Manufacturing Plant Lobby', 'Lot 8, Light Industry Park', 'Pittland', 'Cabuyao'],
        notes: 'Product launch. Security clearance list needed 2 days before.',
        consumables: [['Latex Balloons 12" (100 pcs)', 5], ['Balloon Decorating Strip', 2]],
        payments: [['downpayment', 9000, 'Bank Transfer', -10]] },
    { client: 1, pkg: 'Baptism Pastel Setup', type: 'Christening / Baptism', day: 35, time: '10:00', status: 'Pending', stage: 'booked',
        venue: ['Our Lady of Fatima Chapel Hall', 'Mabuhay City Subd.', 'Mamatid', 'Cabuyao'],
        notes: 'Repeat client. Wants the same pastel colors as last time.', receivedHoursAgo: 26 },
    { client: 2, pkg: 'Classic Birthday Balloon Setup', type: 'Birthday', day: 12, time: '13:00', status: 'Cancelled', stage: 'cancelled',
        venue: ['Villanueva Residence', '23 Rizal St.', 'Poblacion Uno', 'Cabuyao'],
        notes: 'Cancelled by the client: party moved to a restaurant.' },
];

const PROVINCE = 'Laguna';

// "YYYY-MM-DD HH:MM:SS" arithmetic on the database's clock, without the server's timezone.
const shiftTime = (datetime, hours) =>
    new Date(Date.parse(`${datetime.replace(' ', 'T')}Z`) + hours * 3600000).toISOString().slice(0, 19).replace('T', ' ');
const at = (date, time = '09:00') => `${date} ${time}:00`;

// GCash and bank transfers come with a reference number; cash doesn't.
function reference(method, n) {
    if (method === 'GCash') return `GC${String(4021337000 + n * 7919).padStart(10, '0')}`;
    if (method === 'Bank Transfer') return `BDO-${String(560100 + n * 37)}`;
    return null;
}

// One multi-row INSERT per table, with explicit ids so the sample always numbers from 1.
async function insertRows(conn, table, columns, rows) {
    if (!rows.length) return 0;
    const tuple = `(${columns.map(() => '?').join(', ')})`;
    await conn.query(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${rows.map(() => tuple).join(', ')}`,
        rows.flat()
    );
    return rows.length;
}

function buildRows(today, now) {
    const rows = {};

    rows.clients = CLIENTS.map(([first, middle, last, phone, billing, street, barangay, city], i) => [
        i + 1, first, middle, last, '+63', phone,
        `${first.split(' ')[0]}.${last}`.toLowerCase().replace(/[^a-z.]/g, '') + '@example.com',
        billing, street, barangay, city, PROVINCE, at(addDays(today, -75 + i * 3)),
    ]);

    // A damaged arch from an earlier event is out of service until it's fixed.
    const damaged = new Set(EVENTS.filter((e) => e.damaged).map((e) => e.damaged));
    rows.rental_items = RENTAL_ITEMS.map(([name, category, qty, price, description], i) => [
        i + 1, `RNT-${String(i + 1).padStart(4, '0')}`, name, category, qty, price,
        damaged.has(name) ? 'Good (1 unit under repair)' : 'Good', damaged.has(name) ? 1 : 0, description,
    ]);

    rows.consumables = CONSUMABLES.map(([name, unit, level, reorder, restocked], i) => [
        i + 1, `CNS-${String(i + 1).padStart(4, '0')}`, name, unit, level, reorder, at(addDays(today, -restocked), '10:00'),
    ]);

    rows.packages = PACKAGES.map(([name, type, price, description], i) => [i + 1, name, type, description, price]);
    rows.package_items = PACKAGES.flatMap(([, , , , items], p) => items.map(([item, qty]) => [p + 1, ITEM[item], qty]))
        .map((r, i) => [i + 1, ...r]);

    rows.events = [];
    rows.event_items = [];
    rows.event_consumables = [];
    rows.payments = [];
    rows.return_logs = [];
    rows.notifications = [];

    EVENTS.forEach((e, i) => {
        const id = i + 1;
        const date = addDays(today, e.day);
        const due = addDays(date, 1);
        const pkg = e.pkg ? PACKAGES[PACKAGE[e.pkg] - 1] : null;
        const lines = [...(pkg ? pkg[4] : []), ...(e.extras ?? [])];
        const extrasPrice = (e.extras ?? []).reduce((sum, [item, qty]) => sum + RENTAL_ITEMS[ITEM[item] - 1][3] * qty, 0);
        const contract = e.contract ?? (pkg ? pkg[2] : 0) + extrasPrice;
        const created = e.receivedHoursAgo ? shiftTime(now, -e.receivedHoursAgo) : at(addDays(date, -45 + i), '09:15');
        const client = CLIENTS[e.client - 1];

        rows.events.push([
            id, e.client, pkg ? PACKAGE[e.pkg] : null, e.type, e.source ?? 'admin', e.custom ?? null, date, `${e.time}:00`,
            e.venue[0], e.venue[1], e.venue[2], e.venue[3], PROVINCE, e.status, contract, e.notes ?? null, created,
        ]);

        lines.forEach(([item, qty], n) => {
            const lineId = rows.event_items.length + 1;
            let pull = 'Packed';
            let ret = 'Pending';
            if (e.stage === 'done') ret = item === e.damaged ? 'Damaged' : 'Returned';
            if (e.stage === 'overdue') ret = item === 'Pillar Balloon Stand' ? 'Pending' : 'Returned';
            if (e.stage === 'pulled') pull = n < 2 ? 'Pulled' : 'Pending';
            if (e.stage === 'booked' || e.stage === 'cancelled') pull = 'Pending';
            const reserved = ret === 'Pending' && e.stage !== 'cancelled';
            rows.event_items.push([lineId, id, ITEM[item], qty, reserved, due, ret, pull]);

            if (ret === 'Returned') {
                rows.return_logs.push([rows.return_logs.length + 1, lineId, at(due, '10:00'), 'Good', 0]);
            } else if (ret === 'Damaged') {
                rows.return_logs.push([rows.return_logs.length + 1, lineId, at(due, '10:00'), 'Damaged (1 unit): bent frame joint', 1500]);
            }
        });

        for (const [name, qty] of e.consumables ?? []) {
            rows.event_consumables.push([rows.event_consumables.length + 1, id, CONSUMABLE[name], qty]);
        }

        for (const [type, amount, method, day] of e.payments ?? []) {
            const n = rows.payments.length + 1;
            rows.payments.push([n, id, type, amount, method, at(addDays(date, day), '14:30'), reference(method, n)]);
        }

        if (e.status === 'Pending') {
            const name = [client[0], client[1], client[2]].join(' ');
            rows.notifications.push([rows.notifications.length + 1, `New inquiry: ${name} for ${date} (event #${id})`,
                'new_inquiry', id, false, null, created]);
        }
    });

    return rows;
}

const COLUMNS = {
    clients: ['client_id', 'first_name', 'middle_name', 'last_name', 'phone_country_code', 'phone_number', 'email',
        'billing_name', 'street', 'barangay', 'city_municipality', 'province', 'created_at'],
    rental_items: ['item_id', 'item_code', 'name', 'category', 'qty_total', 'rental_price', 'item_condition', 'qty_out_of_service', 'description'],
    consumables: ['consumable_id', 'item_code', 'name', 'unit', 'current_level', 'reorder_level', 'last_restocked_at'],
    packages: ['package_id', 'name', 'type', 'description', 'base_price'],
    package_items: ['package_item_id', 'package_id', 'item_id', 'qty'],
    events: ['event_id', 'client_id', 'package_id', 'event_type', 'source', 'custom_order', 'event_date', 'start_time', 'venue_name',
        'venue_street', 'venue_barangay', 'venue_city_municipality', 'venue_province', 'status', 'contract_value', 'setup_notes', 'created_at'],
    event_items: ['event_item_id', 'event_id', 'item_id', 'qty', 'is_reserved', 'return_due_date', 'return_status', 'pull_status'],
    event_consumables: ['id', 'event_id', 'consumable_id', 'qty_used'],
    payments: ['payment_id', 'event_id', 'type', 'amount', 'method', 'paid_at', 'reference_no'],
    return_logs: ['return_id', 'event_item_id', 'returned_at', 'condition_on_return', 'damage_fee'],
    notifications: ['notification_id', 'message', 'type', 'event_id', 'is_read', 'ref_key', 'created_at'],
};

// Parents before children.
const INSERT_ORDER = ['clients', 'rental_items', 'consumables', 'packages', 'package_items', 'events', 'event_items',
    'event_consumables', 'payments', 'return_logs', 'notifications'];

// Replaces all business data with the sample set. `conn` must be inside a transaction, so a
// failure leaves the old data untouched. Returns the number of rows inserted per table.
async function generateSampleData(conn) {
    const [{ today, now }] = await conn.query('SELECT CURDATE() AS today, NOW() AS now');
    // Customer logins go with their clients; staff and admin accounts stay.
    await conn.query("DELETE FROM users WHERE role = 'customer'");
    for (const table of WIPE_ORDER) await conn.query(`DELETE FROM ${table}`);

    const rows = buildRows(today, now);
    const counts = {};
    for (const table of INSERT_ORDER) counts[table] = await insertRows(conn, table, COLUMNS[table], rows[table]);

    const hash = await hashPassword(DEMO_CUSTOMER_PASSWORD);
    counts.users = await insertRows(conn, 'users', ['password_hash', 'role', 'client_id'],
        CUSTOMER_ACCOUNTS.map((clientId) => [hash, 'customer', clientId]));
    return counts;
}

// Run after the transaction commits (ALTER TABLE would commit it early). Sets each table's
// next id to just after the sample rows, so new records continue the numbering.
async function resetIds(db) {
    for (const table of INSERT_ORDER) await db.query(`ALTER TABLE ${table} AUTO_INCREMENT = 1`);
}

/* ---------- starter catalog ---------- */
// The admin's "Add starter items" / "Add starter packages" buttons. Unlike generateSampleData,
// these only add: the standard rental items, consumables and packages above, skipping any
// already there by name (an archived one is restored instead). Nothing else is touched.

// Finds a record by name (any case); restores it if archived. Returns its id, or null if absent.
async function existing(conn, table, idColumn, name) {
    const [row] = await conn.query(`SELECT ${idColumn} AS id, is_deleted FROM ${table} WHERE name = ?`, [name]);
    if (row?.is_deleted) await conn.query(`UPDATE ${table} SET is_deleted = 0 WHERE ${idColumn} = ?`, [row.id]);
    return row ? { id: row.id, restored: Boolean(row.is_deleted) } : null;
}

// Adds the rental items named (all of them by default). Returns name -> item id and the counts.
async function addStarterItems(conn, names = RENTAL_ITEMS.map(([name]) => name)) {
    const ids = {};
    const counts = { added: 0, restored: 0, skipped: 0 };
    for (const [name, category, qty, price, description] of RENTAL_ITEMS.filter(([n]) => names.includes(n))) {
        const found = await existing(conn, 'rental_items', 'item_id', name);
        if (found) {
            ids[name] = found.id;
            counts[found.restored ? 'restored' : 'skipped'] += 1;
            continue;
        }
        const r = await conn.query(
            "INSERT INTO rental_items (name, category, qty_total, rental_price, item_condition, description) VALUES (?, ?, ?, ?, 'Good', ?)",
            [name, category, qty, price, description]
        );
        await assignCode(conn, 'rental_items', 'item_id', r.insertId, 'RNT');
        ids[name] = r.insertId;
        counts.added += 1;
    }
    return { ids, counts };
}

async function addStarterConsumables(conn) {
    const counts = { added: 0, restored: 0, skipped: 0 };
    for (const [name, unit, level, reorder] of CONSUMABLES) {
        const found = await existing(conn, 'consumables', 'consumable_id', name);
        if (found) { counts[found.restored ? 'restored' : 'skipped'] += 1; continue; }
        const r = await conn.query(
            'INSERT INTO consumables (name, unit, current_level, reorder_level, last_restocked_at) VALUES (?, ?, ?, ?, NOW())',
            [name, unit, level, reorder]
        );
        await assignCode(conn, 'consumables', 'consumable_id', r.insertId, 'CNS');
        counts.added += 1;
    }
    return counts;
}

// Packages with their item lists; the rental items they need are added first if missing.
async function addStarterPackages(conn) {
    const needed = [...new Set(PACKAGES.flatMap(([, , , , items]) => items.map(([item]) => item)))];
    const { ids, counts: items } = await addStarterItems(conn, needed);
    const counts = { added: 0, restored: 0, skipped: 0 };
    for (const [name, type, price, description, lines] of PACKAGES) {
        const found = await existing(conn, 'packages', 'package_id', name);
        if (found) { counts[found.restored ? 'restored' : 'skipped'] += 1; continue; }
        const r = await conn.query('INSERT INTO packages (name, type, description, base_price) VALUES (?, ?, ?, ?)', [name, type, description, price]);
        await insertRows(conn, 'package_items', ['package_id', 'item_id', 'qty'], lines.map(([item, qty]) => [r.insertId, ids[item], qty]));
        counts.added += 1;
    }
    return { packages: counts, items };
}

// "Added 13 items, 8 consumables; 2 already there" style summary.
function describeCounts(parts) {
    const n = (count, what) => `${count} ${count === 1 ? what.replace(/s$/, '') : what}`;
    const done = parts.flatMap(([what, c]) => [
        c.added ? `added ${n(c.added, what)}` : null,
        c.restored ? `restored ${n(c.restored, `archived ${what}`)}` : null,
    ]).filter(Boolean);
    const skipped = parts.reduce((s, [, c]) => s + c.skipped, 0);
    const text = done.length ? done.join('; ') : 'nothing new to add';
    return `${text[0].toUpperCase()}${text.slice(1)}${skipped ? ` (${skipped} already there)` : ''}`;
}

module.exports = { generateSampleData, resetIds, addStarterItems, addStarterConsumables, addStarterPackages, describeCounts };
