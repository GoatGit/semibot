#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_ROOT="${OUTPUT_ROOT:-$ROOT_DIR/.release}"
CHANNEL="${1:-stable}"
PUBLISH_ROOT="${2:-$OUTPUT_ROOT/publish}"
LATEST_MANIFEST="${OUTPUT_ROOT}/latest.json"
PUBLIC_INSTALLER_SOURCE="${ROOT_DIR}/scripts/install_public.sh"

if [[ ! -f "$LATEST_MANIFEST" ]]; then
  echo "[semibot-channel] error: latest manifest not found: $LATEST_MANIFEST" >&2
  exit 1
fi

release_payload="$(python3 - "$LATEST_MANIFEST" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
print(str(payload.get("version") or "").strip())
print(str(payload.get("archive_name") or "").strip())
PY
)"

VERSION="$(printf '%s\n' "$release_payload" | sed -n '1p')"
ARCHIVE_NAME="$(printf '%s\n' "$release_payload" | sed -n '2p')"

if [[ -z "$VERSION" || -z "$ARCHIVE_NAME" ]]; then
  echo "[semibot-channel] error: latest manifest missing version or archive_name" >&2
  exit 1
fi

ARCHIVE_PATH="${OUTPUT_ROOT}/${ARCHIVE_NAME}"
CHECKSUM_PATH="${ARCHIVE_PATH}.sha256"
CHANNEL_DIR="${PUBLISH_ROOT}/${CHANNEL}"
ROOT_INSTALLER_TARGET="${PUBLISH_ROOT}/install.sh"

if [[ ! -f "$ARCHIVE_PATH" ]]; then
  echo "[semibot-channel] error: release archive not found: $ARCHIVE_PATH" >&2
  exit 1
fi
if [[ ! -f "$CHECKSUM_PATH" ]]; then
  echo "[semibot-channel] error: release checksum not found: $CHECKSUM_PATH" >&2
  exit 1
fi

rm -rf "$CHANNEL_DIR"
mkdir -p "$CHANNEL_DIR"
cp "$LATEST_MANIFEST" "$CHANNEL_DIR/latest.json"
cp "$ARCHIVE_PATH" "$CHANNEL_DIR/$ARCHIVE_NAME"
cp "$CHECKSUM_PATH" "$CHANNEL_DIR/${ARCHIVE_NAME}.sha256"
cp "$PUBLIC_INSTALLER_SOURCE" "$ROOT_INSTALLER_TARGET"
chmod +x "$ROOT_INSTALLER_TARGET"

echo "[semibot-channel] channel: $CHANNEL"
echo "[semibot-channel] version: $VERSION"
echo "[semibot-channel] output: $CHANNEL_DIR"
echo "[semibot-channel] installer: $ROOT_INSTALLER_TARGET"
