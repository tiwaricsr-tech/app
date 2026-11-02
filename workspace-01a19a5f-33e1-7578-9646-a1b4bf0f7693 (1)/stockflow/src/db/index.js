'use strict';
/**
 * Portable SQL layer.
 *
 *  • DATABASE_URL unset  -> embedded SQLite via better-sqlite3 (instant local run).
 *  • DATABASE_URL set    -> PostgreSQL / Supabase. Application SQL is written in the
 *                           common subset; schema + RLS live in /supabase.
 *
 * Transaction safety
 * ------------------
 * SQLite mode serialises every statement through a single async mutex, so a
 * `tx()` block is truly exclusive: no other request can interleave a statement
 * between our BEGIN/COMMIT, which is what makes invoice + stock updates atomic.
 * PostgreSQL mode uses a dedicated pooled client with real BEGIN/COMMIT.
 *
 * Services receive a `conn` (either this module or a tx-scoped handle) so they
 * never open a nested transaction by accident.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

let driver = 'sqlite';
let sqlite = null;
let pool = null;
let mutex = Promise.resolve();

if (config.databaseUrl) {
  driver = 'postgres';
} else {
  fs.mkdirSync(path.dirname(config.sqliteFile), { recursive: true });
  const Database = require('better-sqlite3');
  sqlite = new Database(config.sqliteFile);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
}

/** Runs `fn` with exclusive access to the SQLite connection. */
function withLock(fn) {
  const run = mutex.then(fn, fn);
  mutex = run.then(() => {}, () => {});
  return run;
}

// SQLite needs "?", PostgreSQL needs "$1..$n".
function toNative(sql) {
  if (driver === 'sqlite') return sql;
  let i = 0;
  return sql.replace(/\?/g, () => '$' + ++i);
}

/**
 * PostgreSQL needs `RETURNING id` to report lastInsertRowid for plain INSERTs.
 * Anything already using ON CONFLICT / RETURNING is left untouched.
 */
function withReturning(sql) {
  const startsWrite = /^\s*(insert|update|delete)/i.test(sql);
  if (!startsWrite) return sql;
  if (/\breturning\b/i.test(sql)) return sql;
  if (/\bon\s+conflict\b/i.test(sql)) return sql;
  return `${sql} RETURNING *`;
}

function normalizeParams(params) {
  if (params.length === 1 && Array.isArray(params[0])) return params[0];
  return params.length ? params : [];
}

const plain = (row) => (row ? { ...row } : undefined);

/**
 * PostgreSQL returns NUMERIC as strings and BIGINT as strings; the rest of the app
 * (and the browser) expects numbers. Coerce known money/count columns so both engines
 * produce identical JSON.
 */
const NUMERIC_COLUMNS = new Set([
  'purchase_price', 'selling_price', 'subtotal', 'discount_value', 'discount_amount',
  'tax_rate', 'tax_amount', 'total', 'unit_price', 'line_total', 'unit_cost',
  'stock_value_purchase', 'stock_value_selling', 'purchase_value', 'selling_value',
  'potential_profit', 'revenue', 'taxable', 'margin', 'quantity', 'low_stock_threshold',
  'quantity_change', 'quantity_before', 'quantity_after', 'item_count', 'invoice_count',
  'bills', 'cancelled', 'refunded', 'value', 'units', 'units_sold', 'sold', 'stock_in',
  'stock_out', 'returned', 'adjusted', 'current_stock', 'product_count', 'total_units',
  'purchase_value', 'selling_value', 'low_stock_count', 'out_of_stock_count', 'n', 'total',
  'count', 'discount', 'tax', 'restock'
]);

function coerceRow(row) {
  if (!row) return row;
  for (const key of Object.keys(row)) {
    const val = row[key];
    if (typeof val !== 'string') continue;
    if (!NUMERIC_COLUMNS.has(key)) continue;
    const n = Number(val);
    if (Number.isFinite(n)) row[key] = n;
  }
  return row;
}

// ── SQLite: unscoped handle (used inside the exclusive tx) ───────────────────
const rawSqlite = {
  all: (sql, params) => sqlite.prepare(sql).all(...params).map(plain),
  get: (sql, params) => plain(sqlite.prepare(sql).get(...params)),
  run: (sql, params) => {
    const info = sqlite.prepare(sql).run(...params);
    return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
  }
};

const sqliteApi = {
  all: (sql, ...params) => withLock(() => rawSqlite.all(sql, normalizeParams(params))),
  get: (sql, ...params) => withLock(() => rawSqlite.get(sql, normalizeParams(params))),
  run: (sql, ...params) => withLock(() => rawSqlite.run(sql, normalizeParams(params))),
  exec: (sql) => withLock(() => { sqlite.exec(sql); }),
  async tx(fn) {
    return withLock(async () => {
      const sp = 'sp_' + Math.random().toString(36).slice(2);
      sqlite.exec('SAVEPOINT ' + sp);
      try {
        // The scoped handle never re-acquires the mutex (it is already held).
        const scope = {
          driver,
          tx: true,
          all: async (sql, ...p) => rawSqlite.all(sql, normalizeParams(p)),
          get: async (sql, ...p) => rawSqlite.get(sql, normalizeParams(p)),
          run: async (sql, ...p) => rawSqlite.run(sql, normalizeParams(p))
        };
        const result = await fn(scope);
        sqlite.exec('RELEASE ' + sp);
        return result;
      } catch (err) {
        try { sqlite.exec('ROLLBACK TO ' + sp); sqlite.exec('RELEASE ' + sp); } catch (_) { /* ignore */ }
        throw err;
      }
    });
  }
};

// ── PostgreSQL ──────────────────────────────────────────────────────────────
const pgApi = {
  async all(sql, ...params) {
    return (await pool.query(toNative(sql), normalizeParams(params))).rows.map(coerceRow);
  },
  async get(sql, ...params) {
    const row = (await pool.query(toNative(sql), normalizeParams(params))).rows[0];
    return coerceRow(row);
  },
  async run(sql, ...params) {
    const res = await pool.query(toNative(withReturning(sql)), normalizeParams(params));
    if (res.rows) res.rows.forEach(coerceRow);
    return {
      changes: res.rowCount,
      lastInsertRowid: res.rows && res.rows[0] ? Number(res.rows[0].id) : undefined,
      rows: res.rows
    };
  },
  async exec(sql) { await pool.query(sql); },
  async tx(fn) {
    const client = await pool.connect();
    const scope = {
      driver,
      tx: true,
      // Nested transaction: reuse the same client via a savepoint instead of checking
      // out a second connection (which would deadlock against the outer transaction).
      tx: async (inner) => {
        const sp = 'sp_' + Math.random().toString(36).slice(2);
        await client.query(`SAVEPOINT ${sp}`);
        try {
          const out = await inner(scope);
          await client.query(`RELEASE SAVEPOINT ${sp}`);
          return out;
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          throw err;
        }
      },
      all: async (sql, ...p) => (await client.query(toNative(sql), normalizeParams(p))).rows.map(coerceRow),
      get: async (sql, ...p) => coerceRow((await client.query(toNative(sql), normalizeParams(p))).rows[0]),
      run: async (sql, ...p) => {
        const res = await client.query(toNative(withReturning(sql)), normalizeParams(p));
        if (res.rows) res.rows.forEach(coerceRow);
        return {
          changes: res.rowCount,
          lastInsertRowid: res.rows && res.rows[0] ? Number(res.rows[0].id) : undefined,
          rows: res.rows
        };
      }
    };
    try {
      await client.query('BEGIN');
      const result = await fn(scope);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
  }
};

const api = driver === 'postgres' ? pgApi : sqliteApi;

const db = {
  driver,
  async init() {
    if (driver === 'postgres') {
      const { Pool } = require('pg');
      const makePool = () => new Pool({
        connectionString: config.databaseUrl,
        ssl: /supabase\.|sslmode=require|neon\.tech/.test(config.databaseUrl)
          ? { rejectUnauthorized: false }
          : undefined,
        max: config.pgPoolMax,
        connectionTimeoutMillis: config.pgConnectTimeoutMs,
        // Serverless platforms kill idle sockets underneath us; recycle early.
        idleTimeoutMillis: 30000,
        keepAlive: true
      });

      pool = makePool();
      // A pool-level error must never take the process down mid-request.
      pool.on('error', (err) => console.error('[pg] idle client error:', err.message));

      // Developer convenience: a local Postgres that is not running yet is
      // started for us, and an empty database has the schema applied. Without
      // this the server would boot into a dead pool and every request would 500.
      const local = /127\.0\.0\.1|localhost/.test(config.databaseUrl);
      if (local) {
        const { ensureLocalPostgres, ensureDatabase } = require('./local-postgres');
        const started = await ensureLocalPostgres(config.databaseUrl);
        if (started) pool = makePool();
        // A freshly initialised cluster has only the default databases.
        if (await ensureDatabase(config.databaseUrl)) pool = makePool();
      }

      try {
        await pool.query('select 1');
      } catch (err) {
        throw new Error(`Cannot reach PostgreSQL at ${config.databaseUrl.replace(/:[^:@]+@/, ':****@')} — ${err.message}`);
      }

      // An empty database (fresh volume / recreated local cluster) needs the
      // production schema before the app can serve a single request.
      try {
        await pool.query('select 1 from products limit 1');
      } catch (err) {
        if (/does not exist/.test(err.message)) {
          const path = require('path');
          const fsx = require('fs');
          const file = path.join(config.root, 'supabase', 'schema.sql');
          await pool.query(fsx.readFileSync(file, 'utf8'));
          console.log('[db] applied supabase/schema.sql (database was empty)');
        } else {
          throw err;
        }
      }
    } else {
      const { ensureSchema } = require('./schema');
      await ensureSchema(sqliteApi);
    }
  },
  all: api.all,
  get: api.get,
  run: api.run,
  exec: api.exec,
  tx: api.tx,
  /** Cross-driver timestamp helper: ISO text on SQLite, native Date on Postgres. */
  ts: (value) => (driver === 'postgres' ? new Date(value) : new Date(value).toISOString()),
  /**
   * Shifted timestamp used for DAY/MONTH bucketing so "today" means the business
   * timezone (default IST) instead of UTC.
   */
  tsShift: (value, minutes) => {
    const d = new Date(new Date(value).getTime() + minutes * 60000);
    return driver === 'postgres' ? d : d.toISOString();
  }
};

module.exports = db;
