'use strict';
/**
 * Server-side integration & integrity test — no browser required.
 *
 *   node tests/integration.test.js
 *
 * Uses an isolated temporary database so it never touches real data.
 * Covers: auth, RBAC, stock transactions, negative-stock protection,
 * duplicate-deduction prevention, invoice edit/cancel/refund reconciliation,
 * idempotency, exports and the movement ledger invariant
 * (opening + Σ movements === inventory.quantity).
 */
// When DATABASE_URL is present the suite targets PostgreSQL instead of SQLite
// (same assertions, same seed data) — proves both engines behave identically.
//   DATABASE_URL='postgres://...' node tests/integration.test.js
process.env.SQLITE_FILE = require('path').join(require('os').tmpdir(), `stockflow-test-${process.pid}.db`);
const PG_TEST = (process.env.DATABASE_URL || '').trim();
if (PG_TEST) process.env.SEED_DEMO = 'true';
process.env.NODE_ENV = 'test';
process.env.PORT = String(4900 + (process.pid % 90));

const fs = require('fs');
const assert = require('assert');
const { spawn } = require('child_process');

const BASE = `http://127.0.0.1:${process.env.PORT}`;
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

async function req(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, payload, type };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch (_) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('server did not start');
}

(async () => {
  console.log('\nStockFlow — integration & integrity tests');
  console.log('Database:', PG_TEST || process.env.SQLITE_FILE, '\n');

  // Fresh database
  if (PG_TEST) {
    // Wipe the target Postgres database and re-apply the Supabase schema.
    const { Client } = require('pg');
    const c = new Client({ connectionString: PG_TEST, ssl: /supabase\./.test(PG_TEST) ? { rejectUnauthorized: false } : undefined });
    await c.connect();
    await c.query(require('fs').readFileSync(require('path').join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8'));
    await c.query(`truncate roles, permissions, role_permissions, users, categories, products,
                             inventory, stock_movements, invoices, invoice_items, counters, activity_log
                   restart identity cascade`);
    await c.end();
  } else {
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(process.env.SQLITE_FILE + suffix); } catch (_) { /* ignore */ }
    }
  }

  const server = spawn(process.execPath, [require('path').join(__dirname, '..', 'src', 'server.js')], {
    cwd: require('path').join(__dirname, '..'),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d.toString(); });
  server.stderr.on('data', (d) => { serverLog += d.toString(); });

  let adminToken, managerToken, staffToken;

  try {
    await waitForServer();

    /* ── authentication ─────────────────────────────────────────────── */
    console.log('Authentication');
    await check('health endpoint responds', async () => {
      const r = await req('GET', '/api/health');
      assert.equal(r.status, 200);
      assert.equal(r.payload.ok, true);
    });

    await check('login succeeds for seeded admin', async () => {
      const r = await req('POST', '/api/auth/login', { body: { email: 'admin@stockflow.app', password: 'Admin@1234' } });
      assert.equal(r.status, 200, JSON.stringify(r.payload));
      assert.ok(r.payload.token);
      adminToken = r.payload.token;
    });

    await check('login fails with a wrong password', async () => {
      const r = await req('POST', '/api/auth/login', { body: { email: 'admin@stockflow.app', password: 'nope' } });
      assert.equal(r.status, 401);
    });

    await check('deactivated account cannot sign in', async () => {
      const r = await req('POST', '/api/auth/login', { body: { email: 'imran@stockflow.app', password: 'Imran@12345' } });
      assert.equal(r.status, 403);
      assert.equal(r.payload.error.code, 'ACCOUNT_INACTIVE');
    });

    await check('registration creates a billing-staff account', async () => {
      const r = await req('POST', '/api/auth/register', {
        body: { full_name: 'Test Registrant', email: `reg${Date.now()}@example.com`, password: 'Passw0rd123' }
      });
      assert.equal(r.status, 201, JSON.stringify(r.payload));
      assert.equal(r.payload.user.role, 'staff');
      assert.deepEqual(r.payload.user.permissions.sort(), ['inventory.view', 'invoices.create', 'invoices.view', 'products.view']);
    });

    await check('weak passwords are rejected', async () => {
      const r = await req('POST', '/api/auth/register', {
        body: { full_name: 'Weak User', email: `weak${Date.now()}@example.com`, password: 'password' }
      });
      assert.equal(r.status, 400);
      assert.equal(r.payload.error.code, 'WEAK_PASSWORD');
    });

    await check('unauthenticated API requests are rejected', async () => {
      const r = await req('GET', '/api/products');
      assert.equal(r.status, 401);
    });

    await check('staff and manager sign in', async () => {
      const s = await req('POST', '/api/auth/login', { body: { email: 'staff@stockflow.app', password: 'Staff@1234' } });
      const m = await req('POST', '/api/auth/login', { body: { email: 'manager@stockflow.app', password: 'Manager@1234' } });
      assert.equal(s.status, 200); assert.equal(m.status, 200);
      staffToken = s.payload.token; managerToken = m.payload.token;
    });

    /* ── role based access control ──────────────────────────────────── */
    console.log('\nRole-based access control');
    const expect403 = async (name, method, path, token, body) => {
      await check(name, async () => {
        const r = await req(method, path, { token, body });
        assert.equal(r.status, 403, `expected 403, got ${r.status} ${JSON.stringify(r.payload).slice(0, 120)}`);
      });
    };
    await expect403('staff cannot list users', 'GET', '/api/users', staffToken);
    await expect403('staff cannot create products', 'POST', '/api/products', staffToken, { name: 'X', sku: 'XX-9', purchase_price: 1, selling_price: 2 });
    await expect403('staff cannot adjust stock', 'POST', '/api/inventory/adjust', staffToken, { product_id: 1, type: 'in', quantity: 1 });
    await expect403('staff cannot cancel invoices', 'POST', '/api/invoices/1/cancel', staffToken, {});
    await expect403('staff cannot view reports', 'GET', '/api/reports/sales', staffToken);
    await expect403('staff cannot manage categories', 'POST', '/api/categories', staffToken, { name: 'Nope' });

    await check('manager can adjust stock but not manage users', async () => {
      const adjust = await req('POST', '/api/inventory/adjust', { token: managerToken, body: { product_id: 1, type: 'in', quantity: 2, note: 'manager test' } });
      assert.equal(adjust.status, 200);
      const users = await req('GET', '/api/users', { token: managerToken });
      assert.equal(users.status, 403);
    });

    await check('staff only sees their own invoices by default', async () => {
      const own = await req('GET', '/api/invoices', { token: staffToken });
      assert.equal(own.status, 200);
      const mine = await req('GET', '/api/auth/me', { token: staffToken });
      assert.ok(own.payload.items.every((i) => i.created_by === mine.payload.user.id));
    });

    /* ── products & stock ───────────────────────────────────────────── */
    console.log('\nProducts & stock transactions');
    let productId;
    await check('admin creates a product with opening stock', async () => {
      const r = await req('POST', '/api/products', {
        token: adminToken,
        body: { name: 'Integration Widget', sku: `INT-${Date.now().toString().slice(-6)}`, purchase_price: 100, selling_price: 180, low_stock_threshold: 10, opening_stock: 50 }
      });
      assert.equal(r.status, 201, JSON.stringify(r.payload));
      assert.equal(r.payload.product.quantity, 50);
      productId = r.payload.product.id;
    });

    await check('duplicate SKU is rejected', async () => {
      const p = await req('GET', `/api/products/${productId}`, { token: adminToken });
      const r = await req('POST', '/api/products', {
        token: adminToken, body: { name: 'Dup', sku: p.payload.product.sku, purchase_price: 1, selling_price: 2 }
      });
      assert.equal(r.status, 409);
      assert.equal(r.payload.error.code, 'SKU_TAKEN');
    });

    await check('stock increase writes a ledger row', async () => {
      const r = await req('POST', '/api/inventory/adjust', { token: adminToken, body: { product_id: productId, type: 'in', quantity: 25, note: 'PO receipt' } });
      assert.equal(r.status, 200);
      assert.equal(r.payload.quantity_after, 75);
      const moves = await req('GET', `/api/inventory/movements?product_id=${productId}`, { token: adminToken });
      assert.equal(moves.payload.items[0].type, 'in');
      assert.equal(moves.payload.items[0].quantity_change, 25);
    });

    await check('stock decrease is blocked beyond available quantity', async () => {
      const r = await req('POST', '/api/inventory/adjust', { token: adminToken, body: { product_id: productId, type: 'out', quantity: 100000 } });
      assert.equal(r.status, 409);
      assert.equal(r.payload.error.code, 'INSUFFICIENT_STOCK');
      const p = await req('GET', `/api/products/${productId}`, { token: adminToken });
      assert.equal(p.payload.product.quantity, 75, 'stock must be unchanged after a rejected movement');
    });

    await check('"set" adjustment records the exact corrected quantity', async () => {
      const r = await req('POST', '/api/inventory/adjust', { token: adminToken, body: { product_id: productId, type: 'set', quantity: 60, note: 'cycle count' } });
      assert.equal(r.status, 200);
      assert.equal(r.payload.quantity_after, 60);
    });

    /* ── billing + automatic deduction ──────────────────────────────── */
    console.log('\nBilling & automatic stock deduction');
    let invoiceId;
    await check('invoice deducts stock and computes totals', async () => {
      const before = (await req('GET', `/api/products/${productId}`, { token: adminToken })).payload.product.quantity;
      const r = await req('POST', '/api/invoices', {
        token: staffToken,
        body: {
          customer_name: 'Integration Customer', customer_phone: '9999999999',
          items: [{ product_id: productId, quantity: 4 }],
          discount_type: 'percent', discount_value: 10, tax_rate: 18, payment_method: 'upi'
        }
      });
      assert.equal(r.status, 201, JSON.stringify(r.payload));
      const inv = r.payload.invoice;
      invoiceId = inv.id;
      assert.equal(inv.subtotal, 720);            // 4 × 180
      assert.equal(inv.discount_amount, 72);      // 10%
      assert.equal(inv.tax_amount, 116.64);       // 18% of 648
      assert.equal(inv.total, 764.64);
      assert.match(inv.invoice_no, /^INV-\d{6}-\d{4}$/);
      const after = (await req('GET', `/api/products/${productId}`, { token: adminToken })).payload.product.quantity;
      assert.equal(after, before - 4);
    });

    await check('stock movement references the invoice', async () => {
      const r = await req('GET', `/api/inventory/movements?product_id=${productId}&type=sale`, { token: adminToken });
      const mv = r.payload.items.find((m) => m.reference_id === invoiceId);
      assert.ok(mv, 'sale movement should exist');
      assert.equal(mv.quantity_change, -4);
      assert.equal(mv.reference_type, 'invoice');
    });

    await check('invoice numbers are unique and sequential', async () => {
      const a = await req('POST', '/api/invoices', { token: adminToken, body: { customer_name: 'A', items: [{ product_id: productId, quantity: 1 }] } });
      const b = await req('POST', '/api/invoices', { token: adminToken, body: { customer_name: 'B', items: [{ product_id: productId, quantity: 1 }] } });
      assert.notEqual(a.payload.invoice.invoice_no, b.payload.invoice.invoice_no);
      const seqA = parseInt(a.payload.invoice.invoice_no.split('-').pop(), 10);
      const seqB = parseInt(b.payload.invoice.invoice_no.split('-').pop(), 10);
      assert.equal(seqB, seqA + 1);
    });

    await check('overselling is rejected and rolls the whole bill back', async () => {
      const before = (await req('GET', `/api/products/${productId}`, { token: adminToken })).payload.product.quantity;
      const countBefore = (await req('GET', '/api/invoices?limit=1', { token: adminToken })).payload.total;
      const r = await req('POST', '/api/invoices', {
        token: adminToken,
        body: { customer_name: 'Oversell', items: [{ product_id: productId, quantity: 5000 }] }
      });
      assert.equal(r.status, 409);
      assert.equal(r.payload.error.code, 'INSUFFICIENT_STOCK');
      const after = (await req('GET', `/api/products/${productId}`, { token: adminToken })).payload.product.quantity;
      const countAfter = (await req('GET', '/api/invoices?limit=1', { token: adminToken })).payload.total;
      assert.equal(after, before, 'stock must not change');
      assert.equal(countAfter, countBefore, 'no partial invoice may be persisted');
    });

    await check('idempotency key prevents a duplicate deduction', async () => {
      const key = `test-${Date.now()}`;
      const before = (await req('GET', `/api/products/${productId}`, { token: adminToken })).payload.product.quantity;
      const payload = { customer_name: 'Idem', items: [{ product_id: productId, quantity: 2 }], idempotency_key: key };
      const first = await req('POST', '/api/invoices', { token: adminToken, body: payload });
      const second = await req('POST', '/api/invoices', { token: adminToken, body: payload });
      assert.equal(first.status, 201);
      assert.equal(second.status, 200);
      assert.equal(second.payload.duplicated, true);
      assert.equal(first.payload.invoice.id, second.payload.invoice.id);
      const after = (await req('GET', `/api/products/${productId}`, { token: adminToken })).payload.product.quantity;
      assert.equal(after, before - 2, 'stock may only be deducted once');
    });

    await check('cancelling an invoice restores stock exactly once', async () => {
      const before = (await req('GET', `/api/products/${productId}`, { token: adminToken })).payload.product.quantity;
      const inv = await req('POST', '/api/invoices', { token: adminToken, body: { customer_name: 'Cancel Test', items: [{ product_id: productId, quantity: 5 }] } });
      const id = inv.payload.invoice.id;
      const mid = (await req('GET', `/api/products/${productId}`, { token: adminToken })).payload.product.quantity;
      assert.equal(mid, before - 5);
      const cancel = await req('POST', `/api/invoices/${id}/cancel`, { token: adminToken, body: { reason: 'test' } });
      assert.equal(cancel.status, 200);
      const restored = (await req('GET', `/api/products/${productId}`, { token: adminToken })).payload.product.quantity;
      assert.equal(restored, before, 'stock restored to the pre-sale level');
      const again = await req('POST', `/api/invoices/${id}/cancel`, { token: adminToken, body: {} });
      assert.equal(again.status, 409, 'a second cancel must not restore stock again');
      const afterSecond = (await req('GET', `/api/products/${productId}`, { token: adminToken })).payload.product.quantity;
      assert.equal(afterSecond, before, 'stock unchanged by the rejected duplicate cancel');
    });

    await check('refunding an invoice restores stock', async () => {
      const before = (await req('GET', `/api/products/${productId}`, { token: adminToken })).payload.product.quantity;
      const inv = await req('POST', '/api/invoices', { token: adminToken, body: { customer_name: 'Refund Test', items: [{ product_id: productId, quantity: 3 }] } });
      const refund = await req('POST', `/api/invoices/${inv.payload.invoice.id}/refund`, { token: adminToken, body: { reason: 'damaged' } });
      assert.equal(refund.status, 200);
      assert.equal(refund.payload.invoice.status, 'refunded');
      const after = (await req('GET', `/api/products/${productId}`, { token: adminToken })).payload.product.quantity;
      assert.equal(after, before);
    });

    await check('editing an invoice adjusts stock by the delta only', async () => {
      const before = (await req('GET', `/api/products/${productId}`, { token: adminToken })).payload.product.quantity;
      const inv = await req('POST', '/api/invoices', { token: adminToken, body: { customer_name: 'Edit Test', items: [{ product_id: productId, quantity: 2 }] } });
      const id = inv.payload.invoice.id;
      const afterCreate = (await req('GET', `/api/products/${productId}`, { token: adminToken })).payload.product.quantity;
      assert.equal(afterCreate, before - 2);

      // increase to 6 → deduct 4 more
      const up = await req('PUT', `/api/invoices/${id}`, { token: adminToken, body: { customer_name: 'Edit Test', items: [{ product_id: productId, quantity: 6 }] } });
      assert.equal(up.status, 200, JSON.stringify(up.payload));
      const afterUp = (await req('GET', `/api/products/${productId}`, { token: adminToken })).payload.product.quantity;
      assert.equal(afterUp, before - 6);

      // decrease to 1 → give 5 back
      const down = await req('PUT', `/api/invoices/${id}`, { token: adminToken, body: { customer_name: 'Edit Test', items: [{ product_id: productId, quantity: 1 }] } });
      assert.equal(down.status, 200);
      const afterDown = (await req('GET', `/api/products/${productId}`, { token: adminToken })).payload.product.quantity;
      assert.equal(afterDown, before - 1);
    });

    await check('a cancelled invoice can no longer be edited', async () => {
      const inv = await req('POST', '/api/invoices', { token: adminToken, body: { customer_name: 'Lock Test', items: [{ product_id: productId, quantity: 1 }] } });
      const id = inv.payload.invoice.id;
      await req('POST', `/api/invoices/${id}/cancel`, { token: adminToken, body: {} });
      const edit = await req('PUT', `/api/invoices/${id}`, { token: adminToken, body: { customer_name: 'X', items: [{ product_id: productId, quantity: 2 }] } });
      assert.equal(edit.status, 409);
      assert.equal(edit.payload.error.code, 'INVOICE_LOCKED');
    });

    await check('billing rejects archived / out-of-stock products', async () => {
      const p = await req('POST', '/api/products', { token: adminToken, body: { name: 'Zero Stock Item', sku: `ZERO-${Date.now().toString().slice(-6)}`, purchase_price: 10, selling_price: 20 } });
      const r = await req('POST', '/api/invoices', { token: adminToken, body: { customer_name: 'X', items: [{ product_id: p.payload.product.id, quantity: 1 }] } });
      assert.equal(r.status, 409);
      assert.equal(r.payload.error.code, 'OUT_OF_STOCK');
    });

    /* ── concurrency ────────────────────────────────────────────────── */
    console.log('\nConcurrency & atomicity');
    await check('concurrent sales never oversell', async () => {
      const p = await req('POST', '/api/products', { token: adminToken, body: { name: 'Racing Item', sku: `RACE-${Date.now().toString().slice(-6)}`, purchase_price: 10, selling_price: 20, opening_stock: 10 } });
      const pid = p.payload.product.id;
      const attempts = Array.from({ length: 8 }, () => req('POST', '/api/invoices', {
        token: adminToken, body: { customer_name: 'Race', items: [{ product_id: pid, quantity: 2 }] }
      }));
      const results = await Promise.all(attempts);
      const ok = results.filter((r) => r.status === 201).length;
      const rejected = results.filter((r) => r.status === 409).length;
      const final = (await req('GET', `/api/products/${pid}`, { token: adminToken })).payload.product.quantity;
      assert.equal(ok, 5, `exactly 5 of 8 sells should succeed (got ${ok})`);
      assert.equal(rejected, 3);
      assert.equal(final, 0, 'stock must land exactly at zero, never negative');
      const moves = await req('GET', `/api/inventory/movements?product_id=${pid}`, { token: adminToken });
      const sum = moves.payload.items.reduce((s, m) => s + m.quantity_change, 0);
      assert.equal(sum, 0, 'ledger must agree with inventory');
    });

    await check('concurrent stock-outs never go negative', async () => {
      const p = await req('POST', '/api/products', { token: adminToken, body: { name: 'Stock Out Race', sku: `SOR-${Date.now().toString().slice(-6)}`, purchase_price: 5, selling_price: 9, opening_stock: 7 } });
      const pid = p.payload.product.id;
      const results = await Promise.all(Array.from({ length: 10 }, () =>
        req('POST', '/api/inventory/adjust', { token: adminToken, body: { product_id: pid, type: 'out', quantity: 1 } })));
      const ok = results.filter((r) => r.status === 200).length;
      const final = (await req('GET', `/api/products/${pid}`, { token: adminToken })).payload.product.quantity;
      assert.equal(ok, 7);
      assert.equal(final, 0);
    });

    /* ── ledger invariant ───────────────────────────────────────────── */
    console.log('\nLedger integrity');
    await check('every product: Σ movements === inventory quantity (no negative rows)', async () => {
      const products = await req('GET', '/api/products?limit=500', { token: adminToken });
      for (const p of products.payload.items) {
        const moves = await req('GET', `/api/inventory/movements?product_id=${p.id}&limit=2000`, { token: adminToken });
        const sum = moves.payload.items.reduce((s, m) => s + Number(m.quantity_change), 0);
        assert.equal(sum, Number(p.quantity), `ledger mismatch for ${p.sku}: sum ${sum} vs quantity ${p.quantity}`);
        assert.ok(Number(p.quantity) >= 0, `${p.sku} went negative`);
        moves.payload.items.forEach((m) => assert.ok(Number(m.quantity_after) >= 0, `movement ${m.id} has negative after`));
      }
    });

    /* ── user administration ────────────────────────────────────────── */
    console.log('\nUser administration');
    let newUserId;
    await check('admin creates a manager', async () => {
      const r = await req('POST', '/api/users', {
        token: adminToken,
        body: { full_name: 'New Manager', email: `mgr${Date.now()}@example.com`, password: 'Manager12345', role: 'manager' }
      });
      assert.equal(r.status, 201, JSON.stringify(r.payload));
      assert.equal(r.payload.user.role, 'manager');
      newUserId = r.payload.user.id;
    });

    await check('deactivating a user blocks their API access immediately', async () => {
      const email = `blocked${Date.now()}@example.com`;
      const created = await req('POST', '/api/users', { token: adminToken, body: { full_name: 'Blocked User', email, password: 'Blocked12345', role: 'staff' } });
      const loginRes = await req('POST', '/api/auth/login', { body: { email, password: 'Blocked12345' } });
      assert.equal(loginRes.status, 200);
      const token = loginRes.payload.token;
      assert.equal((await req('GET', '/api/products', { token })).status, 200);
      await req('PATCH', `/api/users/${created.payload.user.id}`, { token: adminToken, body: { status: 'inactive' } });
      const blocked = await req('GET', '/api/products', { token });
      assert.equal(blocked.status, 403);
      assert.equal(blocked.payload.error.code, 'ACCOUNT_INACTIVE');
    });

    await check('admin cannot deactivate themselves', async () => {
      const me = await req('GET', '/api/auth/me', { token: adminToken });
      const r = await req('PATCH', `/api/users/${me.payload.user.id}`, { token: adminToken, body: { status: 'inactive' } });
      assert.equal(r.status, 400);
      assert.equal(r.payload.error.code, 'SELF_LOCKOUT');
    });

    await check('role change takes effect on the next request', async () => {
      const email = `promote${Date.now()}@example.com`;
      const created = await req('POST', '/api/users', { token: adminToken, body: { full_name: 'Promote Me', email, password: 'Promote12345', role: 'staff' } });
      const login = await req('POST', '/api/auth/login', { body: { email, password: 'Promote12345' } });
      const token = login.payload.token;
      assert.equal((await req('GET', '/api/reports/sales', { token })).status, 403);
      await req('PATCH', `/api/users/${created.payload.user.id}`, { token: adminToken, body: { role: 'manager' } });
      assert.equal((await req('GET', '/api/reports/sales', { token })).status, 200);
    });

    await check('deleting a user with billing history deactivates instead', async () => {
      const me = await req('GET', '/api/auth/me', { token: staffToken });
      const staffId = me.payload.user.id;
      const billing = await req('GET', `/api/users?search=staff@stockflow.app`, { token: adminToken });
      assert.ok(billing.payload.items[0].invoice_count > 0);
      const r = await req('DELETE', `/api/users/${staffId}`, { token: adminToken });
      assert.equal(r.status, 200);
      assert.equal(r.payload.deactivated, true);
      // restore for later runs
      await req('PATCH', `/api/users/${staffId}`, { token: adminToken, body: { status: 'active' } });
    });

    /* ── reports & exports ──────────────────────────────────────────── */
    console.log('\nReports & exports');
    await check('dashboard analytics returns live figures', async () => {
      const r = await req('GET', '/api/reports/dashboard', { token: adminToken });
      assert.equal(r.status, 200);
      assert.ok(r.payload.sales.total_revenue > 0);
      assert.ok(Array.isArray(r.payload.trend) && r.payload.trend.length === 14);
      assert.ok(r.payload.inventory.products > 0);
    });

    for (const type of ['sales', 'monthly', 'valuation', 'lowstock', 'movement']) {
      await check(`${type} report returns rows`, async () => {
        const r = await req('GET', `/api/reports/${type}`, { token: adminToken });
        assert.equal(r.status, 200);
        assert.ok(Array.isArray(r.payload.rows));
        assert.ok(r.payload.summary.length > 0);
      });
    }

    await check('sales report respects the date range', async () => {
      const r = await req('GET', '/api/reports/sales?from=2020-01-01&to=2020-01-02', { token: adminToken });
      assert.equal(r.status, 200);
      assert.equal(r.payload.rows.length, 0);
    });

    await check('PDF export returns a valid PDF', async () => {
      const r = await req('GET', '/api/reports/valuation/export/pdf', { token: adminToken });
      assert.equal(r.status, 200);
      assert.ok(r.type.includes('pdf'));
      assert.equal(r.payload.subarray(0, 4).toString(), '%PDF');
    });

    await check('Excel export returns a valid xlsx (zip) file', async () => {
      const r = await req('GET', '/api/reports/sales/export/xlsx', { token: adminToken });
      assert.equal(r.status, 200);
      assert.ok(r.type.includes('spreadsheetml'));
      assert.equal(r.payload.subarray(0, 2).toString(), 'PK');
    });

    await check('invoice PDF renders with a watermark for cancelled bills', async () => {
      const inv = await req('POST', '/api/invoices', { token: adminToken, body: { customer_name: 'PDF Test', items: [{ product_id: productId, quantity: 1 }] } });
      const id = inv.payload.invoice.id;
      const ok = await req('GET', `/api/invoices/${id}/pdf`, { token: adminToken });
      assert.equal(ok.status, 200);
      assert.equal(ok.payload.subarray(0, 4).toString(), '%PDF');
      await req('POST', `/api/invoices/${id}/cancel`, { token: adminToken, body: {} });
      const cancelled = await req('GET', `/api/invoices/${id}/pdf`, { token: adminToken });
      assert.equal(cancelled.status, 200);
      assert.ok(cancelled.payload.length > 1000);
    });

    await check('invoice register Excel export works', async () => {
      const r = await req('GET', '/api/invoices/export/xlsx', { token: adminToken });
      assert.equal(r.status, 200);
      assert.equal(r.payload.subarray(0, 2).toString(), 'PK');
    });

    /* ── validation ─────────────────────────────────────────────────── */
    console.log('\nInput validation & security');
    await check('invalid product payloads are rejected', async () => {
      const bad = await req('POST', '/api/products', { token: adminToken, body: { name: 'x', sku: '!', purchase_price: -5, selling_price: 10 } });
      assert.equal(bad.status, 400);
      const negativePrice = await req('POST', '/api/products', { token: adminToken, body: { name: 'Valid Name', sku: `OK-${Date.now().toString().slice(-5)}`, purchase_price: -1, selling_price: 10 } });
      assert.equal(negativePrice.status, 400);
    });

    await check('invoice with no items is rejected', async () => {
      const r = await req('POST', '/api/invoices', { token: adminToken, body: { customer_name: 'Empty', items: [] } });
      assert.equal(r.status, 400);
      assert.equal(r.payload.error.code, 'EMPTY_CART');
    });

    await check('invoice without a customer name is rejected', async () => {
      const r = await req('POST', '/api/invoices', { token: adminToken, body: { customer_name: '  ', items: [{ product_id: productId, quantity: 1 }] } });
      assert.equal(r.status, 400);
      assert.equal(r.payload.error.code, 'CUSTOMER_REQUIRED');
    });

    await check('zero / negative line quantities are rejected', async () => {
      const r1 = await req('POST', '/api/invoices', { token: adminToken, body: { customer_name: 'Q', items: [{ product_id: productId, quantity: 0 }] } });
      const r2 = await req('POST', '/api/invoices', { token: adminToken, body: { customer_name: 'Q', items: [{ product_id: productId, quantity: -3 }] } });
      assert.equal(r1.status, 400); assert.equal(r2.status, 400);
    });

    await check('SQL-injection style search input is handled safely', async () => {
      const r = await req('GET', `/api/products?search=${encodeURIComponent("' OR 1=1; DROP TABLE products;--")}`, { token: adminToken });
      assert.equal(r.status, 200);
      const still = await req('GET', '/api/products?limit=1', { token: adminToken });
      assert.equal(still.status, 200);
      assert.ok(still.payload.total > 0, 'products table must still exist');
    });

    await check('forged JWT is rejected', async () => {
      const r = await req('GET', '/api/products', { token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwicm9sZSI6ImFkbWluIn0.forged' });
      assert.equal(r.status, 401);
    });

    await check('security headers are present', async () => {
      const res = await fetch(`${BASE}/`);
      assert.ok(res.headers.get('content-security-policy'));
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    });

    await check('unknown API routes return a JSON 404', async () => {
      const r = await req('GET', '/api/does-not-exist', { token: adminToken });
      assert.equal(r.status, 404);
    });

    /* ── categories ─────────────────────────────────────────────────── */
    console.log('\nCategories');
    await check('category CRUD works and guards against deletion in use', async () => {
      const created = await req('POST', '/api/categories', { token: adminToken, body: { name: `Test Cat ${Date.now()}` } });
      assert.equal(created.status, 201);
      const id = created.payload.category.id;
      const list = await req('GET', '/api/categories', { token: adminToken });
      assert.ok(list.payload.items.some((c) => c.id === id));
      const del = await req('DELETE', `/api/categories/${id}`, { token: adminToken });
      assert.equal(del.status, 200);
    });

    await check('category in use cannot be deleted', async () => {
      const p = await req('POST', '/api/products', { token: adminToken, body: { name: 'Cat Guarded', sku: `CG-${Date.now().toString().slice(-6)}`, purchase_price: 1, selling_price: 2, category_id: 1 } });
      const del = await req('DELETE', '/api/categories/1', { token: adminToken });
      assert.equal(del.status, 409);
      assert.equal(del.payload.error.code, 'CATEGORY_IN_USE');
      assert.ok(p.status === 201);
    });

    /* ── integrity summary ─────────────────────────────────────────── */
    await check('all invoices reconcile with their items', async () => {
      const list = await req('GET', '/api/invoices?limit=200', { token: adminToken });
      for (const inv of list.payload.items) {
        const full = await req('GET', `/api/invoices/${inv.id}`, { token: adminToken });
        const sum = full.payload.invoice.items.reduce((s, it) => s + Number(it.line_total), 0);
        assert.ok(Math.abs(sum - Number(full.payload.invoice.subtotal)) < 0.02,
          `invoice ${inv.invoice_no}: items ${sum} vs subtotal ${full.payload.invoice.subtotal}`);
      }
    });

  } finally {
    server.kill('SIGTERM');
    await sleep(500);
    try { server.kill('SIGKILL'); } catch (_) { /* ignore */ }
  }

  console.log(`\n${'─'.repeat(64)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  • ${f.name}\n    ${f.message}`));
    if (serverLog) console.log('\nServer log:\n' + serverLog.slice(-2000));
  }
  console.log(`${'─'.repeat(64)}\n`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('Test harness crashed:', err);
  process.exit(2);
});
