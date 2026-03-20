#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INCLUDE_NODE_MODULES="${INCLUDE_NODE_MODULES:-1}"
INCLUDE_RUNTIME_VENV="${INCLUDE_RUNTIME_VENV:-1}"
SKIP_BUILD="${SKIP_BUILD:-0}"

echo "[semibot-release-ci] build release"
SKIP_BUILD="$SKIP_BUILD" \
INCLUDE_NODE_MODULES="$INCLUDE_NODE_MODULES" \
INCLUDE_RUNTIME_VENV="$INCLUDE_RUNTIME_VENV" \
  "$ROOT_DIR/scripts/build_release.sh"

echo "[semibot-release-ci] smoke install"
"$ROOT_DIR/scripts/smoke_test_install.sh"

echo "[semibot-release-ci] smoke failures"
"$ROOT_DIR/scripts/smoke_test_failures.sh"

echo "[semibot-release-ci] smoke ui"
"$ROOT_DIR/scripts/smoke_test_ui.sh"

echo "[semibot-release-ci] done"
