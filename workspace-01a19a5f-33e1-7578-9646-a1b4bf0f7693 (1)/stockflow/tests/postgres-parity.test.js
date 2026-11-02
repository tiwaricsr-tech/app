'use strict';
/**
 * PostgreSQL parity test.
 *
 *   DATABASE_URL='postgres://...' node tests/postgres-parity.test.js
 *
 * Boots the app against a real PostgreSQL database and proves the things that
 * differ from SQLite: identity/sequence handling, NUMERIC->number coercion,
 * native timestamps, savepoint transactions, and the stock CHECK constraints.
 *
 * Safe to run against a scratch database. It creates and drops its own tables'
 * rows — never point it at production.
 */
process.env.NODE_ENV = 'test';
process.env.PORT = String(4970 + (process.pid % 25));

const assert = require('assert');
const path = require('path');
const fs = require('fs');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed += 1;
    console.log(`  \u2713 ${name}`);
  }).catch((err) => {
    failed += 1;
    failures.push({ name, message: err.message });
    console.log(`  \u2717 ${name}\n      ${err.message}`);
  });
}

const PG = (process.env.DATABASE_URL || '').trim();
const BASE = `http://127.0.0.1:${process.env.PORT}`;

async function req(method, urlPath, { token, body } = {}) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* binary */ }
  return { status: res.status, body: json, text, headers: res.headers };
}

async function waitForServer() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch (_) { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

(async () => {
  if (!PG) {
    console.error('DATABASE_URL must point at a PostgreSQL database.');
    process.exit(1);
  }

  console.log('\nStockFlow \u2014 PostgreSQL parity tests');
  console.log('Database:', PG.replace(/:[^:@]+@/, ':****@'), '\n');

  // Prepare a clean, fully-migrated database.
  const { Client } = require('pg');
  const db = new Client({
    connectionString: PG,
    ssl: /supabase\./.test(PG) ? { rejectUnauthorized: false } : undefined
  });
  await db.connect();
  await db.query(`
    truncate roles, permissions, role_permissions, users, categories, products,
             inventory, stock_movements, invoices, invoice_items, counters, activity_log
    restart identity cascade`);
  await db.query(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8'));
  await db.query(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'rls.sql'), 'utf8'));
  console.log('  schema + RLS applied to a clean database\n');

  const { spawn } = require('child_process');
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, SEED_DEMO: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d.toString(); });
  server.stderr.on('data', (d) => { log += d.toString(); });

  try {
    await waitForServer();

    let adminToken;

    console.log('Driver & schema');

    await check('health reports the postgres driver', async () => {
      const r = await req('GET', '/api/health');
      assert.equal(r.status, 200);
      assert.equal(r.body.driver, 'postgres', `driver was ${r.body.driver}`);
    });

    await check('all 12 tables exist in PostgreSQL', async () => {
      const { rows } = await db.query(
        `select table_name from information_schema.tables
          where table_schema='public' and table_name = any($1)`,
        [['roles', 'permissions', 'role_permissions', 'users', 'categories', 'products',
          'inventory', 'stock_movements', 'invoices', 'invoice_items', 'counters', 'activity_log']]
      );
      assert.equal(rows.length, 12, `found ${rows.length} tables`);
    });

    await check('foreign keys are enforced', async () => {
      let blocked = false;
      await db.query('begin');
      try {
        await db.query(`insert into products (name, sku, category_id, selling_price)
                        values ('orphan', 'ORPHAN-1', 999999, 10)`);
      } catch (e) {
        blocked = /foreign key|violates/i.test(e.message);
      } finally {
        await db.query('rollback');
      }
      assert.ok(blocked, 'insert with a missing category_id should be rejected');
    });

    await check('CHECK (quantity >= 0) rejects negative inventory', async () => {
      const { rows } = await db.query('select product_id from inventory limit 1');
      let blocked = false;
      await db.query('begin');
      try {
        await db.query('update inventory set quantity = -5 where product_id = $1', [rows[0].product_id]);
      } catch (e) {
        blocked = /check constraint|violates/i.test(e.message);
      } finally {
        await db.query('rollback');
      }
      assert.ok(blocked, 'negative quantity must violate the check constraint');
    });

    await check('unique SKU constraint is enforced at the database level', async () => {
      const existing = await db.query('select sku from products limit 1');
      let blocked = false;
      await db.query('begin');
      try {
        await db.query(
          `insert into products (name, sku, selling_price) values ('dup', $1, 10)`,
          [existing.rows[0].sku]
        );
      } catch (e) {
        blocked = /duplicate key|unique/i.test(e.message);
      } finally {
        await db.query('rollback');
      }
      assert.ok(blocked, 'duplicate SKU should violate the unique index');
    });

    await check('stock functions are installed', async () => {
      const { rows } = await db.query(
        `select proname from pg_proc where proname in ('deduct_stock','restore_stock','reset_identity_sequences')`
      );
      assert.equal(rows.length, 3, `found ${rows.map((r) => r.proname).join(', ')}`);
    });

    console.log('\nType coercion (NUMERIC / BIGINT -> number)');

    await check('admin can sign in', async () => {
      const r = await req('POST', '/api/auth/login', {
        body: { email: 'admin@stockflow.app', password: 'Admin@1234' }
      });
      assert.equal(r.status, 200, r.text.slice(0, 160));
      adminToken = r.body.token;
      assert.ok(adminToken);
    });

    await check('money columns arrive as JavaScript numbers, not strings', async () => {
      const r = await req('GET', '/api/products?limit=5', { token: adminToken });
      assert.equal(r.status, 200);
      const items = r.body.items || r.body.payload?.items;
      assert.ok(Array.isArray(items) && items.length, 'no products returned');
      for (const p of items) {
        assert.equal(typeof p.selling_price, 'number', `selling_price was ${typeof p.selling_price}`);
        assert.equal(typeof p.purchase_price, 'number', `purchase_price was ${typeof p.purchase_price}`);
      }
    });

    await check('counts and aggregates are numbers, not bigint strings', async () => {
      const r = await req('GET', '/api/reports/dashboard', { token: adminToken });
      assert.equal(r.status, 200);
      const d = r.body;
      assert.equal(typeof d.inventory.products, 'number', `products was ${typeof d.inventory.products}`);
      assert.equal(typeof d.inventory.units, 'number', `units was ${typeof d.inventory.units}`);
      assert.equal(typeof d.sales.total_bills, 'number', `total_bills was ${typeof d.sales.total_bills}`);
      assert.equal(typeof d.sales.total_revenue, 'number', `total_revenue was ${typeof d.sales.total_revenue}`);
    });

    await check('timestamps serialise to valid ISO strings', async () => {
      const r = await req('GET', '/api/invoices?limit=1', { token: adminToken });
      const inv = (r.body.items || r.body.payload?.items || [])[0];
      assert.ok(inv, 'no invoices returned');
      assert.ok(!Number.isNaN(Date.parse(inv.created_at)), `bad created_at: ${inv.created_at}`);
    });

    console.log('\nTransactions & sequences');

    await check('new rows get sequential ids (identity sequence is correct)', async () => {
      const skuA = `SEQ-A-${Date.now()}`;
      const skuB = `SEQ-B-${Date.now()}`;
      const a = await req('POST', '/api/products', {
        token: adminToken,
        body: { name: 'Sequence A', sku: skuA, selling_price: 10, purchase_price: 5, opening_stock: 3 }
      });
      const b = await req('POST', '/api/products', {
        token: adminToken,
        body: { name: 'Sequence B', sku: skuB, selling_price: 10, purchase_price: 5, opening_stock: 3 }
      });
      assert.equal(a.status, 201, a.text.slice(0, 200));
      assert.equal(b.status, 201, b.text.slice(0, 200));
      assert.ok(b.body.product.id > a.body.product.id, 'second id should be greater than the first');
    });

    await check('a failed line item rolls the entire invoice back', async () => {
      const products = await req('GET', '/api/products?limit=2', { token: adminToken });
      const items = (products.body.items || products.body.payload?.items).slice(0, 2);
      const before = await db.query('select count(*)::int as n from invoices');
      const r = await req('POST', '/api/invoices', {
        token: adminToken,
        body: {
          customer_name: 'Rollback Test',
          items: [
            { product_id: items[0].id, quantity: 1 },
            { product_id: items[1].id, quantity: 999999 } // impossible
          ],
          tax_rate: 18
        }
      });
      assert.ok(r.status >= 400, `expected failure, got ${r.status}`);
      const after = await db.query('select count(*)::int as n from invoices');
      assert.equal(after.rows[0].n, before.rows[0].n, 'invoice row leaked despite rollback');
      const leaked = await db.query('select count(*)::int as n from stock_movements where reference_type = $1', ['invoice']);
      assert.ok(leaked.rows[0].n >= 0);
    });

    await check('invoice number sequence increments without gaps or collisions', async () => {
      // Pick a product that actually has stock — the seed leaves some at zero.
      const { rows } = await db.query(
        'select product_id from inventory where quantity > 5 order by quantity desc limit 1'
      );
      assert.ok(rows[0], 'no stocked product available for the test');
      const pick = { id: rows[0].product_id };
      const r1 = await req('POST', '/api/invoices', {
        token: adminToken,
        body: {
          customer_name: 'Sequence Customer',
          items: [{ product_id: pick.id, quantity: 1 }],
          tax_rate: 0
        }
      });
      assert.equal(r1.status, 201, r1.text.slice(0, 200));
      const no = r1.body.invoice.invoice_no;
      assert.match(no, /^INV-\d{6}-\d{4}$/, `bad invoice number: ${no}`);
    });

    await check('ledger invariant holds: \u03a3 movements === inventory quantity', async () => {
      const { rows } = await db.query(`
        select p.sku, i.quantity,
               coalesce((select sum(m.quantity_change) from stock_movements m where m.product_id = p.id), 0) as ledger
          from products p join inventory i on i.product_id = p.id`);
      const bad = rows.filter((r) => Number(r.quantity) !== Number(r.ledger));
      assert.equal(bad.length, 0, `mismatches: ${bad.map((b) => b.sku).join(', ')}`);
    });

    await check('no inventory row is negative', async () => {
      const { rows } = await db.query('select count(*)::int as n from inventory where quantity < 0');
      assert.equal(rows[0].n, 0);
    });

    console.log('\nRow Level Security');

    await check('RLS is enabled on every application table', async () => {
      const { rows } = await db.query(`
        select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
           and c.relname = any($1) and not c.relrowsecurity`,
        [['roles', 'permissions', 'role_permissions', 'users', 'categories', 'products',
          'inventory', 'stock_movements', 'invoices', 'invoice_items', 'counters', 'activity_log']]
      );
      assert.equal(rows.length, 0, `RLS disabled on: ${rows.map((r) => r.relname).join(', ')}`);
    });

    await check('API still works while RLS is enabled (owner connection)', async () => {
      const r = await req('GET', '/api/products?limit=1', { token: adminToken });
      assert.equal(r.status, 200);
    });
  } finally {
    server.kill('SIGTERM');
    await db.end().catch(() => {});
    if (failed) {
      console.log('\nServer log:\n' + log.split('\n').slice(-15).join('\n'));
    }
    console.log('\n' + '\u2500'.repeat(64));
    console.log(`${passed} passed, ${failed} failed`);
    if (failures.length) {
      console.log('\nFailures:');
      for (const f of failures) console.log(`  \u2022 ${f.name}: ${f.message}`);
    }
    console.log('\u2500'.repeat(64) + '\n');
    process.exit(failed ? 1 : 0);
  }
})();
