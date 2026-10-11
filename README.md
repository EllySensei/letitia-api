# Laetitia — Event Styling, Balloon & Decor Rental System (API)

Backend for Laetitia, an information system for an event-styling and decor-rental business. It manages
clients, decor packages, rental inventory, consumables, event bookings, payments, and item returns.

The frontend is in a separate repository, [letitia-frontend](https://github.com/ellysensei/letitia-frontend).
This server also hosts it, so you only run one program.

- **Storefront** (customers browse freely; ordering needs a customer account): `http://localhost:3000`
- **Admin dashboard** (staff, login required): `http://localhost:3000/admin`

## Tech stack

| Layer    | Technology                                   |
|----------|----------------------------------------------|
| Frontend | HTML, CSS, vanilla JavaScript (ES modules)   |
| Backend  | Node.js, Express 5                           |
| Database | MariaDB (MySQL-compatible)                   |
| Auth     | JWT tokens, bcrypt-hashed passwords          |

## Requirements

- [Node.js](https://nodejs.org/) 20 or newer
- [MariaDB](https://mariadb.org/download/) 10.6 or newer (or MySQL 8)

## Setup

1. Put both repositories in the same parent folder:

   ```
   letitia/
   ├── letitia-api/
   └── letitia-frontend/
   ```

2. Install the dependencies:

   ```bash
   cd letitia-api
   npm install
   ```

3. Copy `.env.example` to `.env` and fill it in:
   - `DB_USER` / `DB_PASS`: your MariaDB login
   - `JWT_SECRET`: any long random string. To generate one, run
     `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
   - `ADMIN_USERNAME` / `ADMIN_PASSWORD`: the first admin account (password at least 8 characters)

4. Start the server:

   ```bash
   npm start
   ```

   On first start the server creates the `laetitia` database and all its tables, and it creates the admin
   account from `.env`. Then open `http://localhost:3000/admin` and log in.

### Sample data

In the admin dashboard, open the **Database** tab and click **Generate sample data**. This replaces all
clients, events, packages, inventory, payments and returns with a ready-made set of about 190 rows.
Admin accounts are kept. Event dates are set relative to today, so the dashboard always shows a mix of
finished, overdue, tomorrow's and upcoming events. The set is defined in `lib/sampleData.js`.

It also creates two demo customer logins for the storefront, both with the password `customer123`:
`angelica.santos@example.com` and `bea.ocampo@example.com`.

## Users and access

There are three roles. Every request checks the role stored in the database (not just the login token),
so a customer's token can't be reused to reach admin data.

| | Customer | Staff | Admin |
|---|---|---|---|
| Signs in with | Email | Username, or email if promoted from customer | Username, or email if promoted from customer |
| Account made by | Signing up on the storefront | An admin (Accounts tab) | `.env` on first start, or an admin |
| Browse packages and rentals | ✓ | ✓ | ✓ |
| Place an order (packages, rentals, or the Build-your-own kiosk) | ✓ (login required) | | |
| Customer portal: Dashboard, My Bookings, My Profile, Support, My Payments | ✓ | | |
| Edit own details, change own password | ✓ (My Profile) | | |
| Track a booking by reference no. + email | ✓ (no login needed) | | |
| Admin dashboard: view all data | | ✓ (read-only) | ✓ |
| Add, edit, archive, delete records | | | ✓ |
| Accounts tab: add staff, change roles, reset passwords, delete | | | ✓ |
| Database tab and sample data | | | ✓ |
| Delete own account | ✓ (My Profile) | | |

A customer an admin makes staff then signs in to `/admin` with their email. Role changes apply on the
person's next click. Admins can't change their own role or delete themselves, so there is always an admin.

Either login screen works for everyone: a customer who logs in at `/admin` is taken to their customer
dashboard, and staff who log in on the storefront are taken to the admin dashboard. On the server, admin routes answer customers with `403 Staff access required`.

### Starter catalog

To fill an empty shop without touching your clients, events or payments, use **Inventory → Add starter
items** (13 rental items and 8 consumables) and **Packages → Add starter packages** (6 packages with their
item lists; any items they need are added too). Anything with the same name is skipped, and archived ones
are restored, so running them twice adds nothing.

### Loading the SQL script instead

`database/laetitia.sql` contains the full database: `CREATE DATABASE`, every `CREATE TABLE` with its
primary and foreign keys, and the sample records. To load it, import the file in HeidiSQL (File → Run SQL
file), or run:

```bash
mariadb -u root -p < database/laetitia.sql
```

Then start the server as above. User accounts aren't included in the file, so the admin is created from
`.env` on first start.

To regenerate the file from your current database, run `npm run export-sql`.

## Project structure

```
letitia-api/
├── index.js            Entry point: middleware, routes, startup
├── db_init.js          Creates the database and tables on startup
├── lib/
│   ├── db.js           Database connection pool and transactions (connection file)
│   ├── auth.js         Login tokens, password hashing, role checks (admin, staff, customer)
│   ├── validate.js     Input validation rules for every request
│   ├── errors.js       Turns errors into JSON responses
│   ├── sql.js          Shared SQL expressions (paid amount, balance, status, ...)
│   ├── bookings.js     Saving a booking with its items, consumables and downpayment
│   ├── changes.js      Change log shown in the admin Database tab
│   ├── notify.js       Low-stock and return alerts
│   ├── phone.js        Phone number parsing
│   ├── sampleData.js   The sample data set and its generator
│   ├── orders.js       What a customer sees of their bookings
│   ├── purge.js        Permanent delete of archived records
│   ├── rateLimit.js    Per-connection limits on sign-up, orders and lookups
│   └── context.js      Tracks which user made each change
├── routes/             One file per module
│   ├── auth.js         Login, logout, customer sign-up, current user
│   ├── account.js      Customers: profile, password, bookings, payments, place an order
│   ├── clients.js      Clients CRUD, search, archive and restore
│   ├── events.js       Bookings: create, edit, reschedule, cancel, search and filter
│   ├── packages.js     Decor packages and the items in each
│   ├── inventory.js    Rental items (chairs, arches, stands, ...)
│   ├── consumables.js  Consumables (balloons, tape, ...) and restocking
│   ├── payments.js     Downpayments and balance payments
│   ├── returns.js      Item returns, damage and missing fees
│   ├── schedule.js     Date availability and daily pull sheet
│   ├── dashboard.js    Dashboard stats and receivables report
│   ├── notifications.js
│   ├── public.js       Storefront catalog and order tracking (no login)
│   ├── database.js     Admin Database tab: table viewer, change log, sample data
│   ├── users.js        Admin Accounts tab: staff accounts, roles, passwords
│   └── heartbeat.js    Tells open pages when data changed
├── scripts/
│   └── export-sql.js   Writes database/laetitia.sql
├── database/
│   ├── laetitia.sql    Full database script (generate with npm run export-sql)
│   └── queries.sql     SQL query demonstration with expected outputs
└── docs/
    └── er-diagram.*    ER diagram (HTML source, PNG and PDF)
```

## Database

Business tables and their relationships:

| Table               | Kind        | Purpose                                  | Foreign keys                     |
|---------------------|-------------|------------------------------------------|----------------------------------|
| `clients`           | Main entity | Customers who book events                | —                                |
| `packages`          | Main entity | Decor packages offered                   | —                                |
| `rental_items`      | Main entity | Reusable decor inventory                 | —                                |
| `consumables`       | Main entity | Supplies used up per event               | —                                |
| `users`             | Main entity | Login accounts: admin, staff, customer   | `client_id` (customers only)     |
| `events`            | Transaction | Event bookings                           | `client_id`, `package_id`        |
| `payments`          | Transaction | Payments made per event                  | `event_id`                       |
| `return_logs`       | Log         | Returned items, condition, fees          | `event_item_id`                  |
| `package_items`     | Junction    | Packages ↔ rental items (many-to-many)   | `package_id`, `item_id`          |
| `event_items`       | Junction    | Events ↔ rental items (many-to-many)     | `event_id`, `item_id`            |
| `event_consumables` | Junction    | Events ↔ consumables (many-to-many)      | `event_id`, `consumable_id`      |

System tables: `notifications`, `change_log` (record of every write), and
`data_versions` (lets open pages refresh when data changes).
