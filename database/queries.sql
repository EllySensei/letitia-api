-- =====================================================================================
-- Laetitia: SQL Query Demonstration (CCS110 Part II, item 3.3)
--
-- Run against the sample data (Database tab > Generate sample data, or database/laetitia.sql).
-- Event dates in the sample are relative to the day it was generated, so dates in the
-- expected outputs below will differ; names, counts and amounts will match.
-- =====================================================================================

USE laetitia;


-- -------------------------------------------------------------------------------------
-- 1. SELECT: list all active clients, sorted by last name
-- Purpose : the client list shown in Payments & Clients.
-- Expected: 10 rows, from Aquino/Dizon ... to Villanueva. Archived clients (is_deleted = 1)
--           are left out.
-- -------------------------------------------------------------------------------------
SELECT client_id, first_name, last_name, CONCAT(phone_country_code, ' ', phone_number) AS phone, city_municipality
FROM clients
WHERE is_deleted = 0
ORDER BY last_name, first_name;


-- -------------------------------------------------------------------------------------
-- 2. INSERT: add a new client
-- Purpose : what the "Add new Client" form does when it is saved.
-- Expected: "1 row affected". The new client gets the next client_id (11).
-- -------------------------------------------------------------------------------------
INSERT INTO clients (first_name, middle_name, last_name, phone_country_code, phone_number, email,
                     street, barangay, city_municipality, province)
VALUES ('Andrea', 'Lopez', 'Mercado', '+63', '9171112233', 'andrea.mercado@example.com',
        '12 Burgos St.', 'Sala', 'Cabuyao', 'Laguna');

SELECT client_id, first_name, last_name, email FROM clients WHERE email = 'andrea.mercado@example.com';


-- -------------------------------------------------------------------------------------
-- 3. UPDATE: change the new client's phone number
-- Purpose : what "Edit" > "Save Changes" does on a client.
-- Expected: "1 row affected"; the SELECT shows the new number 9184445566.
-- -------------------------------------------------------------------------------------
UPDATE clients
SET phone_number = '9184445566'
WHERE email = 'andrea.mercado@example.com';

SELECT client_id, first_name, last_name, phone_number FROM clients WHERE email = 'andrea.mercado@example.com';


-- -------------------------------------------------------------------------------------
-- 4. UPDATE: approve a pending online inquiry
-- Purpose : the "Approve" button on the dashboard's New Orders & Inquiries list.
-- Expected: "1 row affected"; event 9 (Bea Nicole Ocampo's gender reveal) becomes Approved.
-- -------------------------------------------------------------------------------------
UPDATE events SET status = 'Approved' WHERE event_id = 9 AND status = 'Pending';

SELECT event_id, event_type, event_date, status FROM events WHERE event_id = 9;


-- -------------------------------------------------------------------------------------
-- 5. DELETE: remove the client added in query 2
-- Purpose : permanently removes a record that nothing else refers to.
-- Expected: "1 row affected"; the SELECT afterwards returns an empty set.
-- -------------------------------------------------------------------------------------
DELETE FROM clients WHERE email = 'andrea.mercado@example.com';

SELECT client_id FROM clients WHERE email = 'andrea.mercado@example.com';


-- -------------------------------------------------------------------------------------
-- 6. DELETE blocked by a foreign key
-- Purpose : shows referential integrity. Client 1 has events, and events.client_id is a
--           FOREIGN KEY ... ON DELETE RESTRICT, so the database refuses.
-- Expected: ERROR 1451 (23000): Cannot delete or update a parent row: a foreign key
--           constraint fails (... CONSTRAINT `fk_events_client` ...). Nothing is deleted.
--           (This is why the app archives clients instead of deleting them.)
-- -------------------------------------------------------------------------------------
-- DELETE FROM clients WHERE client_id = 1;   -- uncomment to see the error


-- =====================================================================================
-- Advanced queries (WHERE + ORDER BY + JOIN / GROUP BY)
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- 7. JOIN + WHERE + ORDER BY: upcoming bookings with client and package
-- Purpose : the Upcoming Events list. Joins 3 tables; LEFT JOIN keeps custom orders that
--           have no package.
-- Expected: 5 rows, the events from today onward that aren't cancelled, earliest first:
--           Patricia Mae Lim (Debut), Jerome Navarro (Wedding), Bea Nicole Ocampo (Gender
--           Reveal), Joseph Ramirez (Corporate), Angelica Santos (Baptism), with their packages.
-- -------------------------------------------------------------------------------------
SELECT e.event_id, e.event_date, e.start_time,
       CONCAT(c.first_name, ' ', c.last_name) AS client,
       e.event_type, COALESCE(p.name, 'Custom order') AS package,
       e.venue_name, e.status
FROM events e
JOIN clients c ON c.client_id = e.client_id
LEFT JOIN packages p ON p.package_id = e.package_id
WHERE e.event_date >= CURDATE()
  AND e.status <> 'Cancelled'
ORDER BY e.event_date, e.start_time;


-- -------------------------------------------------------------------------------------
-- 8. JOIN + GROUP BY + ORDER BY: bookings and sales per package
-- Purpose : a sales report: which packages sell best. Cancelled events don't count.
-- Expected: 6 rows (one per package), highest total first:
--           Garden Wedding Styling 1 booking 45,000.00; Corporate Launch Backdrop 2 / 36,000.00;
--           Debut Elegance Package 1 / 25,000.00; Baptism Pastel Setup 2 / 24,000.00;
--           Gender Reveal Party Setup 2 / 19,000.00; Classic Birthday Balloon Setup 2 / 17,480.00.
-- -------------------------------------------------------------------------------------
SELECT p.name AS package, p.type,
       COUNT(e.event_id) AS bookings,
       SUM(e.contract_value) AS total_sales
FROM packages p
JOIN events e ON e.package_id = p.package_id
WHERE e.status <> 'Cancelled'
GROUP BY p.package_id, p.name, p.type
ORDER BY total_sales DESC;


-- -------------------------------------------------------------------------------------
-- 9. JOIN + GROUP BY + HAVING: clients who still owe money
-- Purpose : the Payment Pending / receivables report. Only downpayments and balance
--           payments count toward the contract (deposits and damage fees don't).
-- Expected: 7 clients with a balance, biggest first, starting with Jerome Navarro
--           (45,000.00 contract, 22,500.00 paid, 22,500.00 balance).
-- -------------------------------------------------------------------------------------
SELECT c.client_id, CONCAT(c.first_name, ' ', c.last_name) AS client,
       SUM(e.contract_value) AS total_contract,
       SUM(COALESCE(paid.amount, 0)) AS total_paid,
       SUM(e.contract_value - COALESCE(paid.amount, 0)) AS balance
FROM clients c
JOIN events e ON e.client_id = c.client_id
LEFT JOIN (
    SELECT event_id, SUM(amount) AS amount
    FROM payments
    WHERE type IN ('downpayment', 'balance')
    GROUP BY event_id
) paid ON paid.event_id = e.event_id
WHERE e.status <> 'Cancelled'
GROUP BY c.client_id, c.first_name, c.last_name
HAVING balance > 0
ORDER BY balance DESC;


-- -------------------------------------------------------------------------------------
-- 10. Many-to-many through a junction table: what is inside each package
-- Purpose : packages and rental_items are many-to-many; package_items resolves it.
-- Expected: 31 rows. Example: "Classic Birthday Balloon Setup" contains the balloon arch
--           frame x1, cake table x1, neon sign x1, pillar balloon stand x2 and round backdrop x1.
-- -------------------------------------------------------------------------------------
SELECT p.name AS package, r.item_code, r.name AS item, pi.qty
FROM package_items pi
JOIN packages p ON p.package_id = pi.package_id
JOIN rental_items r ON r.item_id = pi.item_id
ORDER BY p.name, r.name;


-- -------------------------------------------------------------------------------------
-- 11. GROUP BY + ORDER BY: most rented items
-- Purpose : shows which decor is in highest demand across all non-cancelled bookings.
-- Expected: 13 rows, most units first: Tiffany Chair (White) 198 units over 4 events,
--           Gold Charger Plate 96, Warm White Fairy Lights 28, ...
-- -------------------------------------------------------------------------------------
SELECT r.item_code, r.name, r.category,
       COUNT(DISTINCT ei.event_id) AS events,
       SUM(ei.qty) AS units_rented
FROM rental_items r
JOIN event_items ei ON ei.item_id = r.item_id
JOIN events e ON e.event_id = ei.event_id
WHERE e.status <> 'Cancelled'
GROUP BY r.item_id, r.item_code, r.name, r.category
ORDER BY units_rented DESC, r.name;


-- -------------------------------------------------------------------------------------
-- 12. WHERE + ORDER BY: consumables at or below their reorder level
-- Purpose : the dashboard's Low Consumables Tracker.
-- Expected: 2 rows: Glue Dots (3 rolls, reorder at 5) and Chrome Gold Balloons (6 packs, reorder at 8).
-- -------------------------------------------------------------------------------------
SELECT item_code, name, current_level, unit, reorder_level
FROM consumables
WHERE is_deleted = 0 AND current_level <= reorder_level
ORDER BY current_level;
