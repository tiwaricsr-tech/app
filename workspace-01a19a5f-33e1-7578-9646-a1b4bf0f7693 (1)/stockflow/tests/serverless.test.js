'use strict';
/**
 * Serverless entry-point test.
 *
 *   DATABASE_URL='postgres://…' JWT_SECRET='…' node tests/serverless.test.js
 *
 * Vercel does not run `src/server.js`; it calls the handler exported by
 * `api/index.js`. That file boots Express lazily on the first request, against a
 * read-only filesystem — behaviour no other suite exercises. This test drives
 * real HTTP through that exact handler, so a deployment cannot fail on an
 * assumption the tests never checked.
 */
process.env.NODE_ENV = 'production';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'serverless-test-secret-not-for-production';
process.env.PG_POOL_MAX = process.env.PG_POOL_MAX || '2';

// Fall back to .env.local so the suite is runnable without repeating the URL.
if (!process.env.DATABASE_URL) {
  try {
    const line = require('fs')
      .readFileSync(require('path').join(__dirname, '..', '.env.local'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('DATABASE_URL='));
    if (line) process.env.DATABASE_URL = line.slice('DATABASE_URL='.length).trim();
  } catch (_) { /* none */ }
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (a serverless deploy cannot use SQLite).');
  process.exit(1);
}

/**
 * Credentials are not baked in: the deployed database has rotated passwords, so
 * a hardcoded demo password would rot. Provide them explicitly:
 *   TEST_EMAIL=... TEST_PASSWORD=... node tests/serverless.test.js
 */
const EMAIL = process.env.TEST_EMAIL || '';
const PASSWORD = process.env.TEST_PASSWORD || '';
const hasCreds = Boolean(EMAIL && PASSWORD);

const http = require('http');
const handler = require('../api/index.js');

const PORT = 4599;
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  \u2717 ${name}\n      ${err.message}`);
  }
}

function request(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message, headers: {} }));
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  console.log('\nStockFlow \u2014 serverless (Vercel) entry point');
  console.log('Database:', process.env.DATABASE_URL.replace(/:[^:@]+@/, ':****@'), '\n');

  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((e) => {
      res.statusCode = 500;
      res.end(`handler error: ${e.message}`);
    });
  });

  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  try {
    // The handler boots on demand; a cold pooler connection can take a moment.
    let health = { status: 0, body: '' };
    for (let i = 0; i < 45; i += 1) {
      health = await request('/api/health');
      if (health.status === 200) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    await check('handler boots and /api/health returns 200', () => {
      if (health.status !== 200) throw new Error(`status ${health.status}: ${health.body.slice(0, 160)}`);
      const j = JSON.parse(health.body);
      if (!j.ok) throw new Error('ok was not true');
      if (j.driver !== 'postgres') throw new Error(`driver was ${j.driver}`);
    });

    let token;
    if (hasCreds) {
      await check('login issues a token', async () => {
        const r = await request('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: EMAIL, password: PASSWORD })
        });
        if (r.status !== 200) throw new Error(`${r.status}: ${r.body.slice(0, 160)}`);
        token = JSON.parse(r.body).token;
        if (!token) throw new Error('no token returned');
      });

      await check('authenticated data request returns real rows', async () => {
        const r = await request('/api/reports/dashboard', { headers: { Authorization: `Bearer ${token}` } });
        if (r.status !== 200) throw new Error(`${r.status}: ${r.body.slice(0, 160)}`);
        const j = JSON.parse(r.body);
        if (!(j.inventory.products >= 0)) throw new Error('no inventory figure');
      });
    } else {
      console.log('  - skipped login checks (set TEST_EMAIL / TEST_PASSWORD to run them)');
      // Prove the auth boundary is intact without credentials.
      await check('login rejects a wrong password', async () => {
        const r = await request('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong-password' })
        });
        if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
      });
      await check('a protected route rejects a forged token', async () => {
        const r = await request('/api/reports/dashboard', { headers: { Authorization: 'Bearer forged.token.value' } });
        if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
      });
    }

    await check('SPA index is served from the bundle', async () => {
      const r = await request('/');
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      if (!r.body.includes('StockFlow')) throw new Error('index.html not served');
    });

    await check('static JS is served with the right content type', async () => {
      const r = await request('/js/app.js');
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      if (!String(r.headers['content-type']).includes('javascript')) throw new Error(r.headers['content-type']);
    });

    await check('static CSS is served', async () => {
      const r = await request('/css/app.css');
      if (r.status !== 200) throw new Error(`status ${r.status}`);
    });

    await check('unauthenticated API access is rejected', async () => {
      const r = await request('/api/products');
      if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
    });

    await check('PDF export works (pdfkit font metrics load from disk)', async () => {
      if (!token) throw new Error('no token');
      const r = await request('/api/invoices/1/pdf', { headers: { Authorization: `Bearer ${token}` } });
      if (r.status !== 200) throw new Error(`status ${r.status}: ${r.body.slice(0, 160)}`);
      if (!r.body.startsWith('%PDF')) throw new Error('response was not a PDF');
      if (Buffer.byteLength(r.body) < 1000) throw new Error('PDF suspiciously small');
    });

    await check('Excel export works (exceljs zip writer)', async () => {
      if (!token) throw new Error('no token');
      const r = await request('/api/invoices/export/xlsx', { headers: { Authorization: `Bearer ${token}` } });
      if (r.status !== 200) throw new Error(`status ${r.status}: ${r.body.slice(0, 160)}`);
      if (!r.body.startsWith('PK')) throw new Error('response was not a zip/xlsx');
    });

    await check('report PDF export works', async () => {
      if (!token) throw new Error('no token');
      const r = await request('/api/reports/sales/export/pdf?from=2026-01-01&to=2026-12-31', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (r.status !== 200) throw new Error(`status ${r.status}: ${r.body.slice(0, 160)}`);
      if (!r.body.startsWith('%PDF')) throw new Error('response was not a PDF');
    });

    await check('unknown API route returns a JSON 404', async () => {
      const r = await request('/api/does-not-exist');
      if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
      JSON.parse(r.body); // must be JSON, not an HTML error page
    });
  } finally {
    server.close();
    console.log('\n' + '\u2500'.repeat(64));
    console.log(`${passed} passed, ${failed} failed`);
    console.log('\u2500'.repeat(64) + '\n');
    process.exit(failed ? 1 : 0);
  }
})();
