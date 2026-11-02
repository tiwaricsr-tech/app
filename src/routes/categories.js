'use strict';
const express = require('express');
const db = require('../db');
const { asyncHandler, httpError, nowIso, toInt } = require('../lib/errors');
const { requirePermission, logActivity } = require('../lib/auth');

const router = express.Router();

router.get('/', requirePermission('products.view'), asyncHandler(async (req, res) => {
  const rows = await db.all(
    `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count
       FROM categories c ORDER BY c.name`
  );
  res.json({ items: rows.map((r) => ({ ...r, product_count: Number(r.product_count) })) });
}));

router.post('/', requirePermission('categories.manage'), asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name.length < 2) throw httpError(400, 'INVALID_NAME', 'Category name must be at least 2 characters.');
  const exists = await db.get('SELECT id FROM categories WHERE LOWER(name) = LOWER(?)', name);
  if (exists) throw httpError(409, 'CATEGORY_EXISTS', 'This category already exists.');
  const ins = await db.run(
    'INSERT INTO categories (name, description, created_at) VALUES (?, ?, ?)',
    name, String(req.body.description || '').trim() || null, nowIso()
  );
  await logActivity({ userId: req.user.id, action: 'category.create', entity: 'categories', entityId: ins.lastInsertRowid, detail: name });
  const cat = await db.get('SELECT * FROM categories WHERE id = ?', ins.lastInsertRowid);
  res.status(201).json({ category: cat });
}));

router.patch('/:id', requirePermission('categories.manage'), asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const cat = await db.get('SELECT * FROM categories WHERE id = ?', id);
  if (!cat) throw httpError(404, 'CATEGORY_NOT_FOUND', 'Category not found.');
  const name = req.body.name !== undefined ? String(req.body.name).trim() : cat.name;
  if (name.length < 2) throw httpError(400, 'INVALID_NAME', 'Category name must be at least 2 characters.');
  const clash = await db.get('SELECT id FROM categories WHERE LOWER(name)=LOWER(?) AND id <> ?', name, id);
  if (clash) throw httpError(409, 'CATEGORY_EXISTS', 'This category already exists.');
  await db.run('UPDATE categories SET name = ?, description = ? WHERE id = ?',
    name, req.body.description !== undefined ? (String(req.body.description).trim() || null) : cat.description, id);
  await logActivity({ userId: req.user.id, action: 'category.update', entity: 'categories', entityId: id, detail: name });
  res.json({ category: await db.get('SELECT * FROM categories WHERE id = ?', id) });
}));

router.delete('/:id', requirePermission('categories.manage'), asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const cat = await db.get('SELECT * FROM categories WHERE id = ?', id);
  if (!cat) throw httpError(404, 'CATEGORY_NOT_FOUND', 'Category not found.');
  const used = await db.get('SELECT COUNT(*) AS n FROM products WHERE category_id = ?', id);
  if (Number(used.n) > 0) {
    throw httpError(409, 'CATEGORY_IN_USE', `${used.n} product(s) still use this category. Reassign them first.`);
  }
  await db.run('DELETE FROM categories WHERE id = ?', id);
  await logActivity({ userId: req.user.id, action: 'category.delete', entity: 'categories', entityId: id, detail: cat.name });
  res.json({ ok: true });
}));

module.exports = router;
