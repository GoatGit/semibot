#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_ROOT="${OUTPUT_ROOT:-$ROOT_DIR/.release}"
VERSION="${VERSION:-$(python3 "$ROOT_DIR/scripts/resolve_release_version.py" "$OUTPUT_ROOT")}"
RELEASE_DIR="$OUTPUT_ROOT/$VERSION"
WORKSPACE_DIR="$RELEASE_DIR/workspace"
ARCHIVE_NAME="semibot-${VERSION}.tar.gz"
ARCHIVE_PATH="$OUTPUT_ROOT/$ARCHIVE_NAME"
CHECKSUM_PATH="$OUTPUT_ROOT/${ARCHIVE_NAME}.sha256"
LATEST_MANIFEST_PATH="$OUTPUT_ROOT/latest.json"
SKIP_BUILD="${SKIP_BUILD:-0}"
INCLUDE_NODE_MODULES="${INCLUDE_NODE_MODULES:-1}"
INCLUDE_RUNTIME_VENV="${INCLUDE_RUNTIME_VENV:-1}"
RELEASE_CHANNEL="${RELEASE_CHANNEL:-stable}"
RELEASE_BASE_URL="${RELEASE_BASE_URL:-https://releases.semibot.ai/stable}"
RELEASE_NOTES_URL="${RELEASE_NOTES_URL:-}"
WORKSPACE_INCLUDE=(
  "package.json"
  "pnpm-lock.yaml"
  "pnpm-workspace.yaml"
  "turbo.json"
  "apps"
  "packages"
  "runtime"
)

sha256_file() {
  local target="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$target"
    return 0
  fi
  sha256sum "$target"
}

if [[ "$INCLUDE_NODE_MODULES" == "1" && -d "$ROOT_DIR/node_modules" ]]; then
  WORKSPACE_INCLUDE+=("node_modules")
fi

if [[ "$INCLUDE_RUNTIME_VENV" == "1" && -d "$ROOT_DIR/runtime/.venv" ]]; then
  WORKSPACE_INCLUDE+=("runtime/.venv")
fi

echo "[semibot-release] root: $ROOT_DIR"
echo "[semibot-release] version: $VERSION"
echo "[semibot-release] output: $RELEASE_DIR"

mkdir -p "$OUTPUT_ROOT"
rm -rf "$RELEASE_DIR"
mkdir -p "$WORKSPACE_DIR"

if [[ "$SKIP_BUILD" != "1" ]]; then
  echo "[semibot-release] installing workspace dependencies"
  CI=1 pnpm install --frozen-lockfile --dir "$ROOT_DIR"
  echo "[semibot-release] building workspace"
  pnpm --dir "$ROOT_DIR" build
fi

if [[ -d "$ROOT_DIR/apps/api/dist" ]]; then
  echo "[semibot-release] normalizing API dist ESM imports"
  node "$ROOT_DIR/scripts/fix_api_dist_esm.mjs" "$ROOT_DIR/apps/api/dist"
fi

echo "[semibot-release] copying workspace snapshot"
tar \
  --exclude='.git' \
  --exclude='.release' \
  --exclude='runtime/.semibot' \
  --exclude='runtime/.install-last.log' \
  --exclude='runtime/.pytest_cache' \
  --exclude='runtime/test-results' \
  --exclude='runtime/workspaces' \
  --exclude='apps/*/coverage' \
  --exclude='**/__pycache__' \
  --exclude='.turbo' \
  -cf - -C "$ROOT_DIR" "${WORKSPACE_INCLUDE[@]}" | tar -xf - -C "$WORKSPACE_DIR"

RELEASE_DIR_ENV="$RELEASE_DIR" VERSION_ENV="$VERSION" ROOT_DIR_ENV="$ROOT_DIR" INCLUDE_NODE_MODULES_ENV="$INCLUDE_NODE_MODULES" INCLUDE_RUNTIME_VENV_ENV="$INCLUDE_RUNTIME_VENV" python3 - <<'PY'
import json
import os
import shutil
import subprocess
from datetime import datetime, UTC
from pathlib import Path

release_dir = Path(os.environ["RELEASE_DIR_ENV"])
workspace_dir = release_dir / "workspace"
include_node_modules = os.environ.get("INCLUDE_NODE_MODULES_ENV") == "1"
include_runtime_venv = os.environ.get("INCLUDE_RUNTIME_VENV_ENV") == "1"


def normalize_absolute_symlinks(root: Path) -> list[str]:
    rewritten: list[str] = []
    if not root.exists():
        return rewritten
    for path in root.rglob("*"):
        if not path.is_symlink():
            continue
        target = os.readlink(path)
        if not os.path.isabs(target):
            continue
        source = Path(target)
        if not source.exists():
            raise RuntimeError(f"bundled virtualenv contains broken absolute symlink: {path} -> {target}")
        path.unlink()
        if source.is_dir():
            shutil.copytree(source, path, symlinks=False)
        else:
            shutil.copy2(source, path)
        rewritten.append(str(path.relative_to(workspace_dir)))
    return rewritten


normalized_runtime_venv_links = normalize_absolute_symlinks(workspace_dir / "runtime" / ".venv")
web_vendor_chunks_dir = workspace_dir / "apps" / "web" / ".next" / "server" / "vendor-chunks"


def has_files(root: Path) -> bool:
    return root.exists() and any(path.is_file() for path in root.iterdir())


artifacts = {
    "runtime_entry": workspace_dir / "runtime" / "main.py",
    "runtime_launcher": workspace_dir / "runtime" / "scripts" / "semibot",
    "runtime_service_launcher": workspace_dir / "runtime" / "scripts" / "launch_runtime.sh",
    "api_launcher": workspace_dir / "runtime" / "scripts" / "launch_api.sh",
    "web_launcher": workspace_dir / "runtime" / "scripts" / "launch_web.sh",
    "runtime_venv_python": workspace_dir / "runtime" / ".venv" / "bin" / "python",
    "api_entry": workspace_dir / "apps" / "api" / "dist" / "index.js",
    "api_node_modules": workspace_dir / "apps" / "api" / "node_modules",
    "web_build_manifest": workspace_dir / "apps" / "web" / ".next" / "build-manifest.json",
    "web_node_modules": workspace_dir / "apps" / "web" / "node_modules",
    "root_package": workspace_dir / "package.json",
    "pnpm_lock": workspace_dir / "pnpm-lock.yaml",
}
required_artifacts = {
    "runtime_entry": True,
    "runtime_launcher": True,
    "runtime_service_launcher": True,
    "api_launcher": True,
    "web_launcher": True,
    "runtime_venv_python": include_runtime_venv,
    "api_entry": True,
    "api_node_modules": include_node_modules,
    "web_build_manifest": True,
    "web_node_modules": include_node_modules,
    "root_package": True,
    "pnpm_lock": True,
    "web_vendor_chunks_nonempty": True,
}
artifact_checks = {key: value.exists() for key, value in artifacts.items()}
artifact_checks["web_vendor_chunks_nonempty"] = has_files(web_vendor_chunks_dir)
manifest = {
    "version": os.environ["VERSION_ENV"],
    "built_at": datetime.now(UTC).isoformat(),
    "workspace_dir": "workspace",
    "git_commit": None,
    "normalized_runtime_venv_links": normalized_runtime_venv_links,
    "artifacts": {key: str(value.relative_to(release_dir)) for key, value in artifacts.items()},
    "artifact_checks": artifact_checks,
    "artifact_required": required_artifacts,
    "artifact_details": {
        "web_vendor_chunks_dir": str(web_vendor_chunks_dir.relative_to(release_dir)),
        "web_vendor_chunks_count": sum(1 for path in web_vendor_chunks_dir.iterdir() if path.is_file()) if web_vendor_chunks_dir.exists() else 0,
    },
}
try:
    manifest["git_commit"] = subprocess.check_output(
        ["git", "-C", os.environ["ROOT_DIR_ENV"], "rev-parse", "HEAD"],
        text=True,
        stderr=subprocess.DEVNULL,
    ).strip()
except Exception:
    manifest["git_commit"] = None

(release_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
(release_dir / "build-report.json").write_text(json.dumps({
    "version": manifest["version"],
    "artifact_checks": manifest["artifact_checks"],
    "artifact_required": manifest["artifact_required"],
    "ok": all(
        manifest["artifact_checks"].get(key, False)
        for key, required in manifest["artifact_required"].items()
        if required
    ),
}, indent=2) + "\n", encoding="utf-8")
PY

echo "[semibot-release] packaging release archive"
rm -f "$ARCHIVE_PATH" "$CHECKSUM_PATH"
tar -czf "$ARCHIVE_PATH" -C "$OUTPUT_ROOT" "$VERSION"
sha256_file "$ARCHIVE_PATH" > "$CHECKSUM_PATH"
ARCHIVE_SHA256="$(awk '{print $1}' "$CHECKSUM_PATH")"

RELEASE_DIR_ENV="$RELEASE_DIR" VERSION_ENV="$VERSION" ROOT_DIR_ENV="$ROOT_DIR" ARCHIVE_NAME_ENV="$ARCHIVE_NAME" ARCHIVE_SHA_ENV="$ARCHIVE_SHA256" RELEASE_CHANNEL_ENV="$RELEASE_CHANNEL" RELEASE_BASE_URL_ENV="$RELEASE_BASE_URL" RELEASE_NOTES_URL_ENV="$RELEASE_NOTES_URL" LATEST_MANIFEST_ENV="$LATEST_MANIFEST_PATH" python3 - <<'PY'
import json
import os
from pathlib import Path

release_dir = Path(os.environ["RELEASE_DIR_ENV"])
manifest = json.loads((release_dir / "manifest.json").read_text(encoding="utf-8"))
base_url = str(os.environ.get("RELEASE_BASE_URL_ENV") or "").rstrip("/")
archive_name = os.environ["ARCHIVE_NAME_ENV"]

payload = {
    "channel": os.environ["RELEASE_CHANNEL_ENV"],
    "version": os.environ["VERSION_ENV"],
    "published_at": manifest.get("built_at"),
    "git_commit": manifest.get("git_commit"),
    "archive_name": archive_name,
    "archive_sha256": os.environ["ARCHIVE_SHA_ENV"],
    "archive_url": f"{base_url}/{archive_name}" if base_url else None,
    "release_notes_url": os.environ.get("RELEASE_NOTES_URL_ENV") or None,
}
Path(os.environ["LATEST_MANIFEST_ENV"]).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

ln -sfn "$VERSION" "$OUTPUT_ROOT/current"

echo "[semibot-release] manifest: $RELEASE_DIR/manifest.json"
echo "[semibot-release] build report: $RELEASE_DIR/build-report.json"
echo "[semibot-release] archive: $ARCHIVE_PATH"
echo "[semibot-release] checksum: $CHECKSUM_PATH"
echo "[semibot-release] latest manifest: $LATEST_MANIFEST_PATH"
echo "[semibot-release] current -> $VERSION"
