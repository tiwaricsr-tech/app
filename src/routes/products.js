'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');
const { asyncHandler, httpError, nowIso, toNumber, toInt } = require('../lib/errors');
const { requirePermission, logActivity } = require('../lib/auth');
const inventory = require('../services/inventory');

const router = express.Router();
const UPLOAD_DIR = path.join(config.root, 'public', 'uploads');

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/**
 * Accepts a data-URL image from the form.
 *
 * Writes it to public/uploads when the filesystem is writable (self-hosted,
 * Docker, local dev). On a read-only serverless filesystem (Vercel) it stores
 * the data URI itself, so images keep working without persistent storage.
 */
function saveImage(dataUrl) {
  if (!dataUrl) return null;
  const match = /^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!match) throw httpError(400, 'INVALID_IMAGE', 'Image must be a PNG, JPG, WEBP, GIF or SVG file.');
  const buf = Buffer.from(match[2], 'base64');
  if (buf.byteLength > config.maxImageBytes) throw httpError(413, 'IMAGE_TOO_LARGE', 'Image must be smaller than 1.6 MB.');

  try {
    ensureUploadDir();
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1].replace('svg+xml', 'svg');
    const name = `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    return `/uploads/${name}`;
  } catch (_) {
    // Read-only FS (serverless): fall back to embedding the image.
    return String(dataUrl);
  }
}

function deleteImageIfLocal(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith('/uploads/')) return;
  const file = path.join(UPLOAD_DIR, path.basename(imageUrl));
  fs.promises.unlink(file).catch(() => {});
}

function validateProduct(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => body[k] !== undefined;

  if (!partial || has('name')) {
    const name = String(body.name || '').trim();
    if (name.length < 2) throw httpError(400, 'INVALID_NAME', 'Product name must be at least 2 characters.');
    if (name.length > 160) throw httpError(400, 'INVALID_NAME', 'Product name is too long.');
    out.name = name;
  }
  if (!partial || has('sku')) {
    const sku = String(body.sku || '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9\-_.]{1,39}$/.test(sku)) {
      throw httpError(400, 'INVALID_SKU', 'SKU must be 2–40 characters: letters, numbers, dash, underscore or dot.');
    }
    out.sku = sku;
  }
  if (has('category_id')) {
    out.category_id = body.category_id === '' || body.category_id === null ? null : toInt(body.category_id);
  }
  if (has('description')) out.description = String(body.description || '').trim() || null;

  for (const [field, label] of [['purchase_price', 'Purchase price'], ['selling_price', 'Selling price']]) {
    if (!partial || has(field)) {
      const v = toNumber(body[field], NaN);
      if (!Number.isFinite(v) || v < 0) throw httpError(400, 'INVALID_PRICE', `${label} must be zero or more.`);
      if (v > 1e9) throw httpError(400, 'INVALID_PRICE', `${label} is unrealistically large.`);
      out[field] = Math.round(v * 100) / 100;
    }
  }
  if (!partial || has('low_stock_threshold')) {
    const v = toInt(body.low_stock_threshold, config.defaultLowStockThreshold);
    if (v < 0 || v > 1e6) throw httpError(400, 'INVALID_THRESHOLD', 'Low stock threshold must be between 0 and 1,000,000.');
    out.low_stock_threshold = v;
  }
  if (has('status')) {
    out.status = body.status === 'archived' ? 'archived' : 'active';
  }
  return out;
}

async function assertCategory(conn, categoryId) {
  if (categoryId === null || categoryId === undefined) return;
  const cat = await conn.get('SELECT id FROM categories WHERE id = ?', toInt(categoryId));
  if (!cat) throw httpError(400, 'INVALID_CATEGORY', 'Selected category does not exist.');
}

router.get('/', requirePermission('products.view'), asyncHandler(async (req, res) => {
  const { search, category_id, status, low, sort, dir, limit, offset } = req.query;
  const result = await inventory.listInventory(db, {
    search, categoryId: category_id, status, lowOnly: String(low) === 'true',
    sort, dir, limit: limit || 500, offset
  });
  res.json(result);
}));

router.get('/:id', requirePermission('products.view'), asyncHandler(async (req, res) => {
  const product = await inventory.getProduct(db, req.params.id);
  const movements = await inventory.listMovements(db, { productId: product.id, limit: 30 });
  res.json({ product, movements: movements.items });
}));

router.post('/', requirePermission('products.create'), asyncHandler(async (req, res) => {
  const data = validateProduct(req.body);
  await assertCategory(db, data.category_id);

  const existing = await db.get('SELECT id, name FROM products WHERE LOWER(sku) = LOWER(?)', data.sku);
  if (existing) throw httpError(409, 'SKU_TAKEN', `SKU ${data.sku} is already used by ${existing.name}.`);

  const imageUrl = req.body.image_url ? saveImage(req.body.image_url) : null;
  const openingQty = Math.max(0, toInt(req.body.opening_stock, 0));
  const ts = nowIso();

  const productId = await db.tx(async (conn) => {
    const ins = await conn.run(
      `INSERT INTO products (name, sku, category_id, image_url, description, purchase_price, selling_price,
                             low_stock_threshold, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.name, data.sku, data.category_id ?? null, imageUrl, data.description ?? null,
      data.purchase_price, data.selling_price, data.low_stock_threshold, data.status || 'active', ts, ts
    );
    const id = ins.lastInsertRowid;
    await inventory.ensureInventoryRow(conn, id, 0);
    if (openingQty > 0) {
      await inventory.applyStockMovement(conn, {
        productId: id, delta: openingQty, type: 'in', note: 'Opening stock',
        userId: req.user.id, unitCost: data.purchase_price, referenceType: 'product'
      });
    }
    return id;
  });

  await logActivity({ userId: req.user.id, action: 'product.create', entity: 'products', entityId: productId, detail: data.name });
  res.status(201).json({ product: await inventory.getProduct(db, productId) });
}));

router.patch('/:id', requirePermission('products.update'), asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const current = await inventory.getProduct(db, id);
  const data = validateProduct(req.body, { partial: true });
  if (data.category_id !== undefined) await assertCategory(db, data.category_id);

  if (data.sku && data.sku.toLowerCase() !== String(current.sku).toLowerCase()) {
    const clash = await db.get('SELECT id, name FROM products WHERE LOWER(sku) = LOWER(?) AND id <> ?', data.sku, id);
    if (clash) throw httpError(409, 'SKU_TAKEN', `SKU ${data.sku} is already used by ${clash.name}.`);
  }

  let imageUrl = current.image_url;
  if (req.body.image_url !== undefined) {
    if (req.body.image_url === null || req.body.image_url === '') {
      deleteImageIfLocal(current.image_url);
      imageUrl = null;
    } else if (String(req.body.image_url).startsWith('data:')) {
      const saved = saveImage(req.body.image_url);
      deleteImageIfLocal(current.image_url);
      imageUrl = saved;
    }
  }

  const fields = {
    name: data.name ?? current.name,
    sku: data.sku ?? current.sku,
    category_id: data.category_id !== undefined ? data.category_id : current.category_id,
    description: data.description !== undefined ? data.description : current.description,
    purchase_price: data.purchase_price !== undefined ? data.purchase_price : current.purchase_price,
    selling_price: data.selling_price !== undefined ? data.selling_price : current.selling_price,
    low_stock_threshold: data.low_stock_threshold !== undefined ? data.low_stock_threshold : current.low_stock_threshold,
    status: data.status ?? current.status
  };

  await db.run(
    `UPDATE products SET name=?, sku=?, category_id=?, description=?, purchase_price=?, selling_price=?,
            low_stock_threshold=?, status=?, image_url=?, updated_at=? WHERE id=?`,
    fields.name, fields.sku, fields.category_id ?? null, fields.description ?? null, fields.purchase_price,
    fields.selling_price, fields.low_stock_threshold, fields.status, imageUrl, nowIso(), id
  );

  await logActivity({ userId: req.user.id, action: 'product.update', entity: 'products', entityId: id, detail: fields.name });
  res.json({ product: await inventory.getProduct(db, id) });
}));

router.delete('/:id', requirePermission('products.delete'), asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const product = await inventory.getProduct(db, id);

  const sold = await db.get('SELECT COUNT(*) AS n FROM invoice_items WHERE product_id = ?', id);
  const movements = await db.get('SELECT COUNT(*) AS n FROM stock_movements WHERE product_id = ?', id);

  if (Number(sold.n) > 0 || Number(movements.n) > 1) {
    // Never destroy billing history: archive instead.
    await db.run("UPDATE products SET status='archived', updated_at=? WHERE id=?", nowIso(), id);
    await logActivity({ userId: req.user.id, action: 'product.archive', entity: 'products', entityId: id, detail: product.name });
    return res.json({
      ok: true, archived: true,
      message: `${product.name} has sales history, so it was archived instead of deleted.`
    });
  }

  await db.tx(async (conn) => {
    await conn.run('DELETE FROM stock_movements WHERE product_id = ?', id);
    await conn.run('DELETE FROM inventory WHERE product_id = ?', id);
    await conn.run('DELETE FROM products WHERE id = ?', id);
  });
  deleteImageIfLocal(product.image_url);
  await logActivity({ userId: req.user.id, action: 'product.delete', entity: 'products', entityId: id, detail: product.name });
  res.json({ ok: true, archived: false });
}));

/** Quick sell-price lookup used by the billing product picker. */
router.get('/:id/price', requirePermission('invoices.create'), asyncHandler(async (req, res) => {
  const product = await inventory.getProduct(db, req.params.id);
  res.json({ id: product.id, selling_price: product.selling_price, quantity: product.quantity, name: product.name, sku: product.sku });
}));

module.exports = router;
