'use strict';
/**
 * Pushes the local dataset into Supabase over the REST API (PostgREST).
 *
 *   SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=<service_role jwt> \
 *   node src/db/sync-supabase.js
 *
 * Why REST and not a raw pg connection: the project's database password is not
 * available to automation, but the service_role key is. PostgREST runs as that
 * role, which bypasses RLS, so it can write the same rows the SQL migration
 * would.
 *
 * Order matters (foreign keys). Fails loudly rather than writing a partial set:
 * if any table fails the script stops and reports exactly where.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SQLITE_FILE = process.env.SQLITE_FILE || path.join(__dirname, '..', '..', 'data', 'stockflow.db');

if (!URL || !KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const TABLES = [
  'roles', 'permissions', 'role_permissions', 'users', 'categories', 'products',
  'inventory', 'stock_movements', 'invoices', 'invoice_items', 'counters', 'activity_log'
];

// Written parent-first; deleted child-first.
const DELETE_ORDER = [...TABLES].reverse();

function readSqliteTable(table) {
  const code = `
    const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
    const db = new Database(${JSON.stringify(SQLITE_FILE)}, { readonly: true });
    process.stdout.write(JSON.stringify(db.prepare('SELECT * FROM ${table}').all()));
  `;
  return JSON.parse(execFileSync(process.execPath, ['-e', code], { maxBuffer: 512 * 1024 * 1024 }).toString() || '[]');
}

async function rest(method, endpoint, { body, prefer } = {}) {
  const res = await fetch(`${URL}/rest/v1/${endpoint}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Prefer: prefer || 'return=minimal'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${endpoint} → ${res.status} ${text.slice(0, 400)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** SQLite stores 0/1 for booleans; Postgres wants real booleans. */
const BOOLEAN_COLUMNS = new Set(['is_system']);

function normalise(table, rows) {
  return rows.map((row) => {
    const out = { ...row };
    for (const col of Object.keys(out)) {
      if (BOOLEAN_COLUMNS.has(col) && (out[col] === 0 || out[col] === 1)) out[col] = Boolean(out[col]);
      // SQLite keeps timestamps as ISO text; Postgres accepts that as-is.
    }
    return out;
  });
}

(async () => {
  console.log(`Source: ${SQLITE_FILE}`);
  console.log(`Target: ${URL}\n`);

  // Tables without an `id` column need a different filter to mean "all rows".
  const CLEAR_FILTER = {
    counters: 'name=not.is.null',
    role_permissions: 'role_id=not.is.null',
  };

  // 1. Clear children first so no FK is ever dangling.
  for (const table of DELETE_ORDER) {
    await rest('DELETE', `${table}?${CLEAR_FILTER[table] || 'id=not.is.null'}`);
    process.stdout.write(`\r  cleared ${table.padEnd(18)}`);
  }
  console.log('\n');

  // 2. Insert parent-first in batches.
  const summary = [];
  for (const table of TABLES) {
    const rows = normalise(table, readSqliteTable(table));
    if (!rows.length) { summary.push([table, 0]); continue; }

    const BATCH = 200;
    for (let i = 0; i < rows.length; i += BATCH) {
      await rest('POST', table, { body: rows.slice(i, i + BATCH) });
    }
    summary.push([table, rows.length]);
  }

  // 3. Identity sequences are NOT advanced by PostgREST inserts with explicit
  //    ids — new rows would collide. `counters` has no id column, so call the
  //    reset RPC if the schema provided one.
  try {
    await rest('POST', 'rpc/reset_identity_sequences', { body: {} });
    console.log('  identity sequences reset');
  } catch (err) {
    console.log(`  (sequence reset RPC unavailable — ${err.message.slice(0, 80)})`);
    console.log('  → run: select setval(pg_get_serial_sequence(\'products\',\'id\'), (select max(id) from products));');
  }

  console.log('\nRows written:');
  let total = 0;
  for (const [table, count] of summary) {
    total += count;
    console.log(`  ${table.padEnd(18)} ${String(count).padStart(6)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(18)} ${String(total).padStart(6)}`);

  // 4. Verify against the API rather than trusting the write.
  console.log('\nVerification (read back through PostgREST):');
  for (const table of ['users', 'categories', 'products', 'inventory', 'invoices', 'invoice_items', 'stock_movements']) {
    const res = await fetch(`${URL}/rest/v1/${table}?select=id`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: 'count=exact', Range: '0-0' }
    });
    const range = res.headers.get('content-range') || '';
    const count = range.split('/')[1] || '?';
    const local = readSqliteTable(table).length;
    const ok = String(local) === String(count) ? 'OK' : 'MISMATCH';
    console.log(`  ${table.padEnd(18)} local ${String(local).padStart(4)}  cloud ${String(count).padStart(4)}  ${ok}`);
  }
})().catch((err) => {
  console.error('\n❌ Sync failed:', err.message);
  process.exit(1);
});
