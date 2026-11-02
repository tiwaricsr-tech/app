# StockFlow — Inventory, Stock Management & Billing

A complete, working inventory + billing application: admin and user dashboards, role-based
access, real stock-movement accounting, and a billing system that deducts and restores stock
inside database transactions.

The preview runs on **embedded SQLite** (zero config). Point `DATABASE_URL` at **PostgreSQL
or Supabase** and the *same* application runs on the production schema in `supabase/` — all
three test suites pass unmodified on both engines (61 integration checks were run against a
real PostgreSQL 18 server, not just SQLite).

Deployment paths (Docker, Compose with Postgres, Render, Vercel, Procfile) and the full
Supabase setup are in **[DEPLOYMENT.md](DEPLOYMENT.md)**.

---

## Live configuration

The app now runs against a **live Supabase PostgreSQL** project, not a demo file:

| | |
|---|---|
| Project | `stockflow` · ref `crqzogvjychxszmvdzoi` |
| Region | `ap-south-1` (Mumbai) · PostgreSQL 17.11 |
| Connection | session pooler `aws-0-ap-south-1.pooler.supabase.com:5432` |
| Data | 28 products · 61 invoices · 171 stock movements · 5 users |
| Integrity | 0 ledger mismatches · 0 negative stock · 0 rounding mismatches |
| Security | RLS on all 12 tables, public grants revoked |

The preview, the tests and the Vercel build all use the same database. The
connection string lives in `.env.local` (preview) and in Vercel's encrypted env
vars (deployment) — never in source.

> Supabase's direct host `db.<ref>.supabase.co` is **IPv6-only**. On an IPv4-only
> network it fails with `ENOTFOUND`; use the pooler hostname everywhere.

## Run it

```bash
./start.sh           # installs deps if needed, connects to Supabase, starts the app
```

Or step by step:

```bash
npm ci
npm start            # http://localhost:4173
```

`start.sh` is idempotent and handles a resumed workspace: missing `node_modules`,
a stopped local PostgreSQL, and an empty database (it applies `supabase/schema.sql`
and loads the demo catalogue). Force SQLite with `./start.sh sqlite`.

> Dependencies live in `node_modules/`, which is **not persisted by the workspace snapshot**.
> If the app fails with `Cannot find module`, run `./setup.sh` (or `npm ci && npm start`).

The database is created and seeded automatically on first start.

```bash
npm run seed                        # wipe demo data and reseed (destructive)
npm test                            # 61 server-side integration & integrity tests
npm run test:e2e                    # 50 browser end-to-end checks
npm run test:iframe                 # 12 checks inside a sandboxed iframe
npm run test:all                    # all three, in order

# PostgreSQL: driver, types, sequences, transactions, constraints, RLS
DATABASE_URL='postgres://user:pass@host:5432/db' npm run test:pg

# the full 61-check integration suite, retargeted at PostgreSQL
DATABASE_URL='postgres://user:pass@host:5432/db' npm test

# run the app itself on PostgreSQL
DATABASE_URL='postgres://...' npm start
```

The suites cover different ground: `integration` proves the data and transaction rules,
`postgres-parity` proves the Postgres-specific behaviour (NUMERIC coercion, identity
sequences, savepoint nesting, FK/CHECK enforcement, RLS), `e2e` drives the real UI through
every role, and `preview-iframe` replays the exact preview environment (opaque origin, no
storage, no form API) so the embedded app can never silently blank out again.

| Suite | Checks | SQLite | PostgreSQL |
| --- | --- | --- | --- |
| `tests/integration.test.js` | 61 | ✅ 61/61 | ✅ 61/61 |
| `tests/postgres-parity.test.js` | 17 | n/a | ✅ 17/17 |
| `tests/e2e.js` | 50 | ✅ 50/50 | ✅ 50/50 |
| `tests/preview-iframe.test.js` | 12 | ✅ 12/12 | ✅ 12/12 |
| `tests/serverless.test.js` | 8 | n/a | ✅ 8/8 (Vercel handler) |

### Pagination & data volume

Every register is paged server-side: Products (25/page) and Invoices (20/page) both
carry Previous/Next controls and a live "showing X–Y of N" counter, and any filter,
search or sort change resets to page 1. The stock ledger and report tables load a
bounded window rather than the whole table.

### Accounts

The five demo accounts are seeded, but their passwords were **rotated after the
first deployment** — the public `Admin@1234` style credentials no longer work.
Current password for the administrator:

```
admin@stockflow.app   PALuRjszMfMqr8FZFbdW#7k
```

Other accounts (`manager@`, `staff@`, `neha@`, `imran@`) also have unique random
passwords. Rotate any of them from **My Profile → Change password**, or reset all
of them at once:

```bash
node -e "require('./src/db/seed')"   # reseeds passwords from the demo set
```

New self-registered accounts start as **Billing Staff**.

--- | --- | --- |
| Administrator | `admin@stockflow.app` | `Admin@1234` |
| Manager | `manager@stockflow.app` | `Manager@1234` |
| Billing Staff | `staff@stockflow.app` | `Staff@1234` |
| Billing Staff (deactivated) | `imran@stockflow.app` | `Imran@12345` |

New self-registered accounts start as **Billing Staff**.

---

## What each part does

**Admin dashboard** — add/edit/delete products (name, SKU, category, image, purchase & selling
price, stock, reorder level), one-click stock +/− buttons, low-stock alerts, search and
filtering across the full inventory, plus user administration (create, activate/deactivate,
change role, reset password).

**User dashboard** — registration, login, profile, password change, role-based menus. Staff see
the catalogue and can create bills; they cannot reach admin screens (enforced server-side, not
just hidden in the UI).

**Inventory** — every change is an immutable `stock_movements` row with quantity before/after,
type, reference and user. Three views: movement ledger, low-stock reorder list, stock on hand.
Stock can never go negative.

**Billing** — unique invoice numbers (`INV-YYYYMM-NNNN`), product search, multi-line bills,
editable unit prices and quantities, percentage or fixed discounts, GST, payment method,
printable/PDF invoices, full history with filters.

**Automatic stock deduction** — confirming a bill deducts stock; editing moves only the
difference; cancelling or refunding returns every unit, exactly once.

**Reports** — daily sales, monthly sales, inventory valuation, low stock, product movement.
Every report exports to **PDF** and **Excel**.

---

## How correctness is guaranteed

Every write path runs in a single database transaction (`db.tx`) that touches the invoice,
its lines and the stock together:

| Risk | Protection |
| --- | --- |
| Negative stock | Guarded atomic `UPDATE inventory SET quantity = quantity + ? WHERE ... AND quantity >= ?` **plus** a `CHECK (quantity >= 0)` constraint |
| Overselling under concurrency | The guarded update fails for the loser; the whole bill rolls back. Tests fire 8 simultaneous sales at 10 units — exactly 5 succeed, stock lands on 0 |
| Double deduction on retry | Optional `idempotency_key` on invoices; a repeated submission returns the original invoice |
| Double stock restoration | Conditional transition `UPDATE ... WHERE status = 'paid'`; a second cancel/refund returns 409 and changes nothing |
| Editing a bill | Only the per-product delta is moved (`old − new`), so totals and stock stay consistent |
| Partial bills | Any failure inside the transaction rolls back the invoice, the lines and every movement |
| Silent corruption | Tests assert `Σ stock_movements.quantity_change === inventory.quantity` for every product |

Verified by `tests/integration.test.js` (61 checks) and `tests/e2e.js` (50 browser checks).

---

## Security

* bcrypt password hashes (cost 11); generic "email or password is incorrect" responses.
* Signed JWT bearer tokens (12h). **The user is re-read from the database on every request**, so
  deactivation and role changes take effect immediately — no stale permissions.
* Login throttling after repeated failures.
* Permission middleware on every route; admin-only routes additionally require the `admin` role.
* Server-side validation of every quantity, price, discount and stock level — client input is
  never trusted. The UI's quantity limits are a convenience, not the control.
* Parameterised SQL everywhere; dynamic sort keys are whitelisted.
* Strict CSP (`script-src 'self'`), no CDNs, no inline scripts, `nosniff`, restrictive
  `Permissions-Policy`. All user text is HTML-escaped on render.
* **Embed-friendly by design.** The preview renders the app in a `sandbox="allow-scripts"`
  iframe, which means an opaque origin, no `localStorage`/`sessionStorage`, and no native form
  submission. The app therefore: sends `Access-Control-Allow-Origin` so ES modules load, omits
  `X-Frame-Options` / `frame-ancestors` restrictions, falls back to an in-memory token store,
  drives forms from button clicks, and never `location.reload()`s. Set `FRAME_ANCESTORS='self'`
  to harden a self-hosted deployment.
* Guards against self-lockout: an admin cannot deactivate/demote/delete themselves or remove the
  last active administrator.
* Service-role keys are never sent to the browser — there is no database credential in the
  frontend at all.

---

## Database

SQLite schema: `src/db/schema.js` · Supabase schema: `supabase/schema.sql` · RLS: `supabase/rls.sql`

Tables: `roles`, `permissions`, `role_permissions`, `users`, `categories`, `products`,
`inventory`, `stock_movements`, `invoices`, `invoice_items`, `activity_log`, `counters` — with
foreign keys, check constraints and indexes.

Roles: `admin` (all), `manager` (catalogue, stock, billing, reports), `staff` (bill + read-only).

### Running on PostgreSQL / Supabase

The schema is engine-compatible, so the code and all 61 integration tests apply unchanged.

1. Apply `supabase/schema.sql`, then `supabase/rls.sql` (Supabase SQL editor or `psql`).
   Both are idempotent — re-running is safe.
2. Load data — any one of:

```bash
DATABASE_URL='postgres://...' npm run seed          # demo dataset
DATABASE_URL='postgres://...' npm run migrate:pg    # copy local SQLite -> Postgres
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run sync:supabase   # via REST
```

3. Start:

```bash
DATABASE_URL='postgres://postgres:<password>@db.<project>.supabase.co:5432/postgres' \
JWT_SECRET='a-long-random-string' npm start
```

The boot line reports the live engine: `db: PostgreSQL (Supabase)`.

**What runs in Postgres.** `deduct_stock()` / `restore_stock()` are plpgsql functions using
`SELECT ... FOR UPDATE`, `inventory.quantity` carries `CHECK (quantity >= 0)`, and the driver
wraps nested operations in savepoints. Row Level Security is enabled on all 12 tables with
`anon`/`authenticated` grants revoked and deny-all policies — the API reaches the database
over `pg` as the owner, so the browser can read nothing directly. See `supabase/rls.sql`
for the reasoning and the optional Supabase-Auth pattern.

> `SEED_DEMO=true` is required to load sample products on Postgres; by default a production
> database only gets the roles/permissions reference data it cannot boot without.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4173` | HTTP port |
| `DATABASE_URL` | *(empty → SQLite)* | Postgres/Supabase connection string |
| `PGDATA_DIR` | `data/pgdata` | Data directory for the bundled local Postgres |
| `SQLITE_FILE` | `data/stockflow.db` | SQLite location |
| `JWT_SECRET` | dev default | **Required in production** — the server refuses to boot without it |
| `JWT_EXPIRES_IN` | `12h` | Token lifetime |
| `PG_POOL_MAX` | `10` | Postgres pool ceiling (1–3 on serverless) |
| `PG_CONNECT_TIMEOUT_MS` | `10000` | Pool connect timeout |
| `SEED_DEMO` | *(unset)* | `true` loads the demo catalogue when on Postgres |
| `DATE_SHIFT_MINUTES` | `330` | UTC offset for day/month reporting (IST) |
| `COMPANY_*`, `CURRENCY*` | demo values | Branding on invoices |
| `CORS_ORIGINS` | `*` | Comma-separated allow-list (bearer-token auth, no cookies) |
| `FRAME_ANCESTORS` | *(open)* | Set to `'self'` to block embedding when self-hosting |

---

## Layout

```
src/
  server.js              Express app, security headers, SPA fallback
  config.js              env-driven configuration
  db/index.js            portable SQL layer + transaction helper
  db/schema.js           SQLite DDL (mirrors the Supabase schema)
  db/seed.js             roles, permissions and demo dataset
  db/migrate-to-postgres.js  copy the SQLite dataset into Postgres (with verification)
  db/sync-supabase.js    push the dataset to Supabase over the REST API
  lib/auth.js            JWT, bcrypt, authenticate / requirePermission / requireRole
  lib/perm.js            permission catalogue and role matrix
  routes/                auth, products, categories, inventory, invoices, reports, users
  services/inventory.js  atomic stock movement engine
  services/invoice.js    billing: create / edit / cancel / refund
  services/reports.js    analytics and report queries
  services/export.js     PDF and Excel builders
public/                  zero-build SPA (app shell, router, views)
supabase/                production Postgres schema + Row Level Security
tests/                   integration, Postgres-parity, browser and iframe suites
api/index.js             Vercel serverless adapter
Dockerfile               production image (unprivileged, healthchecked)
docker-compose.yml       app + optional local Postgres
render.yaml              Render blueprint
DEPLOYMENT.md            database, hosting, security and operations guide
```

## API surface

```
POST   /api/auth/register | login | logout | change-password
GET    /api/auth/me                    PATCH /api/auth/me
GET    /api/products                   POST/PATCH/DELETE /api/products[/:id]
GET    /api/categories                 POST/PATCH/DELETE /api/categories[/:id]
GET    /api/inventory/summary | low-stock | movements   POST /api/inventory/adjust
GET    /api/invoices | /api/invoices/:id | /:id/pdf | /export/xlsx
POST   /api/invoices    PUT /api/invoices/:id    POST /api/invoices/:id/cancel | refund
GET    /api/reports/dashboard | :type   GET /api/reports/:type/export/:format
GET    /api/users | /roles              POST/PATCH/DELETE /api/users[/:id]
```
