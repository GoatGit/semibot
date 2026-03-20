#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$ROOT_DIR/apps/web"

cd "$APP_DIR"

export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-${WEB_PORT:-3000}}"
export WEB_PORT="${WEB_PORT:-$PORT}"
export API_PORT="${API_PORT:-3001}"
export API_INTERNAL_URL="${API_INTERNAL_URL:-http://127.0.0.1:${API_PORT}}"
export NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-${API_INTERNAL_URL}/api/v1}"

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

NEXT_BIN="$(node -p "require.resolve('next/dist/bin/next')")"
exec node "$NEXT_BIN" start --hostname "$HOST" --port "$PORT"
