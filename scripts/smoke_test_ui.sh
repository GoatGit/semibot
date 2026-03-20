#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="${TEST_ROOT:-$(mktemp -d /tmp/semibot-ui-smoke.XXXXXX)}"
SEMIBOT_HOME="$TEST_ROOT/home"
LOCAL_BIN="$TEST_ROOT/bin"
RELEASE_DIR="${SEMIBOT_RELEASE_DIR:-$ROOT_DIR/.release/current}"
UI_TIMEOUT="${SEMIBOT_UI_HEALTH_TIMEOUT:-45}"
USE_PLAYWRIGHT="${SEMIBOT_UI_SMOKE_PLAYWRIGHT:-0}"

cleanup() {
  if [[ "${KEEP_TEST_ROOT:-0}" != "1" ]]; then
    rm -rf "$TEST_ROOT"
  else
    echo "[semibot-ui-smoke] kept test root: $TEST_ROOT"
  fi
}
trap cleanup EXIT

echo "[semibot-ui-smoke] installing release into $SEMIBOT_HOME"
SEMIBOT_HOME="$SEMIBOT_HOME" \
LOCAL_BIN="$LOCAL_BIN" \
AUTO_UPDATE_PROFILE=0 \
AUTO_INSTALL_NODE_PM2=0 \
AUTO_INSTALL_PNPM_DEPS=0 \
SEMIBOT_RELEASE_DIR="$RELEASE_DIR" \
SEMIBOT_INSTALL_MODE=release \
  "$ROOT_DIR/scripts/install.sh" >/tmp/semibot-ui-smoke-install.log 2>&1

SEMIBOT_BIN="$LOCAL_BIN/semibot"
if [[ ! -x "$SEMIBOT_BIN" ]]; then
  echo "[semibot-ui-smoke] error: semibot launcher not found at $SEMIBOT_BIN" >&2
  exit 1
fi

echo "[semibot-ui-smoke] running semibot ui --no-open"
UI_EXIT=0
if ! SEMIBOT_HOME="$SEMIBOT_HOME" "$SEMIBOT_BIN" --json ui --no-open --health-timeout "$UI_TIMEOUT" >/tmp/semibot-ui-smoke-ui.json 2>&1; then
  UI_EXIT=$?
fi

python3 - <<'PY'
import json
from pathlib import Path

path = Path("/tmp/semibot-ui-smoke-ui.json")
text = path.read_text(encoding="utf-8") if path.exists() else ""
text = text.strip()
payload = None
if text.startswith("{"):
    payload = json.loads(text)

if payload and payload.get("ok"):
    raise SystemExit(0)

message = ""
if payload:
    message = str((payload.get("error") or {}).get("message") or "")
elif text:
    message = text
normalized = message.lower()
if "operation not permitted" in normalized or "permission denied" in normalized:
    print("[semibot-ui-smoke] skipped ui launch verification due to restricted local port binding")
    raise SystemExit(0)
raise SystemExit(1)
PY

if [[ "$UI_EXIT" -ne 0 ]] && ! grep -qiE "operation not permitted|permission denied" /tmp/semibot-ui-smoke-ui.json; then
  echo "[semibot-ui-smoke] error: semibot ui failed" >&2
  cat /tmp/semibot-ui-smoke-ui.json >&2
  exit "$UI_EXIT"
fi

if grep -qiE "operation not permitted|permission denied" /tmp/semibot-ui-smoke-ui.json; then
  echo "[semibot-ui-smoke] ui verification skipped after restricted bind failure"
  exit 0
fi

echo "[semibot-ui-smoke] probing http://127.0.0.1:3000"
curl -fsS "http://127.0.0.1:3000" >/tmp/semibot-ui-smoke-index.html
if ! grep -qi "<!doctype html" /tmp/semibot-ui-smoke-index.html; then
  echo "[semibot-ui-smoke] error: ui home did not return an HTML document" >&2
  exit 1
fi

if [[ "$USE_PLAYWRIGHT" == "1" ]]; then
  echo "[semibot-ui-smoke] running playwright acceptance"
  (
    cd "$ROOT_DIR"
    NEXT_PUBLIC_APP_URL="http://127.0.0.1:3000" \
    PW_DISABLE_WEBSERVER=1 \
    RUN_LIVE_E2E=1 \
    pnpm -C tests run test:e2e:live:one-click-ui
  )
fi

echo "[semibot-ui-smoke] ui smoke passed"
