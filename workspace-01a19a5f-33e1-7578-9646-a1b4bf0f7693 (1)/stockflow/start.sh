#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  One-command start. Safe to run any number of times.
#
#    ./start.sh          # preview / local dev  (local PostgreSQL on :55432)
#    ./start.sh sqlite   # force the embedded SQLite engine instead
#
#  Handles the three things that break a resumed workspace:
#    1. node_modules missing  -> npm ci
#    2. local Postgres not running -> initialised + started from data/pgdata
#    3. database empty / schema absent -> schema.sql + demo seed
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-4173}"
PG_PORT="${PG_PORT:-55432}"

# Local runtime overrides (.env.local wins over nothing, loses to real env).
if [ -f .env.local ] && [ -z "${DATABASE_URL:-}" ]; then
  set -a; . ./.env.local; set +a
fi

echo "StockFlow bootstrap"

# 1. dependencies ────────────────────────────────────────────────────────────
if [ ! -d node_modules ] || [ ! -f node_modules/express/package.json ]; then
  echo "  installing dependencies (npm ci)…"
  npm ci --no-audit --no-fund
fi

# 2. port already serving? ───────────────────────────────────────────────────
if curl -sf -m 3 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  echo "  already running on :${PORT} — nothing to do"
  curl -s "http://127.0.0.1:${PORT}/api/health"; echo
  exit 0
fi

# 3. database ────────────────────────────────────────────────────────────────
if [ "${1:-}" = "sqlite" ]; then
  echo "  engine: SQLite (data/stockflow.db)"
  exec node src/server.js
fi

export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/stockflow}"
echo "  engine: PostgreSQL (${DATABASE_URL##*@})"

# The server itself starts an embedded cluster and applies the schema when the
# database is cold — no separate step needed.

# 4. run ─────────────────────────────────────────────────────────────────────
exec node src/server.js
