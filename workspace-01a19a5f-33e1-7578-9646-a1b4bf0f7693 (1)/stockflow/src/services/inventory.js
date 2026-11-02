'use strict';
const db = require('../db');
const { httpError, round2, toInt } = require('../lib/errors');

const nowIso = () => db.ts(new Date());

/**
 * Inventory / stock service.
 *
 * Stock is ONLY mutated through this module. Every mutation:
 *   1. runs inside a database transaction,
 *   2. uses a guarded atomic UPDATE (`... WHERE quantity >= ?`) so a concurrent
 *      sale can never drive stock negative or double-deduct,
 *   3. writes an immutable stock_movements audit row.
 */

const SELECT_INVENTORY = `
  SELECT p.id, p.name, p.sku, p.image_url, p.description, p.purchase_price, p.selling_price,
         p.low_stock_threshold, p.status, p.created_at, p.updated_at,
         c.id AS category_id, c.name AS category_name,
         COALESCE(i.quantity, 0) AS quantity,
         i.updated_at AS stock_updated_at
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN inventory i ON i.product_id = p.id
`;

function decorate(row) {
  if (!row) return row;
  return {
    ...row,
    quantity: toInt(row.quantity, 0),
    stock_value_purchase: round2(toInt(row.quantity) * Number(row.purchase_price || 0)),
    stock_value_selling: round2(toInt(row.quantity) * Number(row.selling_price || 0)),
    is_low_stock: toInt(row.quantity, 0) <= toInt(row.low_stock_threshold, 0)
  };
}

/** Create the 1:1 inventory row for a product (called inside product creation tx). */
async function ensureInventoryRow(conn, productId, quantity = 0) {
  const existing = await conn.get('SELECT id FROM inventory WHERE product_id = ?', productId);
  if (existing) return existing.id;
  const res = await conn.run(
    'INSERT INTO inventory (product_id, quantity, updated_at) VALUES (?, ?, ?)',
    productId, Math.max(0, toInt(quantity)), nowIso()
  );
  return res.lastInsertRowid;
}

async function listInventory(conn, opts = {}) {
  const {
    search = '', categoryId = '', status = '', lowOnly = false,
    sort = 'name', dir = 'asc', limit = 500, offset = 0
  } = opts;

  const where = [];
  const params = [];

  if (search) {
    where.push('(LOWER(p.name) LIKE ? OR LOWER(p.sku) LIKE ? OR LOWER(COALESCE(c.name, \'\')) LIKE ?)');
    const q = `%${String(search).toLowerCase()}%`;
    params.push(q, q, q);
  }
  if (categoryId) { where.push('p.category_id = ?'); params.push(toInt(categoryId)); }
  if (status) { where.push('p.status = ?'); params.push(status); }
  if (lowOnly) where.push('COALESCE(i.quantity, 0) <= p.low_stock_threshold');

  const sortable = {
    name: 'p.name', sku: 'p.sku', quantity: 'quantity', selling_price: 'p.selling_price',
    purchase_price: 'p.purchase_price', category: 'c.name', updated_at: 'p.updated_at', created_at: 'p.created_at'
  };
  const orderBy = `${sortable[sort] || 'p.name'} ${String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`;
  const sql = `${SELECT_INVENTORY} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;

  const rows = await conn.all(sql, ...params, toInt(limit, 500), toInt(offset, 0));
  const totalRow = await conn.get(
    `SELECT COUNT(*) AS n FROM products p LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN inventory i ON i.product_id = p.id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
    ...params
  );
  return { items: rows.map(decorate), total: toInt(totalRow && totalRow.n) };
}

async function getProduct(conn, id) {
  const row = await conn.get(`${SELECT_INVENTORY} WHERE p.id = ?`, toInt(id));
  if (!row) throw httpError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  return decorate(row);
}

async function getBySku(conn, sku) {
  const row = await conn.get(`${SELECT_INVENTORY} WHERE LOWER(p.sku) = LOWER(?)`, String(sku || ''));
  return row ? decorate(row) : null;
}

/**
 * Core atomic stock mutation. MUST be called with a transaction-scoped conn.
 * Throws INSUFFICIENT_STOCK instead of ever allowing a negative quantity.
 */
async function applyStockMovement(conn, {
  productId, delta, type, note, userId, unitCost = null, referenceType = null, referenceId = null
}) {
  const change = toInt(delta);
  if (!change) throw httpError(400, 'INVALID_QUANTITY', 'Quantity change cannot be zero.');
  if (!['in', 'out', 'sale', 'sale_cancel', 'sale_refund', 'adjustment'].includes(type)) {
    throw httpError(400, 'INVALID_MOVEMENT_TYPE', 'Unknown stock movement type.');
  }

  const product = await conn.get('SELECT id, name, sku, status FROM products WHERE id = ?', toInt(productId));
  if (!product) throw httpError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');

  await ensureInventoryRow(conn, productId, 0);

  // Guarded UPDATE — the database refuses the write if stock would go negative.
  const guard = change < 0
    ? 'UPDATE inventory SET quantity = quantity + ?, updated_at = ? WHERE product_id = ? AND quantity >= ?'
    : 'UPDATE inventory SET quantity = quantity + ?, updated_at = ? WHERE product_id = ?';
  const params = change < 0
    ? [change, nowIso(), productId, Math.abs(change)]
    : [change, nowIso(), productId];

  const res = await conn.run(guard, ...params);
  if (!res || res.changes !== 1) {
    const cur = await conn.get('SELECT quantity FROM inventory WHERE product_id = ?', productId);
    throw httpError(409, 'INSUFFICIENT_STOCK',
      `Insufficient stock for ${product.name}. Available: ${cur ? cur.quantity : 0}, requested: ${Math.abs(change)}.`,
      { product_id: product.id, product: product.name, available: cur ? cur.quantity : 0, requested: Math.abs(change) });
  }

  const after = await conn.get('SELECT quantity FROM inventory WHERE product_id = ?', productId);
  const quantityAfter = toInt(after.quantity);
  const quantityBefore = quantityAfter - change;

  if (quantityAfter < 0) throw httpError(409, 'NEGATIVE_STOCK', 'Stock cannot be negative.');

  const movement = await conn.run(
    `INSERT INTO stock_movements
       (product_id, type, quantity_change, quantity_before, quantity_after, unit_cost,
        reference_type, reference_id, note, user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    productId, type, change, quantityBefore, quantityAfter,
    unitCost === null || unitCost === undefined ? null : round2(unitCost),
    referenceType, referenceId, note || null, userId || null, nowIso()
  );

  return {
    movement_id: movement.lastInsertRowid,
    product_id: productId,
    quantity_before: quantityBefore,
    quantity_after: quantityAfter,
    change
  };
}

/** Public stock adjustment (stock in / stock out / manual correction). */
async function adjustStock({ productId, delta, type, note, user, unitCost }) {
  return db.tx(async (conn) => {
    const product = await getProduct(conn, productId);
    if (product.status !== 'active' && delta < 0) {
      throw httpError(400, 'PRODUCT_ARCHIVED', 'Archived products cannot be issued.');
    }
    const movementType = type === 'set' ? 'adjustment' : (['in', 'out', 'adjustment'].includes(type) ? type : 'adjustment');
    let effectiveDelta = toInt(delta);
    if (type === 'set') effectiveDelta = toInt(delta) - product.quantity;
    const result = await applyStockMovement(conn, {
      productId, delta: effectiveDelta, type: movementType,
      note: note || (movementType === 'in' ? 'Stock received' : 'Stock issued'),
      userId: user.id, unitCost: unitCost != null ? unitCost : product.purchase_price,
      referenceType: 'manual'
    });
    return { ...result, product: product.name, sku: product.sku };
  });
}

async function listMovements(conn, opts = {}) {
  const { productId = '', type = '', search = '', from = '', to = '', limit = 200, offset = 0 } = opts;
  const where = [];
  const params = [];
  if (productId) { where.push('m.product_id = ?'); params.push(toInt(productId)); }
  if (type) { where.push('m.type = ?'); params.push(type); }
  if (from) { where.push('m.created_at >= ?'); params.push(from); }
  if (to) { where.push('m.created_at <= ?'); params.push(to); }
  if (search) {
    where.push('(LOWER(p.name) LIKE ? OR LOWER(p.sku) LIKE ? OR LOWER(COALESCE(m.note, \'\')) LIKE ?)');
    const q = `%${String(search).toLowerCase()}%`;
    params.push(q, q, q);
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = await conn.all(
    `SELECT m.*, p.name AS product_name, p.sku, u.full_name AS user_name
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
       LEFT JOIN users u ON u.id = m.user_id
       ${clause}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ? OFFSET ?`,
    ...params, toInt(limit, 200), toInt(offset, 0)
  );
  const totalRow = await conn.get(
    `SELECT COUNT(*) AS n FROM stock_movements m JOIN products p ON p.id = m.product_id ${clause}`, ...params
  );
  return { items: rows, total: toInt(totalRow && totalRow.n) };
}

async function inventorySummary(conn) {
  const totals = await conn.get(`
    SELECT COUNT(*) AS product_count,
           COALESCE(SUM(COALESCE(i.quantity,0)), 0) AS total_units,
           COALESCE(SUM(COALESCE(i.quantity,0) * p.purchase_price), 0) AS purchase_value,
           COALESCE(SUM(COALESCE(i.quantity,0) * p.selling_price), 0) AS selling_value,
           COALESCE(SUM(CASE WHEN COALESCE(i.quantity,0) <= p.low_stock_threshold THEN 1 ELSE 0 END), 0) AS low_stock_count,
           COALESCE(SUM(CASE WHEN COALESCE(i.quantity,0) = 0 THEN 1 ELSE 0 END), 0) AS out_of_stock_count
      FROM products p LEFT JOIN inventory i ON i.product_id = p.id
     WHERE p.status = 'active'
  `);
  return {
    product_count: toInt(totals.product_count),
    total_units: toInt(totals.total_units),
    purchase_value: round2(totals.purchase_value),
    selling_value: round2(totals.selling_value),
    potential_profit: round2(Number(totals.selling_value) - Number(totals.purchase_value)),
    low_stock_count: toInt(totals.low_stock_count),
    out_of_stock_count: toInt(totals.out_of_stock_count)
  };
}

async function lowStock(conn, limit = 100) {
  const rows = await conn.all(`
    SELECT p.id, p.name, p.sku, p.image_url, p.purchase_price, p.selling_price, p.low_stock_threshold,
           c.name AS category_name, COALESCE(i.quantity,0) AS quantity
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id
      LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.status = 'active' AND COALESCE(i.quantity,0) <= p.low_stock_threshold
     ORDER BY (COALESCE(i.quantity,0) * 1.0 / NULLIF(p.low_stock_threshold,0)) ASC, COALESCE(i.quantity,0) ASC
     LIMIT ?`, toInt(limit, 100));
  return rows.map((r) => ({
    ...r,
    quantity: toInt(r.quantity),
    severity: toInt(r.quantity) === 0 ? 'out_of_stock' : 'low'
  }));
}

module.exports = {
  SELECT_INVENTORY, decorate, ensureInventoryRow, listInventory, getProduct, getBySku,
  applyStockMovement, adjustStock, listMovements, inventorySummary, lowStock
};
