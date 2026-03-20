#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="${TEST_ROOT:-$(mktemp -d /tmp/semibot-failure-smoke.XXXXXX)}"
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

cleanup() {
  if [[ "${KEEP_TEST_ROOT:-0}" != "1" ]]; then
    rm -rf "$TEST_ROOT"
  else
    echo "[semibot-failure-smoke] kept test root: $TEST_ROOT"
  fi
}
trap cleanup EXIT

echo "[semibot-failure-smoke] installing baseline release"
SEMIBOT_HOME="$SEMIBOT_HOME" \
LOCAL_BIN="$LOCAL_BIN" \
AUTO_UPDATE_PROFILE=0 \
AUTO_INSTALL_NODE_PM2=0 \
AUTO_INSTALL_PNPM_DEPS=0 \
SEMIBOT_RELEASE_DIR="$RELEASE_DIR" \
SEMIBOT_INSTALL_MODE=release \
  "$ROOT_DIR/scripts/install.sh" >/tmp/semibot-failure-install.log 2>&1

SEMIBOT_BIN="$LOCAL_BIN/semibot"

echo "[semibot-failure-smoke] checking checksum failure"
if SEMIBOT_HOME="$TEST_ROOT/remote-home" \
  LOCAL_BIN="$LOCAL_BIN" \
  AUTO_UPDATE_PROFILE=0 \
  AUTO_INSTALL_NODE_PM2=0 \
  AUTO_INSTALL_PNPM_DEPS=0 \
  SEMIBOT_RELEASE_URL="file://$RELEASE_ARCHIVE" \
  SEMIBOT_RELEASE_SHA256="badsha256" \
  SEMIBOT_INSTALL_MODE=remote \
  "$ROOT_DIR/scripts/install.sh" >/tmp/semibot-failure-checksum.log 2>&1; then
  echo "[semibot-failure-smoke] error: remote install unexpectedly succeeded with bad checksum" >&2
  exit 1
fi
grep -qi "sha256 mismatch" /tmp/semibot-failure-checksum.log

echo "[semibot-failure-smoke] checking corrupted config handling"
mkdir -p "$SEMIBOT_HOME/config"
printf 'runtime: [\n' > "$SEMIBOT_HOME/config/config.yaml"
if SEMIBOT_HOME="$SEMIBOT_HOME" "$SEMIBOT_BIN" --json status >/tmp/semibot-failure-status.log 2>&1; then
  :
fi
grep -qiE "error|status" /tmp/semibot-failure-status.log

echo "[semibot-failure-smoke] checking missing node diagnostics"
if PATH="/usr/bin:/bin:/usr/sbin:/sbin" SEMIBOT_HOME="$SEMIBOT_HOME" "$SEMIBOT_BIN" --json doctor >/tmp/semibot-failure-doctor-node.json 2>&1; then
  :
fi
python3 - <<'PY'
import json
from pathlib import Path

payload = json.loads(Path("/tmp/semibot-failure-doctor-node.json").read_text(encoding="utf-8"))
checks = payload.get("dependency_checks") or {}
if checks.get("node_available", True):
    raise SystemExit("node_available should be false when PATH hides node")
print("[semibot-failure-smoke] missing node diagnostics ok")
PY

echo "[semibot-failure-smoke] failure smoke passed"
