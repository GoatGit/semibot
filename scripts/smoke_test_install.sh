#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="${TEST_ROOT:-$(mktemp -d /tmp/semibot-install-smoke.XXXXXX)}"
SEMIBOT_HOME="$TEST_ROOT/home"
LOCAL_BIN="$TEST_ROOT/bin"
RELEASE_DIR="${SEMIBOT_RELEASE_DIR:-$ROOT_DIR/.release/current}"
RELEASE_VERSION="${SEMIBOT_RELEASE_VERSION:-$(python3 - "$RELEASE_DIR/manifest.json" <<'PY'
import json
import sys
from pathlib import Path
manifest = Path(sys.argv[1])
if not manifest.exists():
    print("current")
else:
    print(json.loads(manifest.read_text(encoding="utf-8")).get("version") or "current")
PY
)}"
RELEASE_ARCHIVE="${SEMIBOT_RELEASE_ARCHIVE:-$ROOT_DIR/.release/semibot-${RELEASE_VERSION}.tar.gz}"
RELEASE_ARCHIVE_SHA256_FILE="${SEMIBOT_RELEASE_ARCHIVE_SHA256_FILE:-${RELEASE_ARCHIVE}.sha256}"

checksum_value() {
  awk '{print $1}' "$1"
}

rebuild_release() {
  echo "[semibot-smoke] rebuilding local release snapshot"
  SKIP_BUILD="${SKIP_BUILD:-1}" INCLUDE_NODE_MODULES="${INCLUDE_NODE_MODULES:-1}" INCLUDE_RUNTIME_VENV="${INCLUDE_RUNTIME_VENV:-1}" \
    "$ROOT_DIR/scripts/build_release.sh"
}

cleanup() {
  if [[ "${KEEP_TEST_ROOT:-0}" != "1" ]]; then
    rm -rf "$TEST_ROOT"
  else
    echo "[semibot-smoke] kept test root: $TEST_ROOT"
  fi
}
trap cleanup EXIT

if [[ ! -d "$RELEASE_DIR" ]]; then
  echo "[semibot-smoke] release not found"
  rebuild_release
fi

echo "[semibot-smoke] checking release build report"
python3 - "$RELEASE_DIR/build-report.json" <<'PY'
import json
import sys
from pathlib import Path

report = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
if not report.get("ok"):
    raise SystemExit("release build report is not ok")
print("[semibot-smoke] release report ok")
PY

echo "[semibot-smoke] checking release archive artifacts"
if [[ ! -f "$RELEASE_ARCHIVE" ]]; then
  rebuild_release
fi
if [[ ! -f "$RELEASE_ARCHIVE_SHA256_FILE" ]]; then
  echo "[semibot-smoke] error: release checksum file missing: $RELEASE_ARCHIVE_SHA256_FILE" >&2
  exit 1
fi

echo "[semibot-smoke] checking release launcher artifacts"
for path in \
  "$RELEASE_DIR/workspace/runtime/scripts/launch_runtime.sh" \
  "$RELEASE_DIR/workspace/runtime/scripts/launch_api.sh" \
  "$RELEASE_DIR/workspace/runtime/scripts/launch_web.sh" \
  "$RELEASE_DIR/workspace/apps/api/node_modules/express" \
  "$RELEASE_DIR/workspace/apps/web/node_modules/next"
do
  if [[ ! -e "$path" ]]; then
    rebuild_release
    break
  fi
done

echo "[semibot-smoke] checking api dist esm normalization"
if ! grep -q "import './env.js';" "$RELEASE_DIR/workspace/apps/api/dist/index.js"; then
  rebuild_release
fi

for path in \
  "$RELEASE_DIR/workspace/runtime/scripts/launch_runtime.sh" \
  "$RELEASE_DIR/workspace/runtime/scripts/launch_api.sh" \
  "$RELEASE_DIR/workspace/runtime/scripts/launch_web.sh"
do
  if [[ ! -f "$path" ]]; then
    echo "[semibot-smoke] error: missing launcher artifact after rebuild: $path" >&2
    exit 1
  fi
done

for path in \
  "$RELEASE_DIR/workspace/apps/api/node_modules/express" \
  "$RELEASE_DIR/workspace/apps/web/node_modules/next"
do
  if [[ ! -e "$path" ]]; then
    echo "[semibot-smoke] error: missing workspace node_modules artifact after rebuild: $path" >&2
    exit 1
  fi
done

if ! grep -q "import './env.js';" "$RELEASE_DIR/workspace/apps/api/dist/index.js"; then
  echo "[semibot-smoke] error: api dist index.js is not normalized for ESM imports after rebuild" >&2
  exit 1
fi

echo "[semibot-smoke] installing into $SEMIBOT_HOME"
SEMIBOT_HOME="$SEMIBOT_HOME" \
LOCAL_BIN="$LOCAL_BIN" \
AUTO_UPDATE_PROFILE=0 \
AUTO_INSTALL_NODE_PM2=0 \
AUTO_INSTALL_PNPM_DEPS=0 \
SEMIBOT_RELEASE_DIR="$RELEASE_DIR" \
SEMIBOT_INSTALL_MODE=release \
  "$ROOT_DIR/scripts/install.sh"

echo "[semibot-smoke] remote-installing release archive into $SEMIBOT_HOME-remote"
REMOTE_HOME="$TEST_ROOT/home-remote"
REMOTE_SHA256="$(checksum_value "$RELEASE_ARCHIVE_SHA256_FILE")"
SEMIBOT_HOME="$REMOTE_HOME" \
LOCAL_BIN="$LOCAL_BIN" \
AUTO_UPDATE_PROFILE=0 \
AUTO_INSTALL_NODE_PM2=0 \
AUTO_INSTALL_PNPM_DEPS=0 \
SEMIBOT_RELEASE_URL="file://$RELEASE_ARCHIVE" \
SEMIBOT_RELEASE_SHA256="$REMOTE_SHA256" \
SEMIBOT_INSTALL_MODE=remote \
  "$ROOT_DIR/scripts/install.sh"

echo "[semibot-smoke] reinstalling same release to verify idempotency"
SEMIBOT_HOME="$SEMIBOT_HOME" \
LOCAL_BIN="$LOCAL_BIN" \
AUTO_UPDATE_PROFILE=0 \
AUTO_INSTALL_NODE_PM2=0 \
AUTO_INSTALL_PNPM_DEPS=0 \
SEMIBOT_RELEASE_DIR="$RELEASE_DIR" \
SEMIBOT_INSTALL_MODE=release \
  "$ROOT_DIR/scripts/install.sh"

SEMIBOT_BIN="$LOCAL_BIN/semibot"
if [[ ! -x "$SEMIBOT_BIN" ]]; then
  echo "[semibot-smoke] error: semibot launcher not found at $SEMIBOT_BIN" >&2
  exit 1
fi

echo "[semibot-smoke] running doctor"
DOCTOR_EXIT=0
if ! SEMIBOT_HOME="$SEMIBOT_HOME" "$SEMIBOT_BIN" --json doctor >/tmp/semibot-smoke-doctor.json; then
  DOCTOR_EXIT=$?
fi

echo "[semibot-smoke] checking bootstrap artifacts"
INIT_EXIT=0
if [[ ! -f "$SEMIBOT_HOME/config/config.yaml" ]] || [[ ! -f "$SEMIBOT_HOME/env/default.env" ]]; then
  echo "[semibot-smoke] error: install bootstrap did not create config/env files" >&2
  INIT_EXIT=1
fi

echo "[semibot-smoke] running status"
STATUS_EXIT=0
if ! SEMIBOT_HOME="$SEMIBOT_HOME" "$SEMIBOT_BIN" --json status >/tmp/semibot-smoke-status.json; then
  STATUS_EXIT=$?
fi

echo "[semibot-smoke] checking local status snapshot"
if [[ ! -f "$SEMIBOT_HOME/run/service-status.json" ]]; then
  echo "[semibot-smoke] error: status did not persist a local diagnostic snapshot" >&2
  exit 1
fi

echo "[semibot-smoke] checking installed launcher definitions"
python3 - <<'PY'
import json
from pathlib import Path

status = json.loads(Path("/tmp/semibot-smoke-status.json").read_text(encoding="utf-8"))
definitions = status.get("service_definitions") or {}
expected = {
    "runtime": "launch_runtime.sh",
    "api": "launch_api.sh",
    "web": "launch_web.sh",
}
for service, script_name in expected.items():
    definition = definitions.get(service) or {}
    command = definition.get("command") or []
    if len(command) < 2 or script_name not in command[1]:
        raise SystemExit(f"installed status missing launcher command for {service}: {command}")
    if definition.get("entrypoint_kind") != "launcher":
        raise SystemExit(f"installed status missing launcher entrypoint_kind for {service}")
print("[semibot-smoke] installed launcher definitions ok")
PY

echo "[semibot-smoke] checking remote install version switch metadata"
REMOTE_BIN="$LOCAL_BIN/semibot"
if [[ ! -x "$REMOTE_BIN" ]]; then
  echo "[semibot-smoke] error: semibot launcher missing after remote install" >&2
  exit 1
fi
SEMIBOT_HOME="$REMOTE_HOME" "$REMOTE_BIN" --json status >/tmp/semibot-smoke-status-remote.json

echo "[semibot-smoke] doctor: /tmp/semibot-smoke-doctor.json"
echo "[semibot-smoke] status: /tmp/semibot-smoke-status.json"
echo "[semibot-smoke] exits: doctor=$DOCTOR_EXIT init=$INIT_EXIT status=$STATUS_EXIT"
