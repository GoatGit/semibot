#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SEMIBOT_HOME="${SEMIBOT_HOME:-$HOME/.semibot}"
RELEASE_DIR="${SEMIBOT_RELEASE_DIR:-$ROOT_DIR/.release/current}"
RELEASE_URL="${SEMIBOT_RELEASE_URL:-}"
RELEASE_MANIFEST_URL="${SEMIBOT_RELEASE_MANIFEST_URL:-https://releases.semibot.ai/stable/latest.json}"
RELEASE_SHA256="${SEMIBOT_RELEASE_SHA256:-}"
INSTALL_MODE="${SEMIBOT_INSTALL_MODE:-auto}"
DOWNLOAD_ROOT="${SEMIBOT_DOWNLOAD_ROOT:-${TMPDIR:-/tmp}/semibot-release-download}"
SEMIBOT_INIT_FORCE="${SEMIBOT_INIT_FORCE:-1}"
SEMIBOT_DEFAULT_MODEL="${SEMIBOT_DEFAULT_MODEL:-}"
SEMIBOT_RUNTIME_HOST="${SEMIBOT_RUNTIME_HOST:-}"
SEMIBOT_RUNTIME_PORT="${SEMIBOT_RUNTIME_PORT:-}"
SEMIBOT_API_PORT="${SEMIBOT_API_PORT:-}"
SEMIBOT_WEB_PORT="${SEMIBOT_WEB_PORT:-}"
SEMIBOT_OPENAI_API_KEY="${SEMIBOT_OPENAI_API_KEY:-}"
SEMIBOT_ANTHROPIC_API_KEY="${SEMIBOT_ANTHROPIC_API_KEY:-}"
SEMIBOT_UPDATE_MANIFEST_URL="${SEMIBOT_UPDATE_MANIFEST_URL:-https://releases.semibot.ai/stable/latest.json}"

sha256_file() {
  local target="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$target"
    return 0
  fi
  sha256sum "$target"
}

check_supported_platform() {
  local os_name arch_name
  os_name="$(uname -s)"
  arch_name="$(uname -m)"

  case "$os_name" in
    Darwin|Linux) ;;
    *)
      echo "[semibot-install] error: unsupported platform: $os_name (supported: macOS, Linux)" >&2
      exit 1
      ;;
  esac

  case "$arch_name" in
    x86_64|amd64|arm64|aarch64) ;;
    *)
      echo "[semibot-install] error: unsupported architecture: $arch_name (supported: x86_64, arm64)" >&2
      exit 1
      ;;
  esac
}

append_init_args() {
  if [[ "$SEMIBOT_INIT_FORCE" == "1" ]]; then
    INIT_ARGS+=("--force")
  fi
  if [[ -n "$SEMIBOT_RUNTIME_HOST" ]]; then
    INIT_ARGS+=("--runtime-host" "$SEMIBOT_RUNTIME_HOST")
  fi
  if [[ -n "$SEMIBOT_RUNTIME_PORT" ]]; then
    INIT_ARGS+=("--runtime-port" "$SEMIBOT_RUNTIME_PORT")
  fi
  if [[ -n "$SEMIBOT_API_PORT" ]]; then
    INIT_ARGS+=("--api-port" "$SEMIBOT_API_PORT")
  fi
  if [[ -n "$SEMIBOT_WEB_PORT" ]]; then
    INIT_ARGS+=("--web-port" "$SEMIBOT_WEB_PORT")
  fi
  if [[ -n "$SEMIBOT_DEFAULT_MODEL" ]]; then
    INIT_ARGS+=("--default-model" "$SEMIBOT_DEFAULT_MODEL")
  fi
  if [[ -n "$SEMIBOT_OPENAI_API_KEY" ]]; then
    INIT_ARGS+=("--openai-api-key" "$SEMIBOT_OPENAI_API_KEY")
  fi
  if [[ -n "$SEMIBOT_ANTHROPIC_API_KEY" ]]; then
    INIT_ARGS+=("--anthropic-api-key" "$SEMIBOT_ANTHROPIC_API_KEY")
  fi
  if [[ -n "$SEMIBOT_UPDATE_MANIFEST_URL" ]]; then
    INIT_ARGS+=("--update-manifest-url" "$SEMIBOT_UPDATE_MANIFEST_URL")
  fi
}

run_post_install_bootstrap() {
  local launcher="$1"
  INIT_ARGS=()

  append_init_args
  echo "[semibot-install] bootstrapping install-mode config"
  SEMIBOT_HOME="$SEMIBOT_HOME" "$launcher" --json init "${INIT_ARGS[@]}"
}

verify_release_metadata() {
  local src_release="$1"
  local manifest_file="$src_release/manifest.json"
  local build_report_file="$src_release/build-report.json"

  if [[ ! -f "$manifest_file" ]]; then
    echo "[semibot-install] error: release is missing manifest.json" >&2
    exit 1
  fi
  if [[ ! -f "$build_report_file" ]]; then
    echo "[semibot-install] error: release is missing build-report.json" >&2
    exit 1
  fi

  python3 - "$manifest_file" "$build_report_file" <<'PY'
import json
import sys
from pathlib import Path

manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
report = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))

if not report.get("ok"):
    raise SystemExit("release build report is not ok")

artifact_checks = manifest.get("artifact_checks") or {}
missing = [name for name, ok in artifact_checks.items() if not ok]
if missing:
    raise SystemExit(f"release artifact checks failed: {', '.join(missing)}")
PY
}

download_remote_release() {
  local release_url="$1"
  local expected_sha="$2"
  local temp_root archive_path extract_root discovered_release

  temp_root="$(mktemp -d "$DOWNLOAD_ROOT.XXXXXX")"
  archive_path="$temp_root/release.tar.gz"
  extract_root="$temp_root/extracted"
  mkdir -p "$extract_root"

  echo "[semibot-install] downloading release: $release_url"
  curl -fsSL "$release_url" -o "$archive_path"

  if [[ -n "$expected_sha" ]]; then
    local actual_sha
    actual_sha="$(sha256_file "$archive_path" | awk '{print $1}')"
    if [[ "$actual_sha" != "$expected_sha" ]]; then
      echo "[semibot-install] error: sha256 mismatch for downloaded release" >&2
      echo "  expected: $expected_sha" >&2
      echo "  actual  : $actual_sha" >&2
      exit 1
    fi
  fi

  tar -xzf "$archive_path" -C "$extract_root"
  discovered_release="$(find "$extract_root" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [[ -z "$discovered_release" ]]; then
    echo "[semibot-install] error: downloaded archive does not contain a release directory" >&2
    exit 1
  fi

  RELEASE_DIR="$discovered_release"
}

resolve_remote_release_manifest() {
  local manifest_url="$1"
  local temp_root manifest_path

  temp_root="$(mktemp -d "$DOWNLOAD_ROOT.manifest.XXXXXX")"
  manifest_path="$temp_root/latest.json"

  echo "[semibot-install] downloading release manifest: $manifest_url"
  curl -fsSL "$manifest_url" -o "$manifest_path"

  local manifest_payload manifest_version manifest_archive_url manifest_archive_sha
  manifest_payload="$(python3 - "$manifest_path" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
print(str(payload.get("version") or "").strip())
print(str(payload.get("archive_url") or "").strip())
print(str(payload.get("archive_sha256") or "").strip())
PY
)"

  manifest_version="$(printf '%s\n' "$manifest_payload" | sed -n '1p')"
  manifest_archive_url="$(printf '%s\n' "$manifest_payload" | sed -n '2p')"
  manifest_archive_sha="$(printf '%s\n' "$manifest_payload" | sed -n '3p')"

  if [[ -z "$manifest_archive_url" ]]; then
    echo "[semibot-install] error: release manifest does not contain archive_url" >&2
    exit 1
  fi

  RELEASE_URL="$manifest_archive_url"
  RELEASE_SHA256="${RELEASE_SHA256:-$manifest_archive_sha}"
  if [[ -n "$manifest_version" ]]; then
    VERSION="$manifest_version"
  fi
}

copy_release_workspace() {
  local src_release="$1"
  local version="$2"
  local target_release_dir="$SEMIBOT_HOME/releases/$version"
  local staging_release_dir="$SEMIBOT_HOME/releases/.staging-$version-$$"
  local backup_release_dir="$SEMIBOT_HOME/releases/.backup-$version-$$"
  local previous_target=""
  local launcher=""

  mkdir -p "$SEMIBOT_HOME/releases"
  rm -rf "$staging_release_dir" "$backup_release_dir"
  if [[ -L "$SEMIBOT_HOME/releases/current" ]]; then
    previous_target="$(readlink "$SEMIBOT_HOME/releases/current" || true)"
  fi
  mkdir -p "$staging_release_dir"

  echo "[semibot-install] copying release workspace to $staging_release_dir"
  tar -cf - -C "$src_release" . | tar -xf - -C "$staging_release_dir"

  if [[ -e "$target_release_dir" ]]; then
    echo "[semibot-install] replacing existing release: $version"
    mv "$target_release_dir" "$backup_release_dir"
  fi
  mv "$staging_release_dir" "$target_release_dir"
  ln -sfn "$version" "$SEMIBOT_HOME/releases/current"

  if [[ ! -x "$target_release_dir/workspace/runtime/scripts/install.sh" ]]; then
    echo "[semibot-install] error: release is missing workspace/runtime/scripts/install.sh" >&2
    rm -rf "$target_release_dir"
    if [[ -d "$backup_release_dir" ]]; then
      mv "$backup_release_dir" "$target_release_dir"
    fi
    if [[ -n "$previous_target" ]]; then
      ln -sfn "$previous_target" "$SEMIBOT_HOME/releases/current"
    fi
    exit 1
  fi

  if ! SEMIBOT_RELEASE_VERSION="$version" \
    "$target_release_dir/workspace/runtime/scripts/install.sh"; then
    echo "[semibot-install] error: runtime install failed, rolling back release switch" >&2
    rm -rf "$target_release_dir"
    if [[ -d "$backup_release_dir" ]]; then
      mv "$backup_release_dir" "$target_release_dir"
    fi
    if [[ -n "$previous_target" ]]; then
      ln -sfn "$previous_target" "$SEMIBOT_HOME/releases/current"
    fi
    exit 1
  fi

  launcher="$target_release_dir/workspace/runtime/scripts/semibot"
  if [[ -x "$launcher" ]]; then
    if ! run_post_install_bootstrap "$launcher"; then
      echo "[semibot-install] warning: automatic bootstrap failed; continue with semibot init"
    fi

    echo "[semibot-install] running first doctor check"
    if ! SEMIBOT_HOME="$SEMIBOT_HOME" "$launcher" --json doctor; then
      echo "[semibot-install] doctor reported issues; continue with semibot ui after reviewing output"
    fi
  fi

  rm -rf "$backup_release_dir"

  echo "[semibot-install] next:"
  echo "  semibot ui"
}

resolve_release_version() {
  local src_release="$1"
  if [[ -f "$src_release/manifest.json" ]]; then
    python3 - "$src_release/manifest.json" <<'PY'
import json
import sys
from pathlib import Path
manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
print(manifest.get("version") or "local")
PY
    return 0
  fi
  basename "$src_release"
}

if [[ "$INSTALL_MODE" == "remote" ]] || [[ "$INSTALL_MODE" == "auto" && ( -n "$RELEASE_URL" || -n "$RELEASE_MANIFEST_URL" ) ]]; then
  check_supported_platform
  if [[ -n "$RELEASE_MANIFEST_URL" ]]; then
    resolve_remote_release_manifest "$RELEASE_MANIFEST_URL"
  fi
  download_remote_release "$RELEASE_URL" "$RELEASE_SHA256"
  VERSION="$(resolve_release_version "$RELEASE_DIR")"
  echo "[semibot-install] mode: remote-release"
  echo "[semibot-install] release: $RELEASE_DIR"
  verify_release_metadata "$RELEASE_DIR"
  copy_release_workspace "$RELEASE_DIR" "$VERSION"
  exit 0
fi

if [[ "$INSTALL_MODE" == "release" ]] || [[ "$INSTALL_MODE" == "auto" && -d "$RELEASE_DIR" ]]; then
  VERSION="$(resolve_release_version "$RELEASE_DIR")"
  check_supported_platform
  echo "[semibot-install] mode: release"
  echo "[semibot-install] release: $RELEASE_DIR"
  verify_release_metadata "$RELEASE_DIR"
  copy_release_workspace "$RELEASE_DIR" "$VERSION"
  exit 0
fi

check_supported_platform
echo "[semibot-install] mode: workspace"
exec "$ROOT_DIR/runtime/scripts/install.sh"
