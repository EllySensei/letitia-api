// What a customer may see about their own bookings: shared by order tracking
// (routes/public.js) and the customer account (routes/account.js).
const db = require('./db');
const { EVENT_STATUS, PAID, REMAINING, VENUE_ADDRESS } = require('./sql');

const ORDER_SELECT = `
    SELECT e.event_id, e.event_type, e.event_date, e.start_time, ${VENUE_ADDRESS} AS venue_address, ${EVENT_STATUS} AS status,
           p.name AS package_name, e.custom_order, e.contract_value,
           ${PAID} AS paid_amount, ${REMAINING} AS remaining, e.created_at
    FROM events e LEFT JOIN packages p ON p.package_id = e.package_id`;

async function withItems(orders) {
    if (!orders.length) return orders;
    const items = await db.query(
        `SELECT ei.event_id, ri.name, ei.qty FROM event_items ei JOIN rental_items ri ON ri.item_id = ei.item_id
         WHERE ei.event_id IN (?) ORDER BY ri.name`,
        [orders.map((o) => o.event_id)]
    );
    for (const o of orders) o.items = items.filter((i) => i.event_id === o.event_id).map(({ name, qty }) => ({ name, qty }));
    return orders;
}

async function orderSummary(id) {
    const [order] = await withItems(await db.query(`${ORDER_SELECT} WHERE e.event_id = ?`, [id]));
    return order;
}

// A client's bookings, newest event first.
const clientOrders = async (clientId) =>
    withItems(await db.query(`${ORDER_SELECT} WHERE e.client_id = ? ORDER BY e.event_date DESC, e.event_id DESC`, [clientId]));

module.exports = { orderSummary, clientOrders };
