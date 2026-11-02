'use strict';
const path = require('path');

const root = path.resolve(__dirname, '..');

function nonEmpty(value) {
  const v = (value || '').trim();
  return v.length ? v : '';
}

const config = {
  root,
  port: Number(process.env.PORT || 4173),
  env: process.env.NODE_ENV || 'development',
  // JWT signing secret. MUST be provided through the environment in production.
  jwtSecret: process.env.JWT_SECRET || 'stockflow-dev-only-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  // Empty DATABASE_URL => embedded SQLite (zero-config local / preview mode).
  // Set DATABASE_URL=postgres://... to run the exact same app on Supabase PostgreSQL.
  databaseUrl: nonEmpty(process.env.DATABASE_URL),
  sqliteFile: process.env.SQLITE_FILE || path.join(root, 'data', 'stockflow.db'),
  // Postgres pool sizing; serverless platforms want 1-3.
  pgPoolMax: Number(process.env.PG_POOL_MAX || 10),
  pgConnectTimeoutMs: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10000),
  isProd: process.env.NODE_ENV === 'production',
  company: {
    name: process.env.COMPANY_NAME || 'StockFlow Traders Pvt. Ltd.',
    address: process.env.COMPANY_ADDRESS || '12, MG Road, Indore, Madhya Pradesh 452001, India',
    phone: process.env.COMPANY_PHONE || '+91 98260 11223',
    email: process.env.COMPANY_EMAIL || 'billing@stockflow.example',
    gstin: process.env.COMPANY_GSTIN || '23AABCS1429P1ZV',
    currency: process.env.CURRENCY || 'INR',
    symbol: process.env.CURRENCY_SYMBOL || '\u20B9'
  },
  // Minutes to shift timestamps for day/month reporting (default IST = UTC+5:30).
  dateShiftMinutes: Number(process.env.DATE_SHIFT_MINUTES || 330),
  businessTz: process.env.BUSINESS_TZ || 'Asia/Kolkata',
  // Set to "'self'" to block embedding (self-hosted hardening). Empty = allow preview iframes.
  frameAncestors: process.env.FRAME_ANCESTORS || '',
  maxImageBytes: 1.6 * 1024 * 1024,
  defaultLowStockThreshold: 10
};

if (config.isProd && config.jwtSecret === 'stockflow-dev-only-secret-change-me') {
  console.warn('[security] JWT_SECRET is using the development default. Set JWT_SECRET in production.');
}

module.exports = config;
