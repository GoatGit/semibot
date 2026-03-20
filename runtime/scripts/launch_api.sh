#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$ROOT_DIR/apps/api"

cd "$APP_DIR"

export HOST="${HOST:-127.0.0.1}"
export API_PORT="${API_PORT:-3001}"
export WEB_PORT="${WEB_PORT:-3000}"
export RUNTIME_PORT="${RUNTIME_PORT:-8765}"
export RUNTIME_URL="${RUNTIME_URL:-http://127.0.0.1:${RUNTIME_PORT}}"

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
elif [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [ -f dist/index.js ]; then
  exec node dist/index.js
fi

exec node --import tsx src/index.ts
