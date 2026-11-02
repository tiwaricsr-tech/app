'use strict';
const express = require('express');
const { asyncHandler, httpError, toInt } = require('../lib/errors');
const { requirePermission, logActivity } = require('../lib/auth');
const inventory = require('../services/inventory');
const db = require('../db');

const router = express.Router();

router.get('/summary', requirePermission('inventory.view'), asyncHandler(async (req, res) => {
  res.json(await inventory.inventorySummary(db));
}));

router.get('/low-stock', requirePermission('inventory.view'), asyncHandler(async (req, res) => {
  const items = await inventory.lowStock(db, toInt(req.query.limit, 100));
  res.json({ items, count: items.length });
}));

router.get('/movements', requirePermission('inventory.view'), asyncHandler(async (req, res) => {
  const { product_id, type, search, from, to, limit, offset } = req.query;
  res.json(await inventory.listMovements(db, { productId: product_id, type, search, from, to, limit, offset }));
}));

/**
 * POST /api/inventory/adjust
 * body: { product_id, type: 'in' | 'out' | 'set', quantity, note }
 * Runs inside a DB transaction with a guarded atomic UPDATE.
 */
router.post('/adjust', requirePermission('stock.adjust'), asyncHandler(async (req, res) => {
  const productId = toInt(req.body.product_id);
  const type = String(req.body.type || 'in');
  const quantity = toInt(req.body.quantity, NaN);
  if (!productId) throw httpError(400, 'INVALID_PRODUCT', 'Select a product.');
  if (!['in', 'out', 'set'].includes(type)) throw httpError(400, 'INVALID_TYPE', 'Type must be in, out or set.');
  if (!Number.isFinite(quantity)) throw httpError(400, 'INVALID_QUANTITY', 'Enter a valid quantity.');
  if (type !== 'set' && quantity <= 0) throw httpError(400, 'INVALID_QUANTITY', 'Quantity must be greater than zero.');
  if (type === 'set' && quantity < 0) throw httpError(400, 'INVALID_QUANTITY', 'Quantity cannot be negative.');
  if (quantity > 1000000) throw httpError(400, 'INVALID_QUANTITY', 'Quantity is unrealistically large.');

  const delta = type === 'out' ? -quantity : quantity;
  const result = await inventory.adjustStock({
    productId, delta, type, note: String(req.body.note || '').trim() || null, user: req.user
  });

  await logActivity({
    userId: req.user.id, action: `stock.${type}`, entity: 'products', entityId: productId,
    detail: `${type} ${quantity} → ${result.quantity_after} (${result.sku})`
  });

  res.json({ ...result, product: await inventory.getProduct(db, productId) });
}));

module.exports = router;
