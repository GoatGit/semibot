#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_PY="$ROOT_DIR/.venv/bin/python"

HOST="${HOST:-127.0.0.1}"
RUNTIME_PORT="${RUNTIME_PORT:-8765}"
RUNTIME_DB_PATH="${RUNTIME_DB_PATH:-}"
RUNTIME_RULES_PATH="${RUNTIME_RULES_PATH:-}"

existing_pid="$(lsof -tiTCP:${RUNTIME_PORT} -sTCP:LISTEN 2>/dev/null | head -n1 || true)"
if [ -n "${existing_pid}" ]; then
  existing_cmd="$(ps -p "${existing_pid}" -o command= 2>/dev/null || true)"
  existing_cwd="$(lsof -a -p "${existing_pid}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n1 || true)"
  current_root="$(cd "${ROOT_DIR}" && pwd -P)"
  existing_root="$(cd "${existing_cwd}" 2>/dev/null && pwd -P || true)"
  if [[ "${existing_cmd}" == *"/semibot-internal/runtime/main.py serve-daemon"* || "${existing_cmd}" == *"/semibot/runtime/main.py serve-daemon"* ]]; then
    if [[ -n "${existing_root}" ]] && [[ "${existing_root}" == "${current_root}" ]]; then
      echo "[semibot-runtime] stopping stale runtime on port ${RUNTIME_PORT} (pid ${existing_pid})"
      kill "${existing_pid}" 2>/dev/null || true
      for _ in $(seq 1 50); do
        if ! lsof -tiTCP:${RUNTIME_PORT} -sTCP:LISTEN >/dev/null 2>&1; then
          break
        fi
        sleep 0.1
      done
      if lsof -tiTCP:${RUNTIME_PORT} -sTCP:LISTEN >/dev/null 2>&1; then
        echo "[semibot-runtime] port ${RUNTIME_PORT} is still busy after stopping stale pid ${existing_pid}" >&2
        exit 1
      fi
    fi
  fi
fi

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
