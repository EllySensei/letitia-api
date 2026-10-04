const express = require('express');
const db = require('../lib/db');
const { HttpError } = require('../lib/errors');
const { validate, paging, str, int, money, oneOf } = require('../lib/validate');
const { PAID, cents } = require('../lib/sql');

const router = express.Router();

// downpayment and balance count toward the contract; the rest are tracked alongside it.
const TYPES = ['downpayment', 'balance', 'deposit', 'damage_fee', 'refund'];

router.get('/', async (req, res) => {
    const { event_id, type, limit, offset } = validate(req.query, {
        event_id: int({ min: 1 }),
        type: oneOf(TYPES),
        ...paging,
    });
    const where = [];
    const params = [];
    if (event_id) { where.push('p.event_id = ?'); params.push(event_id); }
    if (type) { where.push('p.type = ?'); params.push(type); }
    const rows = await db.query(
        `SELECT p.payment_id, p.event_id, c.full_name AS client_name, p.type, p.amount, p.method, p.paid_at, p.reference_no
         FROM payments p JOIN events e ON e.event_id = p.event_id JOIN clients c ON c.client_id = e.client_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY p.paid_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );
    res.json(rows);
});

router.post('/', async (req, res) => {
    const input = validate(req.body, {
        event_id: int({ required: true, min: 1 }),
        type: oneOf(TYPES, { required: true }),
        amount: money({ required: true, min: 0.01 }),
        method: str({ max: 50 }),
        reference_no: str({ max: 100 }),
    });

    const payment = await db.transaction(async (conn) => {
        // Lock the event so two payments can't both fit under the same remaining balance.
        const [event] = await conn.query(
            `SELECT e.status, e.contract_value, ${PAID} AS paid FROM events e WHERE e.event_id = ? FOR UPDATE`,
            [input.event_id]
        );
        if (!event) throw new HttpError(400, `Event ${input.event_id} does not exist`);

        if (input.type === 'downpayment' || input.type === 'balance') {
            if (event.status === 'Cancelled') throw new HttpError(409, 'Cannot take contract payments for a cancelled event');
            const remaining = cents(event.contract_value) - cents(event.paid);
            if (remaining <= 0) throw new HttpError(409, 'This event is already fully paid');
            if (cents(input.amount) > remaining) {
                throw new HttpError(409, `Amount exceeds the remaining balance of ${(remaining / 100).toFixed(2)}`);
            }
        }

        const result = await conn.query(
            'INSERT INTO payments (event_id, type, amount, method, reference_no) VALUES (?, ?, ?, ?, ?)',
            [input.event_id, input.type, input.amount, input.method ?? null, input.reference_no ?? null]
        );
        const [row] = await conn.query(
            `SELECT p.*, e.contract_value, ${PAID} AS paid_amount
             FROM payments p JOIN events e ON e.event_id = p.event_id WHERE p.payment_id = ?`,
            [result.insertId]
        );
        return row;
    });

    payment.remaining = Math.max(cents(payment.contract_value) - cents(payment.paid_amount), 0) / 100;
    res.status(201).json(payment);
});

module.exports = router;
