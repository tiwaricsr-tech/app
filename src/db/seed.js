'use strict';
/**
 * Seeds roles, permissions and (optionally) a realistic demo dataset.
 *   node src/db/seed.js          -> seed reference data only
 *   node src/db/seed.js --reset  -> wipe and re-create demo data (destructive)
 */
const db = require('./index');
const { ROLES, PERMISSIONS, ROLE_MATRIX } = require('../lib/perm');
const { hashPassword } = require('../lib/auth');
const config = require('../config');

const ts = () => db.ts(new Date());
const daysAgo = (n, hour = 11) => {
  const d = new Date(Date.now() - n * 86400000);
  d.setHours(hour, 15, 0, 0);
  return db.ts(d);
};
const pick = (arr, i) => arr[i % arr.length];
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const DEMO_USERS = [
  { full_name: 'Aarav Mehta', email: 'admin@stockflow.app', password: 'Admin@1234', role: 'admin', phone: '+91 98260 11223' },
  { full_name: 'Priya Sharma', email: 'manager@stockflow.app', password: 'Manager@1234', role: 'manager', phone: '+91 98260 44556' },
  { full_name: 'Rohan Verma', email: 'staff@stockflow.app', password: 'Staff@1234', role: 'staff', phone: '+91 98260 77889' },
  { full_name: 'Neha Iyer', email: 'neha@stockflow.app', password: 'Neha@12345', role: 'staff', phone: '+91 90000 12345' },
  { full_name: 'Imran Qureshi', email: 'imran@stockflow.app', password: 'Imran@12345', role: 'staff', phone: '+91 90000 67890' }
];

const CATEGORIES = [
  ['Electronics', 'Laptops, monitors, audio and accessories'],
  ['Furniture', 'Office and home furniture'],
  ['Stationery', 'Paper, pens and office consumables'],
  ['Networking', 'Routers, switches and cabling'],
  ['Packaging', 'Boxes, tape and shipping supplies']
];

const PRODUCTS = [
  ['ProBook 14" Laptop', 'ELEC-1001', 'Electronics', 54500, 63999, 6, 4],
  ['UltraWide 34" Monitor', 'ELEC-1002', 'Electronics', 28500, 34999, 8, 12],
  ['Wireless Ergonomic Mouse', 'ELEC-1003', 'Electronics', 890, 1499, 25, 64],
  ['Mechanical Keyboard TKL', 'ELEC-1004', 'Electronics', 3400, 4799, 15, 38],
  ['Noise-Cancelling Headset', 'ELEC-1005', 'Electronics', 6200, 8499, 10, 7],
  ['USB-C Docking Station', 'ELEC-1006', 'Electronics', 7800, 10499, 12, 21],
  ['27" 4K IPS Monitor', 'ELEC-1007', 'Electronics', 21000, 26999, 6, 3],
  ['Ergonomic Mesh Chair', 'FURN-2001', 'Furniture', 8900, 12499, 10, 18],
  ['Height Adjustable Desk', 'FURN-2002', 'Furniture', 14500, 19999, 5, 6],
  ['Mobile Pedestal 3-Drawer', 'FURN-2003', 'Furniture', 4200, 5999, 8, 14],
  ['Bookshelf 5-Tier', 'FURN-2004', 'Furniture', 5100, 7299, 6, 2],
  ['Standing Desk Converter', 'FURN-2005', 'Furniture', 6800, 9499, 6, 9],
  ['A4 Copier Paper (500)', 'STAT-3001', 'Stationery', 240, 349, 40, 220],
  ['Gel Pen Pack (10)', 'STAT-3002', 'Stationery', 95, 159, 50, 340],
  ['Sticky Notes 3x3 (12)', 'STAT-3003', 'Stationery', 180, 279, 30, 145],
  ['Whiteboard Marker Set', 'STAT-3004', 'Stationery', 210, 329, 25, 88],
  ['Lever Arch File', 'STAT-3005', 'Stationery', 145, 249, 30, 12],
  ['Stapler Heavy Duty', 'STAT-3006', 'Stationery', 480, 749, 12, 26],
  ['Gigabit Router AX3000', 'NETW-4001', 'Networking', 4200, 5999, 10, 16],
  ['8-Port PoE Switch', 'NETW-4002', 'Networking', 6500, 8999, 8, 5],
  ['Cat6 Cable 305m Box', 'NETW-4003', 'Networking', 5400, 7299, 6, 11],
  ['Wi-Fi 6 Mesh Node', 'NETW-4004', 'Networking', 8900, 12499, 6, 0],
  ['Patch Panel 24-Port', 'NETW-4005', 'Networking', 3100, 4499, 8, 13],
  ['Corrugated Box 12x12', 'PACK-5001', 'Packaging', 42, 79, 100, 640],
  ['Bubble Wrap Roll 1m', 'PACK-5002', 'Packaging', 620, 949, 20, 34],
  ['Packing Tape 65m (6)', 'PACK-5003', 'Packaging', 380, 599, 25, 76],
  ['Thermal Label Roll', 'PACK-5004', 'Packaging', 240, 429, 30, 9],
  ['Stretch Wrap 500mm', 'PACK-5005', 'Packaging', 310, 529, 20, 41]
];

const CUSTOMERS = [
  ['Rakesh Kulkarni', '+91 98260 33445', 'rakesh@brightline.in', 'Brightline Solutions, Indore'],
  ['Sneha Kapoor', '+91 97000 22118', 'sneha@sundaram.co.in', 'Sundaram Traders, Bhopal'],
  ['Vikram Rathore', '+91 93000 77551', 'vikram@rathoregroup.in', 'Rathore Group, Gwalior'],
  ['Anita Desai', '+91 98220 66420', 'anita@clearwater.in', 'Clearwater Labs, Pune'],
  ['Mohit Joshi', '+91 99870 12345', 'mohit@joshiassociates.in', 'Joshi & Associates, Nagpur'],
  ['Farah Sheikh', '+91 90040 55667', 'farah@auroraedu.in', 'Aurora Institute, Bhopal'],
  ['Deepak Nair', '+91 97400 88221', 'deepak@zenithinfra.in', 'Zenith Infra, Kochi'],
  ['Walk-in Customer', null, null, null]
];

async function seedReference(conn = db) {
  const now = ts();
  for (const role of ROLES) {
    const existing = await conn.get('SELECT id FROM roles WHERE name = ?', role.name);
    if (!existing) {
      await conn.run(
        // Boolean, not 1/0 — Postgres rejects an integer here (SQLite tolerated it).
        'INSERT INTO roles (name, label, description, is_system, created_at) VALUES (?, ?, ?, true, ?)',
        role.name, role.label, role.description, now
      );
    }
  }
  for (const [code, description] of PERMISSIONS) {
    const existing = await conn.get('SELECT id FROM permissions WHERE code = ?', code);
    if (!existing) await conn.run('INSERT INTO permissions (code, description) VALUES (?, ?)', code, description);
  }
  for (const [roleName, codes] of Object.entries(ROLE_MATRIX)) {
    const role = await conn.get('SELECT id FROM roles WHERE name = ?', roleName);
    for (const code of codes) {
      const perm = await conn.get('SELECT id FROM permissions WHERE code = ?', code);
      const has = await conn.get('SELECT 1 AS ok FROM role_permissions WHERE role_id = ? AND permission_id = ?', role.id, perm.id);
      if (!has) await conn.run('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', role.id, perm.id);
    }
  }
}

async function resetData() {
  const tables = ['invoice_items', 'invoices', 'stock_movements', 'inventory', 'activity_log', 'products', 'categories', 'counters'];
  for (const t of tables) {
    try { await db.run(`DELETE FROM ${t}`); } catch (_) { /* ignore */ }
  }
  await db.run("DELETE FROM users WHERE email <> 'admin@stockflow.app'");
}

async function seedDemo() {
  const now = ts();

  for (const u of DEMO_USERS) {
    const role = await db.get('SELECT id FROM roles WHERE name = ?', u.role);
    const existing = await db.get('SELECT id FROM users WHERE LOWER(email) = ?', u.email.toLowerCase());
    const hash = await hashPassword(u.password);
    if (existing) {
      await db.run('UPDATE users SET password_hash = ?, role_id = ?, status = ?, full_name = ?, phone = ?, updated_at = ? WHERE id = ?',
        hash, role.id, 'active', u.full_name, u.phone, now, existing.id);
    } else {
      await db.run(
        `INSERT INTO users (full_name, email, password_hash, phone, role_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
        u.full_name, u.email, hash, u.phone, role.id, now, now
      );
    }
  }
  // One intentionally deactivated account to demo admin controls.
  await db.run("UPDATE users SET status='inactive' WHERE email = 'imran@stockflow.app'");

  const catIds = {};
  for (const [name, description] of CATEGORIES) {
    const existing = await db.get('SELECT id FROM categories WHERE name = ?', name);
    catIds[name] = existing ? existing.id : (await db.run(
      'INSERT INTO categories (name, description, created_at) VALUES (?, ?, ?)', name, description, now
    )).lastInsertRowid;
  }

  const productIds = [];
  for (const [name, sku, cat, purchase, selling, threshold, qty] of PRODUCTS) {
    const existing = await db.get('SELECT id FROM products WHERE sku = ?', sku);
    if (existing) {
      const inv = await db.get('SELECT id FROM inventory WHERE product_id = ?', existing.id);
      if (!inv) await db.run('INSERT INTO inventory (product_id, quantity, updated_at) VALUES (?, ?, ?)', existing.id, 0, now);
      productIds.push(existing.id);
      continue;
    }
    const ins = await db.run(
      `INSERT INTO products (name, sku, category_id, image_url, description, purchase_price, selling_price,
                             low_stock_threshold, status, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'active', ?, ?)`,
      name, sku, catIds[cat], `${name} — supplied by ${cat.toLowerCase()} division.`,
      purchase, selling, threshold, daysAgo(120), now
    );
    const id = ins.lastInsertRowid;
    await db.run('INSERT INTO inventory (product_id, quantity, updated_at) VALUES (?, ?, ?)', id, qty, now);
    if (qty > 0) {
      await db.run(
        `INSERT INTO stock_movements (product_id, type, quantity_change, quantity_before, quantity_after,
            unit_cost, reference_type, reference_id, note, user_id, created_at)
         VALUES (?, 'in', ?, 0, ?, ?, 'product', ?, 'Opening stock', 1, ?)`,
        id, qty, qty, purchase, id, daysAgo(120, 9)
      );
    }
    productIds.push(id);
  }

  // ── demo invoices spread over the last 45 days ──────────────────────────────
  const invoiceCount = await db.get('SELECT COUNT(*) AS n FROM invoices');
  if (Number(invoiceCount.n) > 0) return;

  const staff = await db.all("SELECT u.id, u.full_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.status='active'");
  const counters = new Map();
  const monthKey = (d) => `INV-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

  const productRows = await db.all('SELECT id, name, sku, selling_price, purchase_price FROM products ORDER BY id');

  for (let day = 44; day >= 0; day--) {
    const bills = day < 15 ? rand(1, 3) : rand(1, 2);
    for (let b = 0; b < bills; b++) {
      const when = daysAgo(day, rand(9, 19));
      const dateObj = new Date(when);
      const key = monthKey(dateObj);
      const seq = (counters.get(key) || 0) + 1;
      counters.set(key, seq);
      const invoiceNo = `${key}-${String(seq).padStart(4, '0')}`;

      const lineCount = rand(1, 4);
      const chosen = new Map();
      for (let i = 0; i < lineCount; i++) {
        const p = pick(productRows, rand(0, productRows.length - 1));
        const stock = await db.get('SELECT quantity FROM inventory WHERE product_id = ?', p.id);
        const available = Number(stock.quantity);
        if (available <= 0) continue;
        const want = rand(1, 4);
        const qty = Math.min(want, available);
        const prev = chosen.get(p.id);
        chosen.set(p.id, { ...p, quantity: prev ? prev.quantity + qty : qty });
      }
      const picked = [...chosen.values()].filter((it) => it.quantity > 0);
      if (picked.length === 0) continue;
      // Re-clamp merged quantities to what is actually on hand.
      const items = [];
      for (const it of picked) {
        const stock = await db.get('SELECT quantity FROM inventory WHERE product_id = ?', it.id);
        const available = Number(stock.quantity);
        if (available <= 0) continue;
        items.push({ ...it, quantity: Math.min(it.quantity, available) });
      }
      if (items.length === 0) continue;

      const subtotal = items.reduce((s, i) => s + Number(i.selling_price) * i.quantity, 0);
      const discountType = Math.random() < 0.35 ? 'percent' : 'fixed';
      const discountValue = discountType === 'percent' ? pick([5, 10], rand(0, 1)) : pick([100, 250, 500], rand(0, 2));
      const discountAmount = discountType === 'percent'
        ? Math.round(subtotal * discountValue) / 100
        : Math.min(subtotal, discountValue);
      const taxRate = pick([0, 5, 18], rand(0, 2));
      const taxAmount = Math.round((subtotal - discountAmount) * taxRate) / 100;
      const total = Math.round((subtotal - discountAmount + taxAmount) * 100) / 100;
      const customer = pick(CUSTOMERS, rand(0, CUSTOMERS.length - 1));
      const creator = pick(staff, rand(0, staff.length - 1));
      const status = Math.random() < 0.92 ? 'paid' : (Math.random() < 0.5 ? 'cancelled' : 'refunded');

      const invIns = await db.run(
        `INSERT INTO invoices (invoice_no, customer_name, customer_phone, customer_email, customer_address, status,
            subtotal, discount_type, discount_value, discount_amount, tax_rate, tax_amount, total, payment_method,
            notes, created_by, updated_by, cancelled_by, cancelled_reason, cancelled_at, refunded_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        invoiceNo, customer[0], customer[1], customer[2], customer[3], status,
        Math.round(subtotal * 100) / 100, discountType, discountValue, Math.round(discountAmount * 100) / 100,
        taxRate, Math.round(taxAmount * 100) / 100, total, pick(['cash', 'card', 'upi', 'bank'], rand(0, 3)),
        creator.id, creator.id,
        status === 'paid' ? null : creator.id,
        status === 'paid' ? null : 'Customer request (demo data)',
        status === 'paid' ? null : when,
        status === 'refunded' ? when : null,
        when, when
      );
      const invoiceId = invIns.lastInsertRowid;

      for (const item of items) {
        await db.run(
          `INSERT INTO invoice_items (invoice_id, product_id, product_name, sku, unit_price, quantity, line_total)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          invoiceId, item.id, item.name, item.sku, item.selling_price, item.quantity,
          Math.round(Number(item.selling_price) * item.quantity * 100) / 100
        );
        // Every bill deducts stock at billing time...
        const stock = await db.get('SELECT quantity FROM inventory WHERE product_id = ?', item.id);
        const before = Number(stock.quantity);
        await db.run('UPDATE inventory SET quantity = quantity - ? WHERE product_id = ?', item.quantity, item.id);
        await db.run(
          `INSERT INTO stock_movements (product_id, type, quantity_change, quantity_before, quantity_after,
              unit_cost, reference_type, reference_id, note, user_id, created_at)
           VALUES (?, 'sale', ?, ?, ?, ?, 'invoice', ?, ?, ?, ?)`,
          item.id, -item.quantity, before, before - item.quantity, item.selling_price, invoiceId,
          `Sold on invoice ${invoiceNo}`, creator.id, when
        );
        // ...and cancelled/refunded bills put every unit back.
        if (status !== 'paid') {
          const later = db.ts(new Date(new Date(when).getTime() + 3600 * 1000));
          const s2 = await db.get('SELECT quantity FROM inventory WHERE product_id = ?', item.id);
          const b2 = Number(s2.quantity);
          await db.run('UPDATE inventory SET quantity = quantity + ? WHERE product_id = ?', item.quantity, item.id);
          await db.run(
            `INSERT INTO stock_movements (product_id, type, quantity_change, quantity_before, quantity_after,
                unit_cost, reference_type, reference_id, note, user_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'invoice', ?, ?, ?, ?)`,
            item.id, status === 'cancelled' ? 'sale_cancel' : 'sale_refund', item.quantity, b2, b2 + item.quantity,
            item.selling_price, invoiceId,
            `Invoice ${invoiceNo} ${status} — stock restored`, creator.id, later
          );
        }
      }
    }
  }

  // A few replenishment movements so movement reports look alive
  for (let i = 0; i < 12; i++) {
    const p = pick(productRows, rand(0, productRows.length - 1));
    const qty = rand(5, 40);
    const stock = await db.get('SELECT quantity FROM inventory WHERE product_id = ?', p.id);
    const before = Number(stock.quantity);
    const when = daysAgo(rand(1, 40), rand(9, 18));
    await db.run('UPDATE inventory SET quantity = quantity + ? WHERE product_id = ?', qty, p.id);
    await db.run(
      `INSERT INTO stock_movements (product_id, type, quantity_change, quantity_before, quantity_after,
          unit_cost, reference_type, reference_id, note, user_id, created_at)
       VALUES (?, 'in', ?, ?, ?, ?, 'manual', NULL, 'Purchase order received', 1, ?)`,
      p.id, qty, before, before + qty, p.purchase_price, when
    );
  }
}

async function ensureSeed({ silent = false } = {}) {
  await seedReference(db);
  const anyUser = await db.get('SELECT COUNT(*) AS n FROM users');
  if (Number(anyUser.n) === 0) {
    await seedDemo();
    if (!silent) console.log('Seeded demo users, catalogue, 90+ invoices and stock history.');
  }
}

if (require.main === module) {
  (async () => {
    await db.init();
    await seedReference(db);
    if (process.argv.includes('--reset')) await resetData();
    await seedDemo();
    console.log('\nStockFlow data ready.\n');
    console.log('  Admin    admin@stockflow.app    / Admin@1234');
    console.log('  Manager  manager@stockflow.app  / Manager@1234');
    console.log('  Staff    staff@stockflow.app    / Staff@1234');
    console.log('  Staff    neha@stockflow.app     / Neha@12345   (active)');
    console.log('  Staff    imran@stockflow.app    / Imran@12345  (deactivated)\n');
  })().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { ensureSeed, seedReference, seedDemo, resetData, DEMO_USERS };
