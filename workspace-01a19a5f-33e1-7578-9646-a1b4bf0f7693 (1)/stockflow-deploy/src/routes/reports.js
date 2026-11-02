'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const { asyncHandler, httpError, toInt, round2 } = require('../lib/errors');
const { requirePermission } = require('../lib/auth');
const reports = require('../services/reports');
const { buildReportXlsx, buildReportPdf, money, dateOnly } = require('../services/export');

const router = express.Router();
const sym = config.company.symbol;
/** Indian digit grouping, e.g. ₹10,33,663.00 */
const currency = (n) => `${sym}${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Every report is described once and can render as JSON, PDF or Excel. */
const REPORTS = {
  sales: {
    title: 'Sales Report',
    permission: 'reports.view',
    columns: [
      { header: 'Period', key: 'period', weight: 1.2, width: 16 },
      { header: 'Bills', key: 'bills', align: 'right', weight: 0.7, width: 10 },
      { header: 'Subtotal', key: 'subtotal', align: 'right', weight: 1.1, width: 16, value: (r) => currency(r.subtotal) },
      { header: 'Discount', key: 'discount', align: 'right', weight: 1, width: 14, value: (r) => currency(r.discount) },
      { header: 'Tax', key: 'tax', align: 'right', weight: 1, width: 14, value: (r) => currency(r.tax) },
      { header: 'Revenue', key: 'revenue', align: 'right', weight: 1.2, width: 16, value: (r) => currency(r.revenue) }
    ],
    async load(query) {
      const { from, to } = rangeFromQuery(query);
      const groupBy = query.groupBy === 'month' ? 'month' : 'day';
      const data = await reports.salesReport(db, { from, to, groupBy });
      return {
        subtitle: `${groupBy === 'month' ? 'Month-wise' : 'Day-wise'} · ${from} to ${to}`,
        rows: data.rows,
        totals: data.totals,
        topItems: data.topItems,
        byPayment: data.byPayment,
        summary: [
          ['Bills', String(data.totals.bills)],
          ['Gross subtotal', currency(data.totals.subtotal)],
          ['Discounts', currency(data.totals.discount)],
          ['Tax collected', currency(data.totals.tax)],
          ['Net revenue', currency(data.totals.revenue)],
          ['Payment mix', data.byPayment.map((p) => `${p.payment_method}: ${currency(p.revenue)}`).join(' · ') || '—']
        ],
        extra: { topItems: data.topItems, byPayment: data.byPayment }
      };
    }
  },
  monthly: {
    title: 'Monthly Sales Report',
    permission: 'reports.view',
    columns: [
      { header: 'Month', key: 'period', weight: 1.2, width: 16 },
      { header: 'Bills', key: 'bills', align: 'right', weight: 0.7, width: 10 },
      { header: 'Subtotal', key: 'subtotal', align: 'right', weight: 1.1, width: 16, value: (r) => currency(r.subtotal) },
      { header: 'Discount', key: 'discount', align: 'right', weight: 1, width: 14, value: (r) => currency(r.discount) },
      { header: 'Tax', key: 'tax', align: 'right', weight: 1, width: 14, value: (r) => currency(r.tax) },
      { header: 'Revenue', key: 'revenue', align: 'right', weight: 1.2, width: 16, value: (r) => currency(r.revenue) }
    ],
    async load(query) {
      const { from, to } = rangeFromQuery(query);
      const data = await reports.salesReport(db, { from, to, groupBy: 'month' });
      return {
        subtitle: `Month-wise · ${from} to ${to}`,
        rows: data.rows,
        totals: data.totals,
        topItems: data.topItems,
        byPayment: data.byPayment,
        summary: [
          ['Bills', String(data.totals.bills)],
          ['Net revenue', currency(data.totals.revenue)],
          ['Average bill value', currency(data.totals.bills ? data.totals.revenue / data.totals.bills : 0)]
        ],
        extra: { topItems: data.topItems, byPayment: data.byPayment }
      };
    }
  },
  valuation: {
    title: 'Inventory Valuation',
    permission: 'reports.view',
    columns: [
      { header: 'Product', key: 'name', weight: 2.2, width: 32 },
      { header: 'SKU', key: 'sku', weight: 1, width: 16 },
      { header: 'Category', key: 'category', weight: 1.2, width: 18 },
      { header: 'Qty', key: 'quantity', align: 'right', weight: 0.6, width: 8 },
      { header: 'Purchase', key: 'purchase_price', align: 'right', weight: 0.9, width: 13, value: (r) => currency(r.purchase_price) },
      { header: 'Selling', key: 'selling_price', align: 'right', weight: 0.9, width: 13, value: (r) => currency(r.selling_price) },
      { header: 'Stock value (cost)', key: 'purchase_value', align: 'right', weight: 1.1, width: 15, value: (r) => currency(r.purchase_value) },
      { header: 'Stock value (retail)', key: 'selling_value', align: 'right', weight: 1.1, width: 15, value: (r) => currency(r.selling_value) }
    ],
    async load() {
      const data = await reports.inventoryValuation(db);
      return {
        subtitle: `As of ${new Date().toLocaleString('en-IN')}`,
        rows: data.items,
        items: data.items,
        totals: data.totals,
        summary: [
          ['Active products', String(data.items.length)],
          ['Total units', String(data.totals.units)],
          ['Inventory cost value', currency(data.totals.purchase_value)],
          ['Inventory retail value', currency(data.totals.selling_value)],
          ['Potential profit', currency(data.totals.potential_profit)]
        ]
      };
    }
  },
  lowstock: {
    title: 'Low Stock Report',
    permission: 'reports.view',
    columns: [
      { header: 'Product', key: 'name', weight: 2.2, width: 32 },
      { header: 'SKU', key: 'sku', weight: 1, width: 16 },
      { header: 'Category', key: 'category', weight: 1.2, width: 18 },
      { header: 'In stock', key: 'quantity', align: 'right', weight: 0.7, width: 10 },
      { header: 'Threshold', key: 'low_stock_threshold', align: 'right', weight: 0.8, width: 11 },
      { header: 'Status', key: 'status_label', weight: 1, width: 14 },
      { header: 'Restock value', key: 'restock', align: 'right', weight: 1, width: 14, value: (r) => currency(Math.max(0, r.low_stock_threshold - r.quantity) * r.purchase_price) }
    ],
    async load() {
      const data = await reports.lowStockReport(db);
      const restock = data.items.reduce((s, r) => s + Math.max(0, r.low_stock_threshold - r.quantity) * Number(r.purchase_price), 0);
      return {
        subtitle: `Items at or below their reorder level · ${new Date().toLocaleDateString('en-IN')}`,
        rows: data.items,
        items: data.items,
        summary: [
          ['Items to reorder', String(data.items.length)],
          ['Out of stock', String(data.items.filter((r) => r.quantity === 0).length)],
          ['Estimated restock cost', currency(round2(restock))]
        ]
      };
    }
  },
  movement: {
    title: 'Product Movement Report',
    permission: 'reports.view',
    columns: [
      { header: 'Product', key: 'product_name', weight: 2, width: 30 },
      { header: 'SKU', key: 'sku', weight: 1, width: 15 },
      { header: 'Stock in', key: 'stock_in', align: 'right', weight: 0.8, width: 11 },
      { header: 'Sold', key: 'sold', align: 'right', weight: 0.8, width: 11 },
      { header: 'Returned', key: 'returned', align: 'right', weight: 0.8, width: 11 },
      { header: 'Adjusted', key: 'adjusted', align: 'right', weight: 0.8, width: 11 },
      { header: 'In stock', key: 'current_stock', align: 'right', weight: 0.8, width: 11 }
    ],
    async load(query) {
      const { from, to } = rangeFromQuery(query);
      const data = await reports.productMovementReport(db, { from, to, productId: query.product_id });
      return {
        subtitle: `Movements between ${from} and ${to}`,
        rows: data.rows,
        detailed: data.detailed,
        summary: [
          ['Products moved', String(data.rows.length)],
          ['Units sold', String(data.rows.reduce((s, r) => s + Number(r.sold || 0), 0))],
          ['Units received', String(data.rows.reduce((s, r) => s + Number(r.stock_in || 0), 0))]
        ]
      };
    }
  }
};

function rangeFromQuery(query) {
  const d = reports.defaultRange();
  return { from: query.from || d.from, to: query.to || d.to };
}

router.get('/dashboard', asyncHandler(async (req, res) => {
  res.json(await reports.dashboard(db));
}));

router.get('/:type', asyncHandler(async (req, res) => {
  const def = REPORTS[req.params.type];
  if (!def) throw httpError(404, 'REPORT_NOT_FOUND', 'Unknown report type.');
  if (!req.user.permissions.includes(def.permission)) {
    throw httpError(403, 'FORBIDDEN', 'You do not have permission to view reports.');
  }
  const data = await def.load(req.query);
  res.json({ title: def.title, ...data, columns: def.columns.map((c) => ({ header: c.header, key: c.key, align: c.align })) });
}));

async function exportHandler(req, res) {
  const def = REPORTS[req.params.type];
  if (!def) throw httpError(404, 'REPORT_NOT_FOUND', 'Unknown report type.');
  if (!req.user.permissions.includes(def.permission)) throw httpError(403, 'FORBIDDEN', 'You do not have permission to export reports.');
  const format = String(req.params.format).toLowerCase();
  const data = await def.load(req.query);
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === 'pdf') {
    const buffer = await buildReportPdf({
      title: def.title, subtitle: data.subtitle, columns: def.columns, rows: data.rows, summary: data.summary
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="stockflow-${req.params.type}-${stamp}.pdf"`);
    return res.send(buffer);
  }
  if (format === 'xlsx' || format === 'excel') {
    const buffer = await buildReportXlsx({
      title: def.title, subtitle: data.subtitle,
      columns: def.columns.map((c) => ({ header: c.header, key: c.key, align: c.align, width: c.width, value: c.value })),
      rows: data.rows, summary: data.summary, sheetName: def.title
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="stockflow-${req.params.type}-${stamp}.xlsx"`);
    return res.send(Buffer.from(buffer));
  }
  throw httpError(400, 'INVALID_FORMAT', 'Export format must be pdf or xlsx.');
}

router.get('/:type/export/:format', (req, res, next) => {
  Promise.resolve(exportHandler(req, res)).catch(next);
});

module.exports = router;
