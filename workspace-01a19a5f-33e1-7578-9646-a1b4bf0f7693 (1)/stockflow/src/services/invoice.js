'use strict';
const db = require('../db');
const { httpError, toNumber, toInt, round2 } = require('../lib/errors');

const nowIso = () => db.ts(new Date());
const inventory = require('./inventory');

/**
 * Billing service.
 *
 * Every state change (create / edit / cancel / refund) runs as ONE database
 * transaction that touches the invoice, its items and the stock movements
 * together. Two protections keep stock correct under concurrency and retries:
 *
 *  • Guarded atomic UPDATE in inventory.applyStockMovement — cannot go negative.
 *  • Conditional status transition `WHERE status = 'paid'` — a cancel/refund can
 *    only restore stock once, even if the request is replayed.
 *  • Optional `idempotency_key` on invoices — a double-submitted bill returns
 *    the original invoice instead of deducting stock twice.
 */

const VALID_PAYMENTS = ['cash', 'card', 'upi', 'bank', 'credit'];

function monthPrefix(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `INV-${y}${m}-`;
}

/**
 * Atomically reserves the next invoice number inside the current transaction.
 * The sequence is derived from the highest existing number for the month as well
 * as the counter row, so imported/seeded bills can never cause a collision.
 */
async function nextInvoiceNo(conn) {
  const prefix = monthPrefix();                        // e.g. INV-202611-
  const key = 'invoice:' + prefix.slice(0, -1);        // e.g. invoice:INV-202611

  const latest = await conn.get(
    'SELECT invoice_no FROM invoices WHERE invoice_no LIKE ? ORDER BY invoice_no DESC LIMIT 1',
    prefix + '%'
  );
  let highest = 0;
  if (latest && latest.invoice_no) {
    const parsed = parseInt(String(latest.invoice_no).slice(prefix.length), 10);
    if (Number.isFinite(parsed)) highest = parsed;
  }

  const existing = await conn.get('SELECT value FROM counters WHERE name = ?', key);
  if (!existing) {
    await conn.run('INSERT INTO counters (name, value) VALUES (?, ?)', key, highest);
  } else if (Number(existing.value) < highest) {
    await conn.run('UPDATE counters SET value = ? WHERE name = ?', highest, key);
  }

  await conn.run('UPDATE counters SET value = value + 1 WHERE name = ?', key);
  const row = await conn.get('SELECT value FROM counters WHERE name = ?', key);
  return `${prefix}${String(toInt(row.value, 1)).padStart(4, '0')}`;
}

function computeTotals({ subtotal, discountType, discountValue, taxRate }) {
  const sub = round2(Math.max(0, toNumber(subtotal)));
  let discountAmount = 0;
  if (discountType === 'percent') {
    const pct = Math.min(100, Math.max(0, toNumber(discountValue)));
    discountAmount = round2((sub * pct) / 100);
  } else {
    discountAmount = round2(Math.min(sub, Math.max(0, toNumber(discountValue))));
  }
  const taxable = round2(sub - discountAmount);
  const taxAmount = round2((taxable * Math.max(0, toNumber(taxRate))) / 100);
  const total = round2(taxable + taxAmount);
  return { subtotal: sub, discount_amount: discountAmount, tax_amount: taxAmount, total, taxable };
}

/** Validates + normalises the incoming cart against live product data. */
async function normaliseItems(conn, rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw httpError(400, 'EMPTY_CART', 'Add at least one product to the bill.');
  }
  const merged = new Map();
  for (const raw of rawItems) {
    const productId = toInt(raw.product_id ?? raw.productId);
    const qty = toInt(raw.quantity ?? raw.qty);
    if (!productId) throw httpError(400, 'INVALID_ITEM', 'Every bill line needs a product.');
    if (!Number.isFinite(qty) || qty <= 0) throw httpError(400, 'INVALID_QUANTITY', 'Quantity must be a positive whole number.');
    if (qty > 100000) throw httpError(400, 'INVALID_QUANTITY', 'Quantity is unrealistically large.');
    const price = raw.unit_price === undefined || raw.unit_price === null || raw.unit_price === ''
      ? null : toNumber(raw.unit_price);
    if (price !== null && price < 0) throw httpError(400, 'INVALID_PRICE', 'Unit price cannot be negative.');
    merged.set(productId, { product_id: productId, quantity: (merged.get(productId)?.quantity || 0) + qty, unit_price: price });
  }

  const items = [];
  for (const line of merged.values()) {
    const product = await conn.get(
      `SELECT p.id, p.name, p.sku, p.selling_price, p.status, COALESCE(i.quantity,0) AS quantity
         FROM products p LEFT JOIN inventory i ON i.product_id = p.id WHERE p.id = ?`, line.product_id
    );
    if (!product) throw httpError(404, 'PRODUCT_NOT_FOUND', `Product #${line.product_id} no longer exists.`);
    if (product.status !== 'active') throw httpError(400, 'PRODUCT_ARCHIVED', `${product.name} is archived and cannot be sold.`);
    if (toInt(product.quantity) <= 0) throw httpError(409, 'OUT_OF_STOCK', `${product.name} is out of stock.`);
    const unitPrice = round2(line.unit_price === null ? product.selling_price : line.unit_price);
    items.push({
      product_id: product.id,
      product_name: product.name,
      sku: product.sku,
      unit_price: unitPrice,
      quantity: line.quantity,
      line_total: round2(unitPrice * line.quantity),
      available: toInt(product.quantity)
    });
  }
  return items;
}

function parseInvoicePayload(body) {
  const items = body.items || body.lines || [];
  const customerName = String(body.customer_name ?? body.customerName ?? '').trim();
  if (!customerName) throw httpError(400, 'CUSTOMER_REQUIRED', 'Customer name is required.');
  if (customerName.length > 120) throw httpError(400, 'INVALID_CUSTOMER', 'Customer name is too long.');
  const discountType = body.discount_type === 'fixed' ? 'fixed' : 'percent';
  const taxRate = Math.min(100, Math.max(0, toNumber(body.tax_rate ?? body.taxRate ?? 0)));
  const payment = VALID_PAYMENTS.includes(body.payment_method) ? body.payment_method : 'cash';
  return {
    customer_name: customerName,
    customer_phone: String(body.customer_phone || '').trim() || null,
    customer_email: String(body.customer_email || '').trim() || null,
    customer_address: String(body.customer_address || '').trim() || null,
    notes: String(body.notes || '').trim() || null,
    discount_type: discountType,
    discount_value: Math.max(0, toNumber(body.discount_value ?? body.discountValue ?? 0)),
    tax_rate: taxRate,
    payment_method: payment,
    idempotency_key: body.idempotency_key ? String(body.idempotency_key).slice(0, 80) : null,
    rawItems: items
  };
}

async function createInvoice(body, user) {
  const payload = parseInvoicePayload(body);

  return db.tx(async (conn) => {
    // Idempotency: the same submission must never deduct stock twice.
    if (payload.idempotency_key) {
      const existing = await conn.get('SELECT id FROM invoices WHERE idempotency_key = ?', payload.idempotency_key);
      if (existing) {
        const full = await findInvoice(conn, existing.id);
        return { invoice: full, duplicated: true };
      }
    }

    const items = await normaliseItems(conn, payload.rawItems);
    const subtotal = round2(items.reduce((s, i) => s + i.line_total, 0));
    const totals = computeTotals({
      subtotal, discountType: payload.discount_type, discountValue: payload.discount_value, taxRate: payload.tax_rate
    });

    const invoiceNo = await nextInvoiceNo(conn);
    const ts = nowIso();
    const ins = await conn.run(
      `INSERT INTO invoices
        (invoice_no, customer_name, customer_phone, customer_email, customer_address, status,
         subtotal, discount_type, discount_value, discount_amount, tax_rate, tax_amount, total,
         payment_method, notes, created_by, updated_by, created_at, updated_at, idempotency_key)
       VALUES (?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      invoiceNo, payload.customer_name, payload.customer_phone, payload.customer_email, payload.customer_address,
      totals.subtotal, payload.discount_type, payload.discount_value, totals.discount_amount,
      payload.tax_rate, totals.tax_amount, totals.total, payload.payment_method, payload.notes,
      user.id, user.id, ts, ts, payload.idempotency_key
    );
    const invoiceId = ins.lastInsertRowid;

    for (const item of items) {
      await conn.run(
        `INSERT INTO invoice_items (invoice_id, product_id, product_name, sku, unit_price, quantity, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        invoiceId, item.product_id, item.product_name, item.sku, item.unit_price, item.quantity, item.line_total
      );
      // Throws INSUFFICIENT_STOCK -> whole transaction rolls back (no partial bill).
      await inventory.applyStockMovement(conn, {
        productId: item.product_id,
        delta: -item.quantity,
        type: 'sale',
        note: `Sold on invoice ${invoiceNo}`,
        userId: user.id,
        unitCost: item.unit_price,
        referenceType: 'invoice',
        referenceId: invoiceId
      });
    }

    const invoice = await findInvoice(conn, invoiceId);
    return { invoice, duplicated: false };
  });
}

async function findInvoice(conn, id) {
  const invoice = await conn.get(
    `SELECT i.*, u.full_name AS created_by_name, cu.full_name AS cancelled_by_name
       FROM invoices i
       LEFT JOIN users u ON u.id = i.created_by
       LEFT JOIN users cu ON cu.id = i.cancelled_by
      WHERE i.id = ?`, toInt(id)
  );
  if (!invoice) throw httpError(404, 'INVOICE_NOT_FOUND', 'Invoice not found.');
  const items = await conn.all(
    `SELECT ii.*, p.image_url FROM invoice_items ii
       LEFT JOIN products p ON p.id = ii.product_id
      WHERE ii.invoice_id = ? ORDER BY ii.id`, invoice.id
  );
  return { ...invoice, items };
}

async function getInvoice(id) {
  return findInvoice(db, id);
}

async function listInvoices(conn, opts = {}) {
  const { search = '', status = '', from = '', to = '', userId = '', limit = 100, offset = 0 } = opts;
  const where = [];
  const params = [];
  if (search) {
    where.push('(LOWER(i.invoice_no) LIKE ? OR LOWER(i.customer_name) LIKE ? OR LOWER(COALESCE(i.customer_phone,\'\')) LIKE ?)');
    const q = `%${String(search).toLowerCase()}%`;
    params.push(q, q, q);
  }
  if (status) { where.push('i.status = ?'); params.push(status); }
  if (from) { where.push('i.created_at >= ?'); params.push(from); }
  if (to) { where.push('i.created_at <= ?'); params.push(to); }
  if (userId) { where.push('i.created_by = ?'); params.push(toInt(userId)); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const rows = await conn.all(
    `SELECT i.*, u.full_name AS created_by_name,
            (SELECT COUNT(*) FROM invoice_items ii WHERE ii.invoice_id = i.id) AS item_count
       FROM invoices i LEFT JOIN users u ON u.id = i.created_by
       ${clause} ORDER BY i.created_at DESC, i.id DESC LIMIT ? OFFSET ?`,
    ...params, toInt(limit, 100), toInt(offset, 0)
  );
  const totalRow = await conn.get(`SELECT COUNT(*) AS n FROM invoices i ${clause}`, ...params);
  return { items: rows, total: toInt(totalRow && totalRow.n) };
}

/**
 * Edit an existing invoice. Only the delta per product is moved, so stock stays
 * exactly consistent with the difference between the old and the new bill.
 */
async function updateInvoice(id, body, user) {
  const payload = parseInvoicePayload(body);
  const invoiceId = toInt(id);

  return db.tx(async (conn) => {
    const current = await conn.get('SELECT * FROM invoices WHERE id = ?', invoiceId);
    if (!current) throw httpError(404, 'INVOICE_NOT_FOUND', 'Invoice not found.');
    if (current.status !== 'paid') {
      throw httpError(409, 'INVOICE_LOCKED', `A ${current.status} invoice can no longer be edited.`);
    }

    const oldItems = await conn.all('SELECT product_id, quantity, unit_price FROM invoice_items WHERE invoice_id = ?', invoiceId);
    const items = await normaliseItems(conn, payload.rawItems);

    const oldMap = new Map();
    for (const oi of oldItems) oldMap.set(oi.product_id, (oldMap.get(oi.product_id) || 0) + oi.quantity);
    const newMap = new Map();
    for (const ni of items) newMap.set(ni.product_id, (newMap.get(ni.product_id) || 0) + ni.quantity);

    // Restore / deduct only the difference per product.
    for (const [productId, oldQty] of oldMap) {
      const newQty = newMap.get(productId) || 0;
      const delta = oldQty - newQty; // positive = give stock back
      if (delta > 0) {
        await inventory.applyStockMovement(conn, {
          productId, delta, type: 'sale_cancel',
          note: `Invoice ${current.invoice_no} edited — quantity returned`,
          userId: user.id, referenceType: 'invoice', referenceId: invoiceId
        });
      }
    }
    for (const [productId, newQty] of newMap) {
      const oldQty = oldMap.get(productId) || 0;
      const delta = oldQty - newQty; // negative = sell more
      if (delta < 0) {
        await inventory.applyStockMovement(conn, {
          productId, delta, type: 'sale',
          note: `Invoice ${current.invoice_no} edited — additional quantity`,
          userId: user.id, referenceType: 'invoice', referenceId: invoiceId
        });
      }
    }

    const subtotal = round2(items.reduce((s, i) => s + i.line_total, 0));
    const totals = computeTotals({
      subtotal, discountType: payload.discount_type, discountValue: payload.discount_value, taxRate: payload.tax_rate
    });

    await conn.run('DELETE FROM invoice_items WHERE invoice_id = ?', invoiceId);
    for (const item of items) {
      await conn.run(
        `INSERT INTO invoice_items (invoice_id, product_id, product_name, sku, unit_price, quantity, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        invoiceId, item.product_id, item.product_name, item.sku, item.unit_price, item.quantity, item.line_total
      );
    }

    await conn.run(
      `UPDATE invoices SET customer_name = ?, customer_phone = ?, customer_email = ?, customer_address = ?,
              subtotal = ?, discount_type = ?, discount_value = ?, discount_amount = ?, tax_rate = ?,
              tax_amount = ?, total = ?, payment_method = ?, notes = ?, updated_by = ?, updated_at = ?
        WHERE id = ?`,
      payload.customer_name, payload.customer_phone, payload.customer_email, payload.customer_address,
      totals.subtotal, payload.discount_type, payload.discount_value, totals.discount_amount,
      payload.tax_rate, totals.tax_amount, totals.total, payload.payment_method, payload.notes,
      user.id, nowIso(), invoiceId
    );

    return { invoice: await findInvoice(conn, invoiceId) };
  });
}

/** Cancels a paid invoice and returns every unit to stock — exactly once. */
async function cancelInvoice(id, { reason, user }) {
  const invoiceId = toInt(id);
  return db.tx(async (conn) => {
    const current = await conn.get('SELECT * FROM invoices WHERE id = ?', invoiceId);
    if (!current) throw httpError(404, 'INVOICE_NOT_FOUND', 'Invoice not found.');
    if (current.status !== 'paid') {
      throw httpError(409, 'INVOICE_ALREADY_CLOSED', `This invoice is already ${current.status}.`);
    }

    // Atomic guard: only one request can flip paid -> cancelled.
    const flip = await conn.run(
      `UPDATE invoices SET status = 'cancelled', cancelled_by = ?, cancelled_reason = ?, cancelled_at = ?,
              updated_by = ?, updated_at = ? WHERE id = ? AND status = 'paid'`,
      user.id, String(reason || 'Cancelled by ' + user.full_name).slice(0, 240), nowIso(), user.id, nowIso(), invoiceId
    );
    if (!flip || flip.changes !== 1) {
      throw httpError(409, 'INVOICE_ALREADY_CLOSED', 'This invoice was just cancelled by another request.');
    }

    const items = await conn.all('SELECT product_id, quantity FROM invoice_items WHERE invoice_id = ?', invoiceId);
    for (const item of items) {
      await inventory.applyStockMovement(conn, {
        productId: item.product_id,
        delta: item.quantity,
        type: 'sale_cancel',
        note: `Invoice ${current.invoice_no} cancelled — stock restored`,
        userId: user.id,
        referenceType: 'invoice',
        referenceId: invoiceId
      });
    }
    return { invoice: await findInvoice(conn, invoiceId) };
  });
}

/** Marks a paid invoice refunded and returns the goods to stock. */
async function refundInvoice(id, { reason, user }) {
  const invoiceId = toInt(id);
  return db.tx(async (conn) => {
    const current = await conn.get('SELECT * FROM invoices WHERE id = ?', invoiceId);
    if (!current) throw httpError(404, 'INVOICE_NOT_FOUND', 'Invoice not found.');
    if (current.status !== 'paid') {
      throw httpError(409, 'INVOICE_ALREADY_CLOSED', `This invoice is already ${current.status}.`);
    }

    const flip = await conn.run(
      `UPDATE invoices SET status = 'refunded', refunded_at = ?, cancelled_reason = ?, updated_by = ?, updated_at = ?
        WHERE id = ? AND status = 'paid'`,
      nowIso(), String(reason || 'Refunded by ' + user.full_name).slice(0, 240), user.id, nowIso(), invoiceId
    );
    if (!flip || flip.changes !== 1) {
      throw httpError(409, 'INVOICE_ALREADY_CLOSED', 'This invoice was just closed by another request.');
    }

    const items = await conn.all('SELECT product_id, quantity FROM invoice_items WHERE invoice_id = ?', invoiceId);
    for (const item of items) {
      await inventory.applyStockMovement(conn, {
        productId: item.product_id,
        delta: item.quantity,
        type: 'sale_refund',
        note: `Invoice ${current.invoice_no} refunded — stock restored`,
        userId: user.id,
        referenceType: 'invoice',
        referenceId: invoiceId
      });
    }
    return { invoice: await findInvoice(conn, invoiceId) };
  });
}

module.exports = {
  createInvoice, updateInvoice, cancelInvoice, refundInvoice,
  getInvoice, findInvoice, listInvoices, computeTotals, nextInvoiceNo, VALID_PAYMENTS, monthPrefix
};
