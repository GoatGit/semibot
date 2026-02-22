#!/usr/bin/env bash
set -euo pipefail

# Force restart local execution-plane runtime for one user.
# Usage:
#   scripts/vm/rebootstrap-local.sh <user_id>
#   VM_USER_ID=<user_id> scripts/vm/rebootstrap-local.sh
# Required extra env for bootstrap:
#   VM_ORG_ID
#   VM_INSTANCE_ID
#   VM_TOKEN

USER_ID="${1:-${VM_USER_ID:-}}"
if [[ -z "${USER_ID}" ]]; then
  echo "Usage: $0 <user_id>" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

"${ROOT_DIR}/scripts/vm/stop-local.sh" "${USER_ID}" || true
VM_USER_ID="${USER_ID}" \
VM_ORG_ID="${VM_ORG_ID:-}" \
VM_INSTANCE_ID="${VM_INSTANCE_ID:-}" \
VM_MODE="${VM_MODE:-docker}" \
VM_TOKEN="${VM_TOKEN:-}" \
VM_TICKET="${VM_TICKET:-}" \
FORCE_RESTART_RUNTIME="true" \
"${ROOT_DIR}/scripts/vm/bootstrap-local.sh"
