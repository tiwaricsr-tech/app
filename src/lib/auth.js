'use strict';
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('../db');
const { httpError } = require('./errors');
const { permissionsForRole, PERMISSION_VERBS } = require('./perm');

const BCRYPT_ROUNDS = 11;

const hashPassword = (plain) => bcrypt.hash(plain, BCRYPT_ROUNDS);
const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash || '');

function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), role: user.role_name || user.role, email: user.email },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn, issuer: 'stockflow' }
  );
}

/** Loads the fresh DB user on every request so deactivation/role changes apply instantly. */
async function loadUserById(id) {
  return db.get(
    `SELECT u.id, u.full_name, u.email, u.phone, u.status, u.role_id, u.created_at, u.last_login_at,
            r.name AS role_name, r.label AS role_label
       FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.id = ?`,
    id
  );
}

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : (req.cookies && req.cookies.token);
    if (!token) throw httpError(401, 'UNAUTHENTICATED', 'Please sign in to continue.');

    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret, { issuer: 'stockflow' });
    } catch (e) {
      throw httpError(401, 'SESSION_EXPIRED', 'Your session has expired. Please sign in again.');
    }

    const user = await loadUserById(payload.sub);
    if (!user) throw httpError(401, 'UNAUTHENTICATED', 'Account not found.');
    if (user.status !== 'active') throw httpError(403, 'ACCOUNT_INACTIVE', 'This account has been deactivated.');

    req.user = { ...user, permissions: permissionsForRole(user.role_name) };
    next();
  } catch (err) {
    next(err);
  }
}

/** Route guard: requires ALL listed permissions. */
function requirePermission(...perms) {
  return (req, res, next) => {
    if (!req.user) return next(httpError(401, 'UNAUTHENTICATED', 'Please sign in to continue.'));
    const missing = perms.filter((p) => !req.user.permissions.includes(p));
    if (missing.length) {
      const verb = PERMISSION_VERBS[missing[0]] || missing[0].replace('.', ' ');
      return next(httpError(403, 'FORBIDDEN', `Your role does not allow you to ${verb}.`));
    }
    next();
  };
}

/** Route guard: requires a specific role (e.g. admin-only screens). */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(httpError(401, 'UNAUTHENTICATED', 'Please sign in to continue.'));
    if (!roles.includes(req.user.role_name)) {
      return next(httpError(403, 'FORBIDDEN', 'This area is restricted to administrators.'));
    }
    next();
  };
}

async function logActivity({ userId, action, entity, entityId, detail }) {
  try {
    await db.run(
      `INSERT INTO activity_log (user_id, action, entity, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      userId || null, action, entity || null, entityId || null, detail || null, new Date().toISOString()
    );
  } catch (_) { /* activity log must never break a request */ }
}

module.exports = { hashPassword, verifyPassword, signToken, authenticate, requirePermission, requireRole, logActivity, loadUserById };
