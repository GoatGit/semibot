#!/usr/bin/env bash
set -euo pipefail

# Local bootstrap entry for execution-plane VM process.
# Expected env:
#   VM_USER_ID
#   VM_ORG_ID
#   VM_INSTANCE_ID
#   VM_MODE
#
# Optional env:
#   CONTROL_PLANE_WS (default: ws://127.0.0.1:3001/ws/vm)
#   RUNTIME_WORKDIR   (default: runtime)
#   RUNTIME_LOG_DIR   (default: /tmp)
#   FORCE_RESTART_RUNTIME (default: false)

if [[ -z "${VM_USER_ID:-}" || -z "${VM_ORG_ID:-}" || -z "${VM_INSTANCE_ID:-}" ]]; then
  echo "[bootstrap-local] missing required env: VM_USER_ID / VM_ORG_ID / VM_INSTANCE_ID" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME_WORKDIR="${RUNTIME_WORKDIR:-runtime}"
RUNTIME_LOG_DIR="${RUNTIME_LOG_DIR:-/tmp}"
CONTROL_PLANE_WS="${CONTROL_PLANE_WS:-ws://127.0.0.1:3001/ws/vm}"
FORCE_RESTART_RUNTIME="${FORCE_RESTART_RUNTIME:-false}"

LOG_FILE="${RUNTIME_LOG_DIR}/semibot-runtime-${VM_USER_ID}.log"
PID_FILE="${RUNTIME_LOG_DIR}/semibot-runtime-${VM_USER_ID}.pid"

mkdir -p "${RUNTIME_LOG_DIR}"

if [[ -f "${PID_FILE}" ]]; then
  OLD_PID="$(cat "${PID_FILE}" || true)"
  if [[ -n "${OLD_PID}" ]] && kill -0 "${OLD_PID}" >/dev/null 2>&1; then
    if [[ "${FORCE_RESTART_RUNTIME}" == "true" ]]; then
      echo "[bootstrap-local] force restarting runtime for user ${VM_USER_ID} (old pid=${OLD_PID})"
      kill "${OLD_PID}" >/dev/null 2>&1 || true
      sleep 0.2
      if kill -0 "${OLD_PID}" >/dev/null 2>&1; then
        kill -9 "${OLD_PID}" >/dev/null 2>&1 || true
      fi
      rm -f "${PID_FILE}"
    else
      echo "[bootstrap-local] runtime already running for user ${VM_USER_ID} (pid=${OLD_PID})"
      exit 0
    fi
  fi
fi

RUNTIME_DIR="${ROOT_DIR}/${RUNTIME_WORKDIR}"
if [[ ! -d "${RUNTIME_DIR}" ]]; then
  echo "[bootstrap-local] runtime directory not found: ${RUNTIME_DIR}" >&2
  exit 1
fi

if [[ ! -x "${RUNTIME_DIR}/.venv/bin/python" ]]; then
  echo "[bootstrap-local] python runtime missing: ${RUNTIME_DIR}/.venv/bin/python" >&2
  exit 1
fi

if [[ -z "${VM_TOKEN:-}" ]]; then
  echo "[bootstrap-local] VM_TOKEN is required for runtime auth" >&2
  exit 1
fi

(
  cd "${RUNTIME_DIR}"
  nohup env \
    CONTROL_PLANE_WS="${CONTROL_PLANE_WS}" \
    VM_USER_ID="${VM_USER_ID}" \
    VM_TICKET="${VM_TICKET:-}" \
    VM_TOKEN="${VM_TOKEN}" \
    ./.venv/bin/python -m src.main \
    >"${LOG_FILE}" 2>&1 &
  echo $! > "${PID_FILE}"
)

echo "[bootstrap-local] runtime started for user ${VM_USER_ID}, pid=$(cat "${PID_FILE}") log=${LOG_FILE}"
