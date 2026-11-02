'use strict';
const express = require('express');
const db = require('../db');
const { asyncHandler, httpError, isEmail, nowIso } = require('../lib/errors');
const { hashPassword, requirePermission, requireRole, logActivity } = require('../lib/auth');
const { permissionsForRole } = require('../lib/perm');

const router = express.Router();

const shape = (u) => ({
  id: u.id, full_name: u.full_name, email: u.email, phone: u.phone, status: u.status,
  role: u.role_name, role_label: u.role_label, created_at: u.created_at, last_login_at: u.last_login_at,
  permissions: permissionsForRole(u.role_name),
  invoice_count: u.invoice_count !== undefined ? Number(u.invoice_count) : undefined
});

// Roles list is needed by the admin UI; only admins may enumerate it.
router.get('/roles', requireRole('admin'), asyncHandler(async (req, res) => {
  const roles = await db.all('SELECT id, name, label, description FROM roles ORDER BY id');
  res.json({ roles: roles.map((r) => ({ ...r, permissions: permissionsForRole(r.name) })) });
}));

router.get('/', requirePermission('users.view'), asyncHandler(async (req, res) => {
  const { search = '', role = '', status = '' } = req.query;
  const where = [];
  const params = [];
  if (search) {
    where.push('(LOWER(u.full_name) LIKE ? OR LOWER(u.email) LIKE ?)');
    const q = `%${String(search).toLowerCase()}%`;
    params.push(q, q);
  }
  if (role) { where.push('r.name = ?'); params.push(String(role)); }
  if (status) { where.push('u.status = ?'); params.push(String(status)); }
  const rows = await db.all(
    `SELECT u.*, r.name AS role_name, r.label AS role_label,
            (SELECT COUNT(*) FROM invoices i WHERE i.created_by = u.id) AS invoice_count
       FROM users u JOIN roles r ON r.id = u.role_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY u.created_at DESC`,
    ...params
  );
  const summary = await db.get(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN u.status='active' THEN 1 ELSE 0 END),0) AS active,
            COALESCE(SUM(CASE WHEN u.status='inactive' THEN 1 ELSE 0 END),0) AS inactive
       FROM users u`
  );
  res.json({
    items: rows.map(shape),
    summary: { total: Number(summary.total), active: Number(summary.active), inactive: Number(summary.inactive) }
  });
}));

router.post('/', requireRole('admin'), asyncHandler(async (req, res) => {
  const fullName = String(req.body.full_name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const roleName = String(req.body.role || 'staff');
  const phone = String(req.body.phone || '').trim() || null;
  const status = req.body.status === 'inactive' ? 'inactive' : 'active';

  if (fullName.length < 2) throw httpError(400, 'INVALID_NAME', 'Enter the user\u2019s full name.');
  if (!isEmail(email)) throw httpError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
  if (password.length < 8) throw httpError(400, 'WEAK_PASSWORD', 'Password must be at least 8 characters.');
  if (!await db.get('SELECT id FROM roles WHERE name = ?', roleName)) throw httpError(400, 'INVALID_ROLE', 'Unknown role.');
  if (await db.get('SELECT id FROM users WHERE LOWER(email) = ?', email)) {
    throw httpError(409, 'EMAIL_TAKEN', 'A user with this email already exists.');
  }

  const role = await db.get('SELECT id FROM roles WHERE name = ?', roleName);
  const ts = nowIso();
  const ins = await db.run(
    `INSERT INTO users (full_name, email, password_hash, phone, role_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    fullName, email, await hashPassword(password), phone, role.id, status, ts, ts
  );
  await logActivity({ userId: req.user.id, action: 'user.create', entity: 'users', entityId: ins.lastInsertRowid, detail: `${email} as ${roleName}` });
  const created = await db.get(
    `SELECT u.*, r.name AS role_name, r.label AS role_label FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id = ?`, ins.lastInsertRowid);
  res.status(201).json({ user: shape(created) });
}));

router.patch('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const target = await db.get(
    `SELECT u.*, r.name AS role_name FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id = ?`, id);
  if (!target) throw httpError(404, 'USER_NOT_FOUND', 'User not found.');

  const updates = [];
  const params = [];
  const body = req.body || {};

  if (body.full_name !== undefined) {
    const name = String(body.full_name).trim();
    if (name.length < 2) throw httpError(400, 'INVALID_NAME', 'Enter a valid full name.');
    updates.push('full_name = ?'); params.push(name);
  }
  if (body.phone !== undefined) { updates.push('phone = ?'); params.push(String(body.phone || '').trim() || null); }
  if (body.email !== undefined) {
    const email = String(body.email).trim().toLowerCase();
    if (!isEmail(email)) throw httpError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
    const clash = await db.get('SELECT id FROM users WHERE LOWER(email) = ? AND id <> ?', email, id);
    if (clash) throw httpError(409, 'EMAIL_TAKEN', 'Another user already uses this email.');
    updates.push('email = ?'); params.push(email);
  }
  if (body.status !== undefined) {
    const status = body.status === 'inactive' ? 'inactive' : 'active';
    if (target.id === req.user.id && status === 'inactive') {
      throw httpError(400, 'SELF_LOCKOUT', 'You cannot deactivate your own admin account.');
    }
    if (target.role_name === 'admin' && status === 'inactive') {
      const admins = await db.get(`SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id=u.role_id
                                    WHERE r.name='admin' AND u.status='active'`);
      if (Number(admins.n) <= 1) throw httpError(400, 'LAST_ADMIN', 'At least one active administrator is required.');
    }
    updates.push('status = ?'); params.push(status);
  }
  if (body.role !== undefined) {
    const role = await db.get('SELECT id, name FROM roles WHERE name = ?', String(body.role));
    if (!role) throw httpError(400, 'INVALID_ROLE', 'Unknown role.');
    if (target.id === req.user.id && role.name !== 'admin') {
      throw httpError(400, 'SELF_DEMOTE', 'You cannot change your own administrator role.');
    }
    updates.push('role_id = ?'); params.push(role.id);
  }
  if (body.password) {
    if (String(body.password).length < 8) throw httpError(400, 'WEAK_PASSWORD', 'Password must be at least 8 characters.');
    updates.push('password_hash = ?'); params.push(await hashPassword(String(body.password)));
  }

  if (!updates.length) throw httpError(400, 'NOTHING_TO_UPDATE', 'No changes submitted.');
  updates.push('updated_at = ?'); params.push(nowIso()); params.push(id);
  await db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, ...params);

  await logActivity({
    userId: req.user.id, action: 'user.update', entity: 'users', entityId: id,
    detail: Object.keys(body).join(', ')
  });
  const fresh = await db.get(
    `SELECT u.*, r.name AS role_name, r.label AS role_label FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id = ?`, id);
  res.json({ user: shape(fresh) });
}));

router.delete('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) throw httpError(400, 'SELF_DELETE', 'You cannot delete your own account.');
  const target = await db.get(
    `SELECT u.*, r.name AS role_name FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id = ?`, id);
  if (!target) throw httpError(404, 'USER_NOT_FOUND', 'User not found.');
  if (target.role_name === 'admin') {
    const admins = await db.get(`SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id=u.role_id
                                  WHERE r.name='admin' AND u.status='active'`);
    if (Number(admins.n) <= 1) throw httpError(400, 'LAST_ADMIN', 'At least one administrator is required.');
  }
  const invoices = await db.get('SELECT COUNT(*) AS n FROM invoices WHERE created_by = ?', id);
  if (Number(invoices.n) > 0) {
    // Preserve billing history: deactivate instead of hard delete.
    await db.run("UPDATE users SET status='inactive', updated_at=? WHERE id = ?", nowIso(), id);
    await logActivity({ userId: req.user.id, action: 'user.deactivate', entity: 'users', entityId: id, detail: 'Has invoices — deactivated instead of deleted' });
    return res.json({ ok: true, deactivated: true, message: 'User has billing history, so the account was deactivated instead of deleted.' });
  }
  await db.run('DELETE FROM users WHERE id = ?', id);
  await logActivity({ userId: req.user.id, action: 'user.delete', entity: 'users', entityId: id });
  res.json({ ok: true, deactivated: false });
}));

module.exports = router;
