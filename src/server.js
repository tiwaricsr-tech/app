'use strict';
const path = require('path');
const express = require('express');
const config = require('./config');
const db = require('./db');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(express.json({ limit: '4mb' })); // base64 product images
app.use(express.urlencoded({ extended: true, limit: '4mb' }));

// ── CORS ────────────────────────────────────────────────────────────────────
// The platform preview renders the app inside a sandboxed iframe, which gives the
// document an OPAQUE origin ("null"). ES modules and fetch() are therefore treated
// as cross-origin requests and need an explicit access-control header, otherwise
// /js/app.js is blocked and the app never boots.
//
// Safe here: authentication is a bearer token in the Authorization header, never a
// cookie, so `*` cannot be abused for credentialed (CSRF) requests. Set CORS_ORIGINS
// to a comma-separated allow-list for a locked-down deployment.
const corsOrigins = (process.env.CORS_ORIGINS || '*').split(',').map((o) => o.trim());
app.use((req, res, next) => {
  const origin = req.headers.origin;
  let allow = '*';
  if (!corsOrigins.includes('*')) {
    allow = corsOrigins.includes(origin) ? origin : corsOrigins[0];
  } else if (origin && origin !== 'null') {
    allow = origin; // echo the caller so credentials-free CORS works everywhere
  }
  res.setHeader('Access-Control-Allow-Origin', allow);
  if (allow !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ── security headers (CSP-safe: no external CDNs are used anywhere) ─────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // NOTE: no X-Frame-Options / frame-ancestors restriction — the app is designed to be
  // embedded in the platform preview iframe. Clickjacking protection for a self-hosted
  // deployment can be re-enabled by setting FRAME_ANCESTORS (see config.js).
  if (config.frameAncestors) res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    `frame-ancestors ${config.frameAncestors || '*'}`,
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; '));
  next();
});

const { authenticate } = require('./lib/auth');
const { asyncHandler } = require('./lib/errors');

// ── API ─────────────────────────────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));

const guard = [authenticate];
const protectedRouters = {
  '/api/products': './routes/products',
  '/api/categories': './routes/categories',
  '/api/inventory': './routes/inventory',
  '/api/invoices': './routes/invoices',
  '/api/reports': './routes/reports',
  '/api/users': './routes/users'
};

// reports router handles its own permission checks per report type
app.use('/api/reports', authenticate, require('./routes/reports'));
app.use('/api/products', authenticate, require('./routes/products'));
app.use('/api/categories', authenticate, require('./routes/categories'));
app.use('/api/inventory', authenticate, require('./routes/inventory'));
app.use('/api/invoices', authenticate, require('./routes/invoices'));
app.use('/api/users', authenticate, require('./routes/users'));

app.get('/api/health', asyncHandler(async (req, res) => {
  const ping = await db.get('SELECT 1 AS ok');
  res.json({
    ok: true,
    driver: db.driver,
    time: new Date().toISOString(),
    version: require('../package.json').version
  });
}));

// ── static SPA ──────────────────────────────────────────────────────────────
const publicDir = path.join(config.root, 'public');
app.use(express.static(publicDir, {
  extensions: ['html'],
  setHeaders(res, filePath) {
    // Required for ES modules loaded from an opaque (sandboxed-iframe) origin.
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (/\.(js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    if (/\.(png|jpg|jpeg|svg|webp|woff2)$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=86400');
  }
}));

// Tiny inline favicon / manifest (the <link> in index.html already covers modern browsers;
// this keeps /favicon.ico from 404-ing in old ones and on direct hits).
app.get('/favicon.ico', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1d4ed8"/><path d="M18 40V26l14-8 14 8v14l-14 8-14-8z" fill="none" stroke="white" stroke-width="3.2" stroke-linejoin="round"/><path d="M18 26l14 8 14-8M32 34v14" stroke="white" stroke-width="3.2" stroke-linejoin="round"/></svg>`);
});

app.get('/manifest.json', (req, res) => {
  res.json({
    name: 'StockFlow — Inventory & Billing',
    short_name: 'StockFlow',
    start_url: '/',
    display: 'standalone',
    background_color: '#f5f7fb',
    theme_color: '#1d4ed8',
    icons: [{ src: '/favicon.ico', sizes: 'any', type: 'image/svg+xml' }]
  });
});

// Test-only harness: renders the app the way the platform preview does (sandboxed iframe).
app.get('/__iframe_probe', (req, res) => {
  res.type('html').send(`<!doctype html><html><body style="margin:0;background:#fff">
    <iframe id="f" sandbox="allow-scripts" src="/" style="width:100%;height:940px;border:0"></iframe>
  </body></html>`);
});

// SPA fallback for client-side routes (never for /api).
app.get(/^\/(?!api\/).*/, (req, res, next) => {
  if (req.path.includes('.')) return next();
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found.' } });
});

// ── error handler ───────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) {
    const root = require('path').join(config.root, 'data');
    try {
      require('fs').mkdirSync(root, { recursive: true });
      require('fs').appendFileSync(
        require('path').join(root, 'error.log'),
        `[${new Date().toISOString()}] ${req.method} ${req.originalUrl}\n${err.stack}\n\n`
      );
    } catch (_) { /* ignore */ }
    if (config.env !== 'test') console.error('[error]', req.method, req.originalUrl, err.message);
  }
  const body = {
    error: {
      code: err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED'),
      message: status >= 500 && !err.code ? 'Something went wrong. Please try again.' : err.message
    }
  };
  if (err.details) body.error.details = err.details;
  res.status(status).json(body);
});

async function start() {
  // Fail fast in production rather than signing tokens with a public secret.
  if (config.isProd && config.jwtSecret === 'stockflow-dev-only-secret-change-me') {
    throw new Error('JWT_SECRET must be set when NODE_ENV=production.');
  }

  await db.init();
  const { ensureSeed, seedReference } = require('./db/seed');
  if (db.driver === 'sqlite') {
    await ensureSeed({ silent: true });
  } else {
    // Postgres: roles/permissions are reference data the app cannot run without,
    // so make sure they exist. Demo catalogue is opt-in (SEED_DEMO=true) so a
    // real deployment never gets sample products injected behind your back.
    await seedReference();
    const wantsDemo = String(process.env.SEED_DEMO || '').toLowerCase() === 'true';
    // A local (non-Supabase) database that has no products is almost certainly a
    // fresh preview cluster — seed it so the UI is never empty. Hosted databases
    // only seed when explicitly asked.
    const local = /127\.0\.0\.1|localhost/.test(config.databaseUrl);
    const empty = local
      ? Number((await db.get('SELECT COUNT(*) AS n FROM products')).n) === 0
      : false;
    if (wantsDemo || empty) {
      const { seedDemo } = require('./db/seed');
      await seedDemo();
      console.log(`[seed] demo catalogue loaded (${wantsDemo ? 'SEED_DEMO=true' : 'empty local database'})`);
    }
  }

  // Managed platforms inject PORT and expect the process to bind it.
  const port = Number(process.env.PORT || config.port);
  return new Promise((resolve) => {
    const server = app.listen(port, '0.0.0.0', () => {
      const mode = db.driver === 'postgres' ? 'PostgreSQL (Supabase)' : 'embedded SQLite';
      console.log(`StockFlow running on http://0.0.0.0:${port}  ·  db: ${mode}  ·  env: ${config.env}`);
      if (db.driver === 'sqlite' && config.isProd) {
        console.warn('[deploy] SQLite on a managed host is ephemeral — set DATABASE_URL for durable storage.');
      }
      resolve(server);
    });
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Failed to start StockFlow:', err);
    process.exit(1);
  });
}

module.exports = { app, start };
