'use strict';
/**
 * Copies the local SQLite dataset into PostgreSQL / Supabase.
 *
 *   SUPABASE_DB_URL='postgres://...' node src/db/migrate-to-postgres.js
 *
 * Run `supabase/schema.sql` in Supabase first. This script then:
 *   1. truncates the target tables (restart identity, cascade),
 *   2. streams every row across in FK-safe order,
 *   3. resets all identity sequences so new inserts never collide,
 *   4. verifies row counts and the stock-ledger invariant.
 *
 * Safe to re-run: it always starts from a clean target.
 */
const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

const SQLITE_FILE = process.env.SQLITE_FILE || path.join(__dirname, '..', '..', 'data', 'stockflow.db');
const PG_URL = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;

if (!PG_URL) {
  console.error('Missing SUPABASE_DB_URL (or DATABASE_URL). Aborting.');
  process.exit(1);
}

// Child order respects foreign keys.
const TABLES = [
  'roles', 'permissions', 'role_permissions', 'users', 'categories', 'products',
  'inventory', 'stock_movements', 'invoices', 'invoice_items', 'counters', 'activity_log'
];

/** Reads a SQLite table as JSON using the project's own better-sqlite3 install. */
function readSqliteTable(table) {
  const code = `
    const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
    const db = new Database(${JSON.stringify(SQLITE_FILE)}, { readonly: true });
    const rows = db.prepare('SELECT * FROM ${table}').all();
    process.stdout.write(JSON.stringify(rows));
  `;
  const out = execFileSync(process.execPath, ['-e', code], { maxBuffer: 512 * 1024 * 1024 });
  return JSON.parse(out.toString() || '[]');
}

(async () => {
  const pool = new Pool({
    connectionString: PG_URL,
    ssl: /supabase\.|sslmode=require/.test(PG_URL) ? { rejectUnauthorized: false } : undefined,
    max: 4
  });

  const client = await pool.connect();
  const summary = [];
  try {
    console.log(`Source: ${SQLITE_FILE}`);
    console.log(`Target: ${PG_URL.replace(/:[^:@]+@/, ':****@')}\n`);

    const { rows: existing } = await client.query(
      `select table_name from information_schema.tables where table_schema = 'public'`
    );
    const present = new Set(existing.map((r) => r.table_name));
    const missing = TABLES.filter((t) => !present.has(t));
    if (missing.length) {
      throw new Error(`Target is missing tables: ${missing.join(', ')}. Run supabase/schema.sql first.`);
    }

    await client.query('BEGIN');
    await client.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);

    for (const table of TABLES) {
      const rows = readSqliteTable(table);
      if (!rows.length) { summary.push([table, 0]); continue; }

      const columns = Object.keys(rows[0]);
      const quoted = columns.map((c) => `"${c}"`).join(', ');
      // Insert in chunks so we stay well under parameter limits.
      const chunkSize = Math.max(1, Math.floor(60000 / columns.length));
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const values = [];
        const placeholders = chunk.map((row, r) => {
          const ph = columns.map((c, cIdx) => {
            const v = row[c];
            values.push(v === undefined ? null : v);
            return `$${r * columns.length + cIdx + 1}`;
          });
          return `(${ph.join(', ')})`;
        });
        await client.query(
          `INSERT INTO ${table} (${quoted}) VALUES ${placeholders.join(', ')}`,
          values
        );
      }
      summary.push([table, rows.length]);
    }

    // Reset identity sequences so the API's INSERTs continue after the migrated ids.
    for (const table of TABLES) {
      try {
        await client.query(
          `SELECT setval(pg_get_serial_sequence('${table}', 'id'),
                         COALESCE((SELECT MAX(id) FROM ${table}), 1),
                         (SELECT COUNT(*) > 0 FROM ${table}))`
        );
      } catch (_) { /* tables without an id column (role_permissions, counters) */ }
    }

    await client.query('COMMIT');

    console.log('Migrated rows:');
    for (const [table, count] of summary) {
      console.log(`  ${table.padEnd(18)} ${String(count).padStart(6)}`);
    }

    // ── verification ──────────────────────────────────────────────────────
    const checks = await client.query(`
      SELECT p.sku,
             i.quantity,
             COALESCE((SELECT SUM(m.quantity_change) FROM stock_movements m WHERE m.product_id = p.id), 0) AS ledger
        FROM products p JOIN inventory i ON i.product_id = p.id
    `);
    const mismatches = checks.rows.filter((r) => Number(r.quantity) !== Number(r.ledger));
    const negatives = checks.rows.filter((r) => Number(r.quantity) < 0);

    const counts = await client.query(`
      SELECT (SELECT COUNT(*) FROM products)  AS products,
             (SELECT COUNT(*) FROM invoices)  AS invoices,
             (SELECT COUNT(*) FROM users)     AS users,
             (SELECT COUNT(*) FROM stock_movements) AS movements
    `);
    const c = counts.rows[0];

    console.log('\nVerification:');
    console.log(`  products ${c.products} · invoices ${c.invoices} · users ${c.users} · movements ${c.movements}`);
    console.log(`  ledger mismatches: ${mismatches.length}`);
    console.log(`  negative stock rows: ${negatives.length}`);

    if (mismatches.length || negatives.length) {
      console.error('\n❌ Integrity check failed — do not point the API at this database yet.');
      process.exitCode = 1;
    } else {
      console.log('\n✅ Migration complete and verified.');
    }
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('\n❌ Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
