'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const { asyncHandler, httpError, isEmail, nowIso } = require('../lib/errors');
const { hashPassword, verifyPassword, signToken, authenticate, logActivity } = require('../lib/auth');
const { permissionsForRole } = require('../lib/perm');

const router = express.Router();

const loginAttempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function throttle(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.first > WINDOW_MS) {
    loginAttempts.set(key, { count: 1, first: now });
    return;
  }
  entry.count += 1;
  if (entry.count > MAX_ATTEMPTS) {
    throw httpError(429, 'TOO_MANY_ATTEMPTS', 'Too many sign-in attempts. Please try again in a few minutes.');
  }
}

const publicUser = (u) => ({
  id: u.id, full_name: u.full_name, email: u.email, phone: u.phone, status: u.status,
  role: u.role_name, role_label: u.role_label, created_at: u.created_at, last_login_at: u.last_login_at,
  permissions: permissionsForRole(u.role_name)
});

router.post('/register', asyncHandler(async (req, res) => {
  const fullName = String(req.body.full_name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const phone = String(req.body.phone || '').trim() || null;

  if (fullName.length < 2) throw httpError(400, 'INVALID_NAME', 'Please enter your full name.');
  if (!isEmail(email)) throw httpError(400, 'INVALID_EMAIL', 'Please enter a valid email address.');
  if (password.length < 8) throw httpError(400, 'WEAK_PASSWORD', 'Password must be at least 8 characters.');
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    throw httpError(400, 'WEAK_PASSWORD', 'Password must include at least one letter and one number.');
  }

  const existing = await db.get('SELECT id FROM users WHERE LOWER(email) = ?', email);
  if (existing) throw httpError(409, 'EMAIL_TAKEN', 'An account with this email already exists.');

  const role = await db.get("SELECT id, name FROM roles WHERE name = 'staff'");
  const ts = nowIso();
  const hash = await hashPassword(password);

  const result = await db.tx(async (conn) => {
    const ins = await conn.run(
      `INSERT INTO users (full_name, email, password_hash, phone, role_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      fullName, email, hash, phone, role.id, ts, ts
    );
    return ins.lastInsertRowid;
  });

  const user = await db.get(
    `SELECT u.*, r.name AS role_name, r.label AS role_label FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
    result
  );
  await logActivity({ userId: user.id, action: 'user.register', entity: 'users', entityId: user.id, detail: email });

  res.status(201).json({ token: signToken(user), user: publicUser(user) });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) throw httpError(400, 'MISSING_CREDENTIALS', 'Enter your email and password.');

  throttle(req.ip + ':' + email);

  const user = await db.get(
    `SELECT u.*, r.name AS role_name, r.label AS role_label
       FROM users u JOIN roles r ON r.id = u.role_id WHERE LOWER(u.email) = ?`, email
  );
  // Constant-ish time: always run a comparison.
  const ok = user ? await verifyPassword(password, user.password_hash) : await bcrypt.compare(password, '$2a$11$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
  if (!user || !ok) throw httpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  if (user.status !== 'active') throw httpError(403, 'ACCOUNT_INACTIVE', 'This account has been deactivated. Contact your administrator.');

  const ts = nowIso();
  await db.run('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?', ts, ts, user.id);
  await logActivity({ userId: user.id, action: 'user.login', entity: 'users', entityId: user.id });

  loginAttempts.delete(req.ip + ':' + email);
  res.json({ token: signToken(user), user: publicUser({ ...user, last_login_at: ts }) });
}));

router.get('/me', authenticate, asyncHandler(async (req, res) => {
  res.json({ user: publicUser({ ...req.user, role_name: req.user.role_name, role_label: req.user.role_label }) });
}));

router.patch('/me', authenticate, asyncHandler(async (req, res) => {
  const fullName = String(req.body.full_name || req.user.full_name).trim();
  const phone = String(req.body.phone || '').trim() || null;
  if (fullName.length < 2) throw httpError(400, 'INVALID_NAME', 'Please enter your full name.');
  await db.run('UPDATE users SET full_name = ?, phone = ?, updated_at = ? WHERE id = ?', fullName, phone, nowIso(), req.user.id);
  const fresh = await db.get(
    `SELECT u.*, r.name AS role_name, r.label AS role_label FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`, req.user.id
  );
  res.json({ user: publicUser(fresh) });
}));

router.post('/change-password', authenticate, asyncHandler(async (req, res) => {
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  if (next.length < 8) throw httpError(400, 'WEAK_PASSWORD', 'New password must be at least 8 characters.');
  if (!/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) {
    throw httpError(400, 'WEAK_PASSWORD', 'Password must include at least one letter and one number.');
  }
  const row = await db.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  const ok = await verifyPassword(current, row.password_hash);
  if (!ok) throw httpError(401, 'INVALID_PASSWORD', 'Your current password is incorrect.');
  await db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', await hashPassword(next), nowIso(), req.user.id);
  await logActivity({ userId: req.user.id, action: 'user.password_change', entity: 'users', entityId: req.user.id });
  res.json({ ok: true });
}));

router.post('/logout', authenticate, asyncHandler(async (req, res) => {
  await logActivity({ userId: req.user.id, action: 'user.logout', entity: 'users', entityId: req.user.id });
  res.json({ ok: true });
}));

/** Bootstrap: lets the UI know whether an admin exists yet (first-run experience). */
router.get('/setup-status', asyncHandler(async (req, res) => {
  const admin = await db.get("SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id=u.role_id WHERE r.name='admin'");
  res.json({ has_admin: Number(admin.n) > 0 });
}));

module.exports = router;
module.exports.publicUser = publicUser;
