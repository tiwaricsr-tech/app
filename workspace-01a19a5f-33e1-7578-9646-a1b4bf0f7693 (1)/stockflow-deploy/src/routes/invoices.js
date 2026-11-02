'use strict';
const express = require('express');
const { asyncHandler, httpError, toInt } = require('../lib/errors');
const { requirePermission, logActivity } = require('../lib/auth');
const invoices = require('../services/invoice');
const { buildInvoicePdf, buildReportXlsx } = require('../services/export');
const config = require('../config');
const db = require('../db');

const router = express.Router();

router.get('/', requirePermission('invoices.view'), asyncHandler(async (req, res) => {
  const { search, status, from, to, user_id, limit, offset } = req.query;
  // Billing staff only see their own bills; managers/admins see everything.
  const ownOnly = req.user.role_name === 'staff' && !req.query.all;
  res.json(await invoices.listInvoices(db, {
    search, status, from, to, limit, offset,
    userId: ownOnly ? req.user.id : user_id
  }));
}));

router.get('/:id', requirePermission('invoices.view'), asyncHandler(async (req, res) => {
  const invoice = await invoices.getInvoice(req.params.id);
  res.json({ invoice });
}));

router.post('/', requirePermission('invoices.create'), asyncHandler(async (req, res) => {
  const { invoice, duplicated } = await invoices.createInvoice(req.body, req.user);
  await logActivity({
    userId: req.user.id, action: 'invoice.create', entity: 'invoices', entityId: invoice.id,
    detail: `${invoice.invoice_no} · ${invoice.customer_name} · ${invoice.total}`
  });
  res.status(duplicated ? 200 : 201).json({ invoice, duplicated });
}));

router.put('/:id', requirePermission('invoices.edit'), asyncHandler(async (req, res) => {
  const { invoice } = await invoices.updateInvoice(req.params.id, req.body, req.user);
  await logActivity({
    userId: req.user.id, action: 'invoice.update', entity: 'invoices', entityId: invoice.id,
    detail: `${invoice.invoice_no} updated`
  });
  res.json({ invoice });
}));

router.post('/:id/cancel', requirePermission('invoices.cancel'), asyncHandler(async (req, res) => {
  const { invoice } = await invoices.cancelInvoice(req.params.id, {
    reason: req.body && req.body.reason, user: req.user
  });
  await logActivity({
    userId: req.user.id, action: 'invoice.cancel', entity: 'invoices', entityId: invoice.id,
    detail: `${invoice.invoice_no} cancelled · stock restored`
  });
  res.json({ invoice });
}));

router.post('/:id/refund', requirePermission('invoices.cancel'), asyncHandler(async (req, res) => {
  const { invoice } = await invoices.refundInvoice(req.params.id, {
    reason: req.body && req.body.reason, user: req.user
  });
  await logActivity({
    userId: req.user.id, action: 'invoice.refund', entity: 'invoices', entityId: invoice.id,
    detail: `${invoice.invoice_no} refunded · stock restored`
  });
  res.json({ invoice });
}));

/** Excel export of the filtered invoice register. */
router.get('/export/xlsx', requirePermission('invoices.view'), asyncHandler(async (req, res) => {
  const { search, status, from, to, user_id } = req.query;
  const ownOnly = req.user.role_name === 'staff' && !req.query.all;
  const data = await invoices.listInvoices(db, {
    search, status, from, to, limit: 5000, offset: 0,
    userId: ownOnly ? req.user.id : user_id
  });
  const sym = config.company.symbol;
  const cur = (n) => `${sym}${Number(n || 0).toFixed(2)}`;
  const buffer = await buildReportXlsx({
    title: 'Invoice Register',
    subtitle: `${data.items.length} invoices · generated ${new Date().toLocaleString('en-IN')}`,
    columns: [
      { header: 'Invoice No', key: 'invoice_no', width: 18 },
      { header: 'Date', key: 'created_at', width: 20, value: (r) => new Date(r.created_at).toLocaleString('en-IN') },
      { header: 'Customer', key: 'customer_name', width: 26 },
      { header: 'Phone', key: 'customer_phone', width: 18 },
      { header: 'Items', key: 'item_count', align: 'right', width: 8 },
      { header: 'Subtotal', key: 'subtotal', align: 'right', width: 14, value: (r) => cur(r.subtotal) },
      { header: 'Discount', key: 'discount_amount', align: 'right', width: 13, value: (r) => cur(r.discount_amount) },
      { header: 'Tax', key: 'tax_amount', align: 'right', width: 13, value: (r) => cur(r.tax_amount) },
      { header: 'Total', key: 'total', align: 'right', width: 15, value: (r) => cur(r.total) },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Billed by', key: 'created_by_name', width: 20 },
      { header: 'Payment', key: 'payment_method', width: 12 }
    ],
    rows: data.items,
    summary: [
      ['Invoices exported', String(data.items.length)],
      ['Paid value', cur(data.items.filter((i) => i.status === 'paid').reduce((s, i) => s + Number(i.total), 0))],
      ['Cancelled', String(data.items.filter((i) => i.status === 'cancelled').length)],
      ['Refunded', String(data.items.filter((i) => i.status === 'refunded').length)]
    ],
    sheetName: 'Invoices'
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="stockflow-invoices-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.send(Buffer.from(buffer));
}));

/** Printable A4 invoice PDF. */
router.get('/:id/pdf', requirePermission('invoices.view'), asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const invoice = await invoices.getInvoice(id);
  const pdf = await buildInvoicePdf(invoice);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${invoice.invoice_no}.pdf"`);
  res.send(pdf);
}));

module.exports = router;
