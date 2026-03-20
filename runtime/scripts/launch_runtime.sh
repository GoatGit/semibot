#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_PY="$ROOT_DIR/.venv/bin/python"

HOST="${HOST:-127.0.0.1}"
RUNTIME_PORT="${RUNTIME_PORT:-8765}"
RUNTIME_DB_PATH="${RUNTIME_DB_PATH:-}"
RUNTIME_RULES_PATH="${RUNTIME_RULES_PATH:-}"

PYTHON_BIN="python3"
if [ -x "$VENV_PY" ]; then
  PYTHON_BIN="$VENV_PY"
fi

CMD=(
  "$PYTHON_BIN"
  "$ROOT_DIR/main.py"
  "serve-daemon"
  "--host" "$HOST"
  "--port" "$RUNTIME_PORT"
  "--db-path" "$RUNTIME_DB_PATH"
  "--rules-path" "$RUNTIME_RULES_PATH"
)

if [ -n "${RUNTIME_HEARTBEAT_INTERVAL:-}" ]; then
  CMD+=("--heartbeat-interval" "$RUNTIME_HEARTBEAT_INTERVAL")
fi

if [ -n "${RUNTIME_CRON_JOBS_JSON:-}" ]; then
  CMD+=("--cron-jobs-json" "$RUNTIME_CRON_JOBS_JSON")
fi

exec "${CMD[@]}"
