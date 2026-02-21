#!/usr/bin/env bash
set -euo pipefail

# Show local execution-plane runtime process status for a user.
# Usage:
#   scripts/vm/status-local.sh <user_id>
#   VM_USER_ID=<user_id> scripts/vm/status-local.sh

USER_ID="${1:-${VM_USER_ID:-}}"
if [[ -z "${USER_ID}" ]]; then
  echo "Usage: $0 <user_id>" >&2
  exit 1
fi

RUNTIME_LOG_DIR="${RUNTIME_LOG_DIR:-/tmp}"
PID_FILE="${RUNTIME_LOG_DIR}/semibot-runtime-${USER_ID}.pid"
LOG_FILE="${RUNTIME_LOG_DIR}/semibot-runtime-${USER_ID}.log"

if [[ ! -f "${PID_FILE}" ]]; then
  echo "[status-local] not running (pid file missing)"
  exit 0
fi

PID="$(cat "${PID_FILE}" || true)"
if [[ -z "${PID}" ]]; then
  echo "[status-local] invalid pid file"
  exit 0
fi

if kill -0 "${PID}" >/dev/null 2>&1; then
  echo "[status-local] running pid=${PID}"
else
  echo "[status-local] stale pid file, process not alive (pid=${PID})"
fi

if [[ -f "${LOG_FILE}" ]]; then
  echo "[status-local] log=${LOG_FILE}"
  tail -n 20 "${LOG_FILE}" || true
fi
