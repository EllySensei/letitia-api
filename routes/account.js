// Customer accounts on the storefront: their details, bookings and payments, and placing an order.
// Ordering needs a login, so every booking belongs to the client the account is linked to.
const express = require('express');
const db = require('../lib/db');
const { HttpError } = require('../lib/errors');
const { validate, nameFields, addressFields, str, phone, int, date, time, list } = require('../lib/validate');
const { ADDRESS_PARTS, CLIENT_NAME, CLIENT_PHONE, CLIENT_ADDRESS } = require('../lib/sql');
const { insertBooking } = require('../lib/bookings');
const { orderSummary, clientOrders } = require('../lib/orders');
const { rateLimit } = require('../lib/rateLimit');
const { requireAuth, requireCustomer, verifyPassword, hashPassword, revoke } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth, requireCustomer);

router.get('/profile', async (req, res) => {
    const [client] = await db.query(
        `SELECT c.client_id, c.first_name, c.middle_name, c.last_name, ${CLIENT_NAME} AS full_name, c.email,
                ${CLIENT_PHONE} AS phone, c.phone_country_code, c.phone_number,
                ${CLIENT_ADDRESS} AS address, c.street, c.barangay, c.city_municipality, c.province
         FROM clients c WHERE c.client_id = ?`,
        [req.user.client_id]
    );
    res.json(client);
});

// Deletes the customer's own login, after checking their password. Their bookings stay with the
// business (and can still be tracked by reference number); a client who never booked is removed too.
router.delete('/', async (req, res) => {
    const { password } = validate(req.body, { password: str({ required: true, max: 200 }) });
    const { user_id: userId, client_id: clientId } = req.user;
    const [row] = await db.query('SELECT password_hash FROM users WHERE user_id = ?', [userId]);
    if (!(await verifyPassword(password, row?.password_hash))) throw new HttpError(401, 'That password is not correct');

    const keptBookings = await db.transaction(async (conn) => {
        await conn.query('DELETE FROM users WHERE user_id = ?', [userId]);
        const [{ n }] = await conn.query('SELECT COUNT(*) AS n FROM events WHERE client_id = ?', [clientId]);
        if (!n) await conn.query('DELETE FROM clients WHERE client_id = ?', [clientId]);
        return n;
    });
    revoke(req.token);
    res.json({
        message: keptBookings
            ? 'Your account is deleted. Your bookings stay with us, and you can still track them by reference number.'
            : 'Your account and details are deleted.',
    });
});

// The customer edits their own details. Email stays: it's what they log in with.
router.patch('/profile', async (req, res) => {
    const input = validate(req.body, {
        ...nameFields(),
        phone: phone({ required: true }),
        ...addressFields('', { required: false }),
    }, { partial: true });
    const { phone: phoneParts, ...rest } = input;
    const fields = { ...rest, ...phoneParts };
    if (!Object.keys(fields).length) throw new HttpError(400, 'No fields to update');
    await db.query(
        `UPDATE clients SET ${Object.keys(fields).map((f) => `${f} = ?`).join(', ')} WHERE client_id = ?`,
        [...Object.values(fields), req.user.client_id]
    );
    res.json({ message: 'Your details are saved' });
});

router.patch('/password', async (req, res) => {
    const { current_password: current, new_password: next } = validate(req.body, {
        current_password: str({ required: true, max: 200 }),
        new_password: str({ required: true, max: 200 }),
    });
    if (next.length < 8) throw new HttpError(400, 'Validation failed', [{ field: 'new_password', message: 'new password must be at least 8 characters' }]);
    const [row] = await db.query('SELECT password_hash FROM users WHERE user_id = ?', [req.user.user_id]);
    if (!(await verifyPassword(current, row?.password_hash))) throw new HttpError(401, 'Your current password is not correct');
    await db.query('UPDATE users SET password_hash = ? WHERE user_id = ?', [await hashPassword(next), req.user.user_id]);
    res.json({ message: 'Your password is changed' });
});

// Every payment on the customer's bookings, newest first.
router.get('/payments', async (req, res) => {
    res.json(await db.query(
        `SELECT p.payment_id, p.event_id, p.type, p.amount, p.method, p.paid_at, p.reference_no,
                e.event_date, e.event_type, COALESCE(pk.name, 'Custom order') AS package_name
         FROM payments p JOIN events e ON e.event_id = p.event_id LEFT JOIN packages pk ON pk.package_id = e.package_id
         WHERE e.client_id = ? ORDER BY p.paid_at DESC, p.payment_id DESC`,
        [req.user.client_id]
    ));
});

router.get('/orders', async (req, res) => {
    res.json(await clientOrders(req.user.client_id));
});

const orderSchema = {
    purpose: str({ required: true, max: 60 }),
    event_date: date({ required: true }),
    start_time: time(),
    street: str({ required: true, max: 150 }),
    barangay: str({ required: true, max: 100 }),
    city: str({ required: true, max: 100 }),
    province: str({ required: true, max: 100 }),
    notes: str({ max: 2000 }),
    package_id: int({ min: 1 }),
    items: list({ item_id: int({ required: true, min: 1 }), qty: int({ required: true, min: 1, max: 10000 }) }, { max: 50 }),
};

// Orders arrive as Pending events for an admin to approve.
router.post('/orders', rateLimit(20, 60 * 60 * 1000, 'Too many orders from this connection, please try again later'), async (req, res) => {
    const input = validate(req.body, orderSchema);
    const items = input.items ?? [];
    const custom = !input.package_id && !items.length;
    if (custom && (input.notes ?? '').length < 15) {
        throw new HttpError(400, 'Describe your custom order in the notes (at least 15 characters)');
    }
    const venue = { street: input.street, barangay: input.barangay, city_municipality: input.city, province: input.province };
    const clientId = req.user.client_id;

    const eventId = await db.transaction(async (conn) => {
        // An archived client ordering again comes back; a client with no address on file gets the venue's.
        await conn.query('UPDATE clients SET is_deleted = 0 WHERE client_id = ? AND is_deleted = 1', [clientId]);
        await conn.query(
            `UPDATE clients SET ${ADDRESS_PARTS.map((part) => `${part} = ?`).join(', ')}
             WHERE client_id = ? AND ${ADDRESS_PARTS.map((part) => `COALESCE(${part}, '') = ''`).join(' AND ')}`,
            [...ADDRESS_PARTS.map((part) => venue[part]), clientId]
        );

        return insertBooking(conn, {
            client_id: clientId,
            package_id: input.package_id,
            event_type: input.purpose,
            source: 'online',
            custom_order: input.package_id ? undefined : (custom ? input.notes : 'Rental items only'),
            event_date: input.event_date,
            start_time: input.start_time,
            ...Object.fromEntries(ADDRESS_PARTS.map((part) => [`venue_${part}`, venue[part]])),
            setup_notes: custom ? undefined : input.notes,
            status: 'Pending',
            items,
        }, { notice: `New online order: ${req.user.full_name} for ${input.event_date}` });
    });

    res.status(201).json(await orderSummary(eventId));
});

module.exports = router;
