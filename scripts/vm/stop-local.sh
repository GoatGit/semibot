#!/usr/bin/env bash
set -euo pipefail

# Stop local execution-plane runtime process started by bootstrap-local.sh
# Usage:
#   scripts/vm/stop-local.sh <user_id>
#   VM_USER_ID=<user_id> scripts/vm/stop-local.sh

USER_ID="${1:-${VM_USER_ID:-}}"
if [[ -z "${USER_ID}" ]]; then
  echo "Usage: $0 <user_id>" >&2
  exit 1
fi

RUNTIME_LOG_DIR="${RUNTIME_LOG_DIR:-/tmp}"
PID_FILE="${RUNTIME_LOG_DIR}/semibot-runtime-${USER_ID}.pid"

if [[ ! -f "${PID_FILE}" ]]; then
  echo "[stop-local] pid file not found: ${PID_FILE}"
  exit 0
fi

PID="$(cat "${PID_FILE}" || true)"
if [[ -z "${PID}" ]]; then
  echo "[stop-local] empty pid file: ${PID_FILE}"
  rm -f "${PID_FILE}"
  exit 0
fi

if kill -0 "${PID}" >/dev/null 2>&1; then
  kill "${PID}" >/dev/null 2>&1 || true
  sleep 1
  if kill -0 "${PID}" >/dev/null 2>&1; then
    kill -9 "${PID}" >/dev/null 2>&1 || true
  fi
  echo "[stop-local] stopped runtime for user ${USER_ID} (pid=${PID})"
else
  echo "[stop-local] process already exited (pid=${PID})"
fi

rm -f "${PID_FILE}"
