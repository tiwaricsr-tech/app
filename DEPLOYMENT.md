# Deployment Guide

StockFlow is a single Node process (Express + vanilla-ESM SPA) that talks to
PostgreSQL. It runs anywhere Node 20 runs, and needs **no build step**.

There are exactly two decisions to make:

| Decision | Options | Default |
|---|---|---|
| **Database** | Supabase PostgreSQL, or any Postgres 13+ | embedded SQLite (dev only) |
| **Host** | Docker, Render, Railway, Fly, Vercel, a VPS | — |

---

## 1. Database — Supabase

### 1.0 Live configuration (current)

| | |
|---|---|
| **Project** | `stockflow` — ref `crqzogvjychxszmvdzoi` |
| **Region** | `ap-south-1` (Mumbai) |
| **Engine** | PostgreSQL 17.11 |
| **Pooler host** | `aws-0-ap-south-1.pooler.supabase.com:5432` |
| **Schema / RLS** | applied — 12 tables, 12 policies, 3 stock functions |
| **Data** | 28 products · 61 invoices · 171 movements · 5 users |

`DATABASE_URL` (password is URL-encoded — `!` → `%21`, `#` → `%23`):

```
postgresql://postgres.crqzogvjychxszmvdzoi:<PASSWORD>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
```

The password lives in `.env.local` for the preview and in Vercel's encrypted
environment variables for the deployment. It is not committed.

> **IPv6 gotcha (important).** Supabase's *direct* host
> `db.<ref>.supabase.co` is **IPv6-only** and has no A record. On an IPv4-only
> network you get `ENOTFOUND`. Always use the **pooler** hostname — that is
> also what serverless platforms require.

### 1.1 Create a project from scratch

Project → New, pick the region nearest your users, and **save the database
password** — it is shown once and no API can retrieve it afterwards. If it is
lost, reset it under Project Settings → Database. Start from `supabase/schema.sql`
then `supabase/rls.sql` (both idempotent).

### 1.2 Apply the schema

Two files, in this order, via **SQL Editor** in the Supabase dashboard (or
`psql`, or `supabase db push`):

```sql
-- 1. tables, foreign keys, indexes, stock functions, roles & permissions
\i supabase/schema.sql

-- 2. Row Level Security — deny-all for public API roles
\i supabase/rls.sql
```

`schema.sql` is **idempotent** — every statement is `create ... if not exists`,
`on conflict do nothing`, or `create or replace`. Re-running it is safe and will
not duplicate seed data.

What you get:

| Object | Purpose |
|---|---|
| `roles`, `permissions`, `role_permissions` | 3 roles (admin/manager/staff), 14 permissions, 30 mappings |
| `users` | bcrypt password hashes, status, role FK |
| `categories`, `products` | catalogue with `purchase_price` / `selling_price` NUMERIC(12,2) |
| `inventory` | one row per product, `CHECK (quantity >= 0)` |
| `stock_movements` | append-only ledger, `CHECK (quantity_after >= 0)` |
| `invoices`, `invoice_items` | billing with `idempotency_key UNIQUE` |
| `counters` | invoice number sequence (`INV-YYYYMM-NNNN`) |
| `activity_log` | audit trail |
| `deduct_stock()`, `restore_stock()` | atomic `SELECT ... FOR UPDATE` stock updates |
| `reset_identity_sequences()` | call after any bulk import |

### 1.3 Get the connection string

Dashboard → **Project Settings → Database → Connection string → URI**.

```
# Session pooler — use for a long-running server (recommended)
postgresql://postgres.<ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:5432/postgres

# Direct connection — fine for migrations and local tools
postgresql://postgres:<PASSWORD>@db.<ref>.supabase.co:5432/postgres

# Transaction pooler — required for serverless (Vercel, Lambda)
postgresql://postgres.<ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

The password is shown **only once**, when the project is created. If it is lost,
reset it: **Project Settings → Database → Reset database password**.

> **Why the password is needed:** Supabase's REST API (PostgREST) is reachable
> with the `service_role` key, but a normal pooled Postgres connection is not —
> it authenticates with the database password. The Node app uses `pg`, so it
> needs `DATABASE_URL`.

### 1.4 Load data (pick one)

```bash
# A. Demo dataset — 5 users, 28 products, 65 invoices, 185 stock movements
DATABASE_URL='postgresql://...' node src/db/seed.js --reset

# B. Copy an existing local SQLite database up to Postgres
DATABASE_URL='postgresql://...' node src/db/migrate-to-postgres.js

# C. Push to Supabase over the REST API (no DB password needed)
SUPABASE_URL='https://<ref>.supabase.co' \
SUPABASE_SERVICE_ROLE_KEY='<service_role jwt>' \
node src/db/sync-supabase.js
```

All three finish with an integrity check: row counts, `Σ movements === inventory`,
and no negative stock. Option C (used for this workspace) wrote 499 rows and
verified all seven tables.

After any bulk import, realign sequences so new inserts don't collide:

```sql
select reset_identity_sequences();
```

> **`service_role` key = root.** It bypasses RLS completely. Server-side only,
> never in `public/`, never in a bundled client. The browser has no Supabase SDK
> in this app at all — it only talks to `/api`.

---

## 2. Run locally

```bash
./start.sh                      # everything, idempotent
```

Or manually:

```bash
npm ci
node src/db/seed.js --reset     # SQLite demo data
node src/server.js              # http://localhost:4173
```

### Local PostgreSQL without an install

For preview/sandbox environments with no database daemon, the app ships an
embedded PostgreSQL (`embedded-postgres`, a dev dependency) and boots it on
demand when `DATABASE_URL` is a loopback address:

1. cluster missing → `initdb` into `data/pgdata` (inside the workspace, so it
   survives snapshots)
2. cluster stopped → started with `pg_ctl`
3. database missing → created
4. schema missing → `supabase/schema.sql` applied
5. no products → demo catalogue seeded

So `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/stockflow
node src/server.js` works on a completely cold machine. Hosted databases
(Supabase) never trigger any of this — the checks are loopback-only, and demo
seeding on a hosted database still requires `SEED_DEMO=true`.

Against Supabase instead:

```bash
DATABASE_URL='postgresql://...' node src/server.js
```

The boot log states which engine is live:

```
StockFlow running on http://0.0.0.0:4173  ·  db: PostgreSQL (Supabase)  ·  env: production
```

With `DATABASE_URL` set the app creates the `roles`/`permissions` reference data
if missing (`seedReference()`), but **does not** inject demo products unless
`SEED_DEMO=true`. A production database never silently fills with samples.

---

## 3. Host it

### 3.1 Docker (any VPS, Fly, Railway, Cloud Run, ECS)

```bash
docker build -t stockflow .
docker run -d -p 4173:4173 \
  -e JWT_SECRET="$(openssl rand -base64 48)" \
  -e DATABASE_URL="postgresql://..." \
  -e NODE_ENV=production \
  --name stockflow stockflow
```

The image runs as the unprivileged `node` user and ships a `HEALTHCHECK`
against `/api/health`, which performs a real database round-trip.

### 3.2 Docker Compose (with a local Postgres)

```bash
# App + Postgres, schema auto-applied on first boot
docker compose --profile supabase up --build
```

App on `:4173`, Postgres on `:5433`, data in named volumes. This is the fastest
way to exercise the Postgres code path end-to-end without touching Supabase.

### 3.3 Render

`render.yaml` is a blueprint — **New → Blueprint → pick the repo**. Render
generates `JWT_SECRET` for you; paste `DATABASE_URL` in the dashboard.

### 3.4 Vercel — ready to deploy

Everything is already provisioned:

| | |
|---|---|
| Project | `stockflow` · `prj_ujpe1HFfl2a25Fial1QFeXNURikH` |
| Framework | node (auto-detection pinned) |
| Install command | `npm install --omit=dev --no-audit --no-fund` |
| Env vars | `DATABASE_URL`, `JWT_SECRET` (encrypted), `NODE_ENV`, `PG_POOL_MAX`, `CORS_ORIGINS`, `DATE_SHIFT_MINUTES` |
| Bundle | `stockflow-deploy.zip` — 46 files, 132 KB |

**Option A — CLI (30 seconds):**

```bash
cd /path/to/stockflow
npm i -g vercel && vercel login
vercel link --project stockflow
vercel --prod
```

**Option B — drag and drop:** go to
`vercel.com/tiwaricsr-1287/stockflow` → **Deployments → Create Deployment**,
drop `stockflow-deploy.zip`, click Deploy. The project's environment variables
are picked up automatically.

The bundle contains only the 46 files the function needs (`api/`, `src/`,
`public/`, `supabase/schema.sql`, `supabase/rls.sql`, `package.json`,
`vercel.json`, `.env.example`) — no tests, screenshots, data directory or
`node_modules`.

**Proven before shipping.** The zip was extracted into an empty directory,
`npm install --omit=dev` was run, and the entry point was driven over HTTP:

```
health 200 · login 200 · dashboard 200 (28 products, 63 bills)
invoice PDF 200 (4444 b, %PDF) · invoices XLSX 200 (21586 b, PK)
SPA index 200 · static JS 200
```

`tests/serverless.test.js` reproduces this (11 checks) against the live database.

Serverless notes already handled: static assets bundled via
`includeFiles: public/**`; image uploads fall back to data URIs on a read-only
filesystem; `better-sqlite3` is optional so a native build failure cannot break
the deploy; the SPA fallback and all `/api` routes go through one function.

### 3.5 Heroku / Railway / anything with a Procfile

`Procfile` → `web: node src/server.js`.

---

## 4. Environment variables

Copy `.env.example` to `.env`. The only ones that matter in production:

| Variable | Required | Notes |
|---|---|---|
| `JWT_SECRET` | **yes** | Server refuses to boot in production without it |
| `DATABASE_URL` | yes, except SQLite | Supabase pooler URI |
| `NODE_ENV` | recommended | `production` enables safe defaults |
| `PORT` | no | Most hosts inject it; defaults to 4173 |
| `PG_POOL_MAX` | no | `1-3` on serverless, `10` on a VPS |
| `CORS_ORIGINS` | public deploys | Defaults to `*` so previews work |
| `FRAME_ANCESTORS` | public deploys | Set to lock down iframe embedding |
| `SEED_DEMO` | no | `true` loads the sample catalogue on Postgres |
| `DATE_SHIFT_MINUTES` | no | `330` = IST; controls day/month report bucketing |

---

## 5. Security posture

| Layer | Control |
|---|---|
| Passwords | bcrypt, cost 10; never returned by any endpoint |
| Sessions | JWT HS256, 12 h expiry, signed with `JWT_SECRET` |
| Authorisation | `requirePermission()` on every mutating route; 14 permissions |
| User state | Re-read from the DB on **every** request — deactivation is instant |
| SQL injection | Parameterised queries throughout; no string interpolation of input |
| Stock safety | Guarded `UPDATE ... WHERE quantity >= ?`, `CHECK (quantity >= 0)`, `FOR UPDATE` in PG |
| Duplicate charges | `idempotency_key UNIQUE` → repeated POST returns the original invoice |
| RLS | Enabled on all 12 tables, `anon`/`authenticated` grants revoked, deny-all policies |
| Service key | Never leaves the server; no Supabase SDK in the frontend |
| Headers | CSP, `nosniff`, `Referrer-Policy`, `Permissions-Policy` |

Self-check after deploying:

```bash
curl -s https://your-host/api/health          # {"ok":true,"driver":"postgres",...}
curl -s -o /dev/null -w '%{http_code}\n' https://your-host/api/products   # 401
```

The second call must be `401`: product data requires a token.

---

## 6. Verify a deployment

```bash
# Server-side: auth, RBAC, stock, billing, exports, ledger integrity
node tests/integration.test.js

# Same suite against PostgreSQL — proves engine parity
DATABASE_URL='postgresql://...' node tests/integration.test.js

# Browser: 50 UI checks (needs Chromium + a server on :4173)
npx playwright-core install chromium
node tests/e2e.js

# Sandboxed-iframe preview checks
node tests/preview-iframe.test.js
```

Result on this codebase: **61/61** integration (SQLite *and* PostgreSQL),
**50/50** browser, **12/12** iframe.

---

## 7. Operations

**Backups.** Supabase Pro takes daily backups. On the free tier, export
regularly:

```bash
pg_dump "$DATABASE_URL" --no-owner --no-acl -Fc > stockflow-$(date +%F).dump
```

**Migrations.** There is no migration runner; the schema is idempotent by
design. To change it, edit `supabase/schema.sql` and re-run it, or add a
timestamped file under `supabase/migrations/`.

**Monitoring.** `GET /api/health` is the liveness + readiness probe. It returns
`driver`, `version` and the server time.

**Scaling.** The app is stateless — the JWT is the session. Run N replicas
behind a load balancer; keep `PG_POOL_MAX × replicas` below the Supabase
connection limit (60 on the free tier).

**Troubleshooting**

| Symptom | Cause | Fix |
|---|---|---|
| `password authentication failed` | wrong/reset DB password | reset it in the dashboard, update `DATABASE_URL` |
| `JWT_SECRET must be set` | production without a secret | set the env var |
| `relation "products" does not exist` | schema not applied | run `supabase/schema.sql` |
| `duplicate key ... pkey` after import | sequences not realigned | `select reset_identity_sequences();` |
| Empty tables but `service_role` works | RLS + revoked grants | expected — the API connects via `pg`, not PostgREST |
| `EMAXCONNSESSION` | pool too large for the tier | lower `PG_POOL_MAX` |
| App boots on SQLite in production | `DATABASE_URL` unset | set it; check the boot log |
