'use strict';
/**
 * Local PostgreSQL lifecycle helper — development / preview convenience only.
 *
 * The preview sandbox has no Postgres daemon and no root, so the app carries an
 * embedded one (`embedded-postgres`, a dev dependency). Its data directory must
 * live inside the workspace, because /tmp is not captured by snapshots and the
 * preview would otherwise come back to an empty, unreachable cluster.
 *
 * Nothing here runs when DATABASE_URL points at a hosted database (Supabase):
 * `ensureLocalPostgres` returns immediately for a non-loopback host.
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');

const DEFAULT_DIR = path.join(__dirname, '..', '..', 'data', 'pgdata');

/** Parses a postgres:// URL into the pieces embedded-postgres wants. */
function parse(databaseUrl) {
  const u = new URL(databaseUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username || 'postgres'),
    password: decodeURIComponent(u.password || 'postgres'),
    database: (u.pathname || '/postgres').slice(1) || 'postgres',
    dir: process.env.PGDATA_DIR || DEFAULT_DIR,
  };
}

function portOpen(port, host = '127.0.0.1', timeout = 700) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** Locates the bundled binaries; they disappear when node_modules is pruned. */
function binaries() {
  const roots = [
    path.join(__dirname, '..', '..', 'node_modules', '@embedded-postgres'),
    path.join(__dirname, '..', '..', 'node_modules', 'embedded-postgres', '..', '@embedded-postgres'),
  ];
  const candidates = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      if (entry.startsWith('linux-x64')) candidates.push(path.join(root, entry, 'native'));
    }
  }
  for (const native of candidates) {
    const bin = path.join(native, 'bin', 'pg_ctl');
    const initdb = path.join(native, 'bin', 'initdb');
    if (fs.existsSync(bin) && fs.existsSync(initdb)) return { native, bin, initdb };
  }
  return null;
}

function initCluster(b) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(DEFAULT_DIR), { recursive: true });
    const authFile = path.join(DEFAULT_DIR, '..', `.pgpass-${Date.now()}`);
    fs.writeFileSync(authFile, 'postgres\n');
    const child = spawn(b.initdb, ['-D', DEFAULT_DIR, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d.toString(); });
    child.stderr.on('data', (d) => { log += d.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      try { fs.unlinkSync(authFile); } catch (_) { /* ignore */ }
      code === 0 ? resolve() : reject(new Error(`initdb exited ${code}: ${log.slice(-300)}`));
    });
  });
}

function startCluster(b, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(b.bin, ['-D', DEFAULT_DIR, '-l', path.join(DEFAULT_DIR, 'server.log'), '-o', `-p ${port}`, 'start', '-w'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d.toString(); });
    child.stderr.on('data', (d) => { log += d.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      code === 0 ? resolve() : reject(new Error(`pg_ctl start exited ${code}: ${log.slice(-300)}`));
    });
  });
}

/**
 * Makes sure a loopback Postgres is reachable.
 * @returns {Promise<boolean>} true if a cluster was started (caller must re-create its pool)
 */
async function ensureLocalPostgres(databaseUrl) {
  const c = parse(databaseUrl);
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(c.host)) return false;

  if (await portOpen(c.port)) return false; // already running — nothing to do

  const b = binaries();
  if (!b) {
    console.warn('[db] no local PostgreSQL running and embedded-postgres is not installed — run: npm ci');
    return false;
  }

  if (!fs.existsSync(path.join(c.dir, 'PG_VERSION'))) {
    console.log(`[db] initialising a local PostgreSQL cluster at ${c.dir}`);
    await initCluster(b);
  }

  try {
    await startCluster(b, c.port);
  } catch (err) {
    // A concurrent boot may have won the race; that is fine.
    if (await portOpen(c.port)) return false;
    throw err;
  }

  // Give the socket a moment to accept connections.
  for (let i = 0; i < 40 && !(await portOpen(c.port)); i += 1) {
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log(`[db] started local PostgreSQL on port ${c.port}`);
  return true;
}

/**
 * Creates the target database on a loopback cluster if it does not exist yet.
 * @returns {Promise<boolean>} true if it was created
 */
async function ensureDatabase(databaseUrl) {
  const c = parse(databaseUrl);
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(c.host)) return false;
  if (c.database === 'postgres') return false;

  const { Client } = require('pg');
  const client = new Client({
    host: c.host, port: c.port, user: c.user, password: c.password, database: 'postgres',
  });
  await client.connect();
  try {
    const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [c.database]);
    if (rowCount) return false;
    // Identifiers cannot be parameterised; the name is a URL path segment.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.database)) {
      throw new Error(`Unsafe database name: ${c.database}`);
    }
    await client.query(`create database ${c.database}`);
    console.log(`[db] created database "${c.database}"`);
    return true;
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = { ensureLocalPostgres, ensureDatabase, DEFAULT_DIR };
