'use strict';
const db = require('../db');
const config = require('../config');
const { round2, toInt } = require('../lib/errors');

/**
 * Inclusive range helper. `from`/`to` are YYYY-MM-DD in the BUSINESS timezone
 * (config.dateShiftMinutes), converted back to real UTC bounds for the query.
 */
function dayRange(from, to) {
  const shift = config.dateShiftMinutes * 60000;
  const startLocal = from ? new Date(`${from}T00:00:00.000Z`) : new Date('1970-01-01T00:00:00.000Z');
  const endLocal = to ? new Date(`${to}T23:59:59.999Z`) : new Date('2999-12-31T23:59:59.999Z');
  const start = new Date(startLocal.getTime() - shift);
  const end = new Date(endLocal.getTime() - shift);
  return { start: db.ts(start), end: db.ts(end) };
}

/** Portable date-bucket expression: SQLite stores ISO text, Postgres uses to_char(). */
const dateKey = (col, mode = 'day') => (db.driver === 'postgres'
  ? `to_char(${col}, '${mode === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD'}')`
  : `substr(${col}, 1, ${mode === 'month' ? 7 : 10})`);

const shiftedKey = (iso, len) => new Date(new Date(iso).getTime() + config.dateShiftMinutes * 60000).toISOString().slice(0, len);
const todayKey = () => shiftedKey(new Date(), 10);

const defaultRange = () => {
  const today = todayKey();
  const from = shiftedKey(new Date(Date.now() - 29 * 86400000), 10);
  return { from, to: today };
};

async function dashboard(conn = db) {
  const today = todayKey();
  const monthStart = today.slice(0, 8) + '01';
  const { start: tStart, end: tEnd } = dayRange(today, today);
  const { start: mStart, end: mEnd } = dayRange(monthStart, today);

  const salesToday = await conn.get(
    `SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*) AS bills FROM invoices
      WHERE status = 'paid' AND created_at >= ? AND created_at <= ?`, tStart, tEnd);
  const salesMonth = await conn.get(
    `SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*) AS bills FROM invoices
      WHERE status = 'paid' AND created_at >= ? AND created_at <= ?`, mStart, mEnd);
  const allTime = await conn.get(
    `SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*) AS bills,
            COALESCE(SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END),0) AS cancelled,
            COALESCE(SUM(CASE WHEN status='refunded' THEN 1 ELSE 0 END),0) AS refunded
       FROM invoices`);

  const inv = await conn.get(`
    SELECT COALESCE(SUM(COALESCE(i.quantity,0)),0) AS units,
           COALESCE(SUM(COALESCE(i.quantity,0) * p.purchase_price),0) AS purchase_value,
           COALESCE(SUM(COALESCE(i.quantity,0) * p.selling_price),0) AS selling_value,
           COUNT(*) AS products,
           COALESCE(SUM(CASE WHEN COALESCE(i.quantity,0) <= p.low_stock_threshold THEN 1 ELSE 0 END),0) AS low_stock
      FROM products p LEFT JOIN inventory i ON i.product_id = p.id WHERE p.status='active'`);

  const users = await conn.get(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status='inactive' THEN 1 ELSE 0 END),0) AS inactive FROM users`);

  // Last 14 days trend (paid invoices only)
  const trendStart = shiftedKey(new Date(Date.now() - 13 * 86400000), 10);
  const trendRows = await conn.all(
    `SELECT ${dateKey('created_at')} AS day, COALESCE(SUM(total),0) AS revenue, COUNT(*) AS bills
       FROM invoices WHERE status='paid' AND created_at >= ?
      GROUP BY ${dateKey('created_at')} ORDER BY day`, dayRange(trendStart, today).start);
  const trendMap = new Map(trendRows.map((r) => [r.day, r]));
  const trend = [];
  for (let i = 13; i >= 0; i--) {
    const d = shiftedKey(new Date(Date.now() - i * 86400000), 10);
    const row = trendMap.get(d);
    trend.push({ day: d, revenue: round2(row ? row.revenue : 0), bills: toInt(row ? row.bills : 0) });
  }

  const lowStock = await conn.all(`
    SELECT p.id, p.name, p.sku, COALESCE(i.quantity,0) AS quantity, p.low_stock_threshold
      FROM products p LEFT JOIN inventory i ON i.product_id = p.id
     WHERE p.status='active' AND COALESCE(i.quantity,0) <= p.low_stock_threshold
     ORDER BY COALESCE(i.quantity,0) ASC LIMIT 8`);

  const recentInvoices = await conn.all(`
    SELECT i.id, i.invoice_no, i.customer_name, i.total, i.status, i.created_at, u.full_name AS created_by_name
      FROM invoices i LEFT JOIN users u ON u.id = i.created_by
     ORDER BY i.created_at DESC, i.id DESC LIMIT 6`);

  const topProducts = await conn.all(`
    SELECT ii.product_id, ii.product_name, ii.sku,
           SUM(ii.quantity) AS units_sold, SUM(ii.line_total) AS revenue
      FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
     WHERE i.status = 'paid' AND i.created_at >= ?
     GROUP BY ii.product_id, ii.product_name, ii.sku
     ORDER BY revenue DESC LIMIT 5`, mStart);

  const categorySplit = await conn.all(`
    SELECT COALESCE(c.name, 'Uncategorised') AS category,
           COUNT(p.id) AS products,
           COALESCE(SUM(COALESCE(i.quantity,0) * p.selling_price),0) AS value
      FROM products p LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN inventory i ON i.product_id = p.id
     WHERE p.status='active'
     GROUP BY COALESCE(c.name, 'Uncategorised') ORDER BY value DESC LIMIT 6`);

  return {
    sales: {
      today_revenue: round2(salesToday.revenue), today_bills: toInt(salesToday.bills),
      month_revenue: round2(salesMonth.revenue), month_bills: toInt(salesMonth.bills),
      total_revenue: round2(allTime.revenue), total_bills: toInt(allTime.bills),
      cancelled: toInt(allTime.cancelled), refunded: toInt(allTime.refunded)
    },
    inventory: {
      units: toInt(inv.units),
      purchase_value: round2(inv.purchase_value),
      selling_value: round2(inv.selling_value),
      potential_profit: round2(Number(inv.selling_value) - Number(inv.purchase_value)),
      products: toInt(inv.products),
      low_stock: toInt(inv.low_stock)
    },
    users: { total: toInt(users.n), inactive: toInt(users.inactive) },
    trend, low_stock: lowStock, recent_invoices: recentInvoices,
    top_products: topProducts, category_split: categorySplit
  };
}

async function salesReport(conn, { from, to, groupBy = 'day' }) {
  const { start, end } = dayRange(from, to);
  const key = dateKey('i.created_at', groupBy === 'month' ? 'month' : 'day');
  const rows = await conn.all(
    `SELECT ${key} AS period,
            COUNT(*) AS bills,
            COALESCE(SUM(i.subtotal),0) AS subtotal,
            COALESCE(SUM(i.discount_amount),0) AS discount,
            COALESCE(SUM(i.tax_amount),0) AS tax,
            COALESCE(SUM(i.total),0) AS revenue,
            COALESCE(SUM(CASE WHEN i.status='cancelled' THEN 1 ELSE 0 END),0) AS cancelled,
            COALESCE(SUM(CASE WHEN i.status='refunded' THEN 1 ELSE 0 END),0) AS refunded
       FROM invoices i
      WHERE i.created_at >= ? AND i.created_at <= ? AND i.status = 'paid'
      GROUP BY ${key} ORDER BY period DESC`, start, end);

  const totals = rows.reduce((acc, r) => ({
    bills: acc.bills + toInt(r.bills),
    subtotal: round2(acc.subtotal + Number(r.subtotal)),
    discount: round2(acc.discount + Number(r.discount)),
    tax: round2(acc.tax + Number(r.tax)),
    revenue: round2(acc.revenue + Number(r.revenue))
  }), { bills: 0, subtotal: 0, discount: 0, tax: 0, revenue: 0 });

  const byPayment = await conn.all(
    `SELECT payment_method, COUNT(*) AS bills, COALESCE(SUM(total),0) AS revenue
       FROM invoices WHERE status='paid' AND created_at >= ? AND created_at <= ?
      GROUP BY payment_method ORDER BY revenue DESC`, start, end);
  const topItems = await conn.all(
    `SELECT ii.product_name, ii.sku, SUM(ii.quantity) AS units, COALESCE(SUM(ii.line_total),0) AS revenue
       FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
      WHERE i.status='paid' AND i.created_at >= ? AND i.created_at <= ?
      GROUP BY ii.product_name, ii.sku ORDER BY revenue DESC LIMIT 12`, start, end);

  return { rows, totals, byPayment, topItems };
}

async function inventoryValuation(conn) {
  const rows = await conn.all(`
    SELECT p.id, p.name, p.sku, COALESCE(c.name,'Uncategorised') AS category,
           COALESCE(i.quantity,0) AS quantity, p.purchase_price, p.selling_price, p.low_stock_threshold
      FROM products p LEFT JOIN inventory i ON i.product_id = p.id
      LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.status='active' ORDER BY (COALESCE(i.quantity,0) * p.purchase_price) DESC`);
  const items = rows.map((r) => ({
    ...r,
    quantity: toInt(r.quantity),
    purchase_value: round2(toInt(r.quantity) * Number(r.purchase_price)),
    selling_value: round2(toInt(r.quantity) * Number(r.selling_price)),
    margin: round2(Number(r.selling_price) - Number(r.purchase_price))
  }));
  const totals = items.reduce((acc, r) => ({
    units: acc.units + r.quantity,
    purchase_value: round2(acc.purchase_value + r.purchase_value),
    selling_value: round2(acc.selling_value + r.selling_value)
  }), { units: 0, purchase_value: 0, selling_value: 0 });
  return { items, totals: { ...totals, potential_profit: round2(totals.selling_value - totals.purchase_value) } };
}

async function productMovementReport(conn, { from, to, productId }) {
  const { start, end } = dayRange(from, to);
  const params = [start, end];
  let extra = '';
  if (productId) { extra = ' AND m.product_id = ?'; params.push(toInt(productId)); }

  const rows = await conn.all(
    `SELECT m.product_id, p.name AS product_name, p.sku,
            COALESCE(SUM(CASE WHEN m.type='in' THEN m.quantity_change ELSE 0 END),0) AS stock_in,
            COALESCE(SUM(CASE WHEN m.type IN ('out') THEN -m.quantity_change ELSE 0 END),0) AS stock_out,
            COALESCE(SUM(CASE WHEN m.type='sale' THEN -m.quantity_change ELSE 0 END),0) AS sold,
            COALESCE(SUM(CASE WHEN m.type IN ('sale_cancel','sale_refund','return') THEN m.quantity_change ELSE 0 END),0) AS returned,
            COALESCE(SUM(CASE WHEN m.type='adjustment' THEN m.quantity_change ELSE 0 END),0) AS adjusted,
            COALESCE(i.quantity,0) AS current_stock
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
       LEFT JOIN inventory i ON i.product_id = p.id
      WHERE m.created_at >= ? AND m.created_at <= ? ${extra}
      GROUP BY m.product_id, p.name, p.sku, i.quantity
      ORDER BY sold DESC, p.name ASC`, ...params);

  const detailed = await conn.all(
    `SELECT m.created_at, p.name AS product_name, p.sku, m.type, m.quantity_change,
            m.quantity_before, m.quantity_after, m.note, u.full_name AS user_name
       FROM stock_movements m JOIN products p ON p.id = m.product_id
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.created_at >= ? AND m.created_at <= ? ${extra}
      ORDER BY m.created_at DESC LIMIT 500`, ...params);

  return { rows, detailed };
}

async function lowStockReport(conn) {
  const rows = await conn.all(`
    SELECT p.id, p.name, p.sku, COALESCE(c.name,'Uncategorised') AS category,
           COALESCE(i.quantity,0) AS quantity, p.low_stock_threshold,
           p.purchase_price, p.selling_price,
           CASE WHEN COALESCE(i.quantity,0) = 0 THEN 'Out of stock' ELSE 'Low stock' END AS status_label
      FROM products p LEFT JOIN inventory i ON i.product_id = p.id
      LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.status='active' AND COALESCE(i.quantity,0) <= p.low_stock_threshold
     ORDER BY COALESCE(i.quantity,0) ASC, p.name ASC`);
  return { items: rows };
}

module.exports = { shiftedKey, todayKey, dateKey, dashboard, salesReport, inventoryValuation, productMovementReport, lowStockReport, dayRange, defaultRange };
