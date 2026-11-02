#!/usr/bin/env bash
# Prepares the workspace and starts the app. Idempotent.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules ] || [ ! -f node_modules/express/package.json ]; then
  npm ci --no-audit --no-fund
fi

exec ./start.sh "$@"
