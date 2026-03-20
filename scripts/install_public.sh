#!/usr/bin/env bash
set -euo pipefail

SEMIBOT_HOME="${SEMIBOT_HOME:-$HOME/.semibot}"
LOCAL_BIN="${LOCAL_BIN:-$HOME/.local/bin}"
SEMIBOT_RELEASE_MANIFEST_URL="${SEMIBOT_RELEASE_MANIFEST_URL:-https://releases.semibot.ai/stable/latest.json}"
SEMIBOT_RELEASE_URL="${SEMIBOT_RELEASE_URL:-}"
SEMIBOT_RELEASE_SHA256="${SEMIBOT_RELEASE_SHA256:-}"
SEMIBOT_UPDATE_MANIFEST_URL="${SEMIBOT_UPDATE_MANIFEST_URL:-https://releases.semibot.ai/stable/latest.json}"
SEMIBOT_INIT_FORCE="${SEMIBOT_INIT_FORCE:-1}"
SEMIBOT_DEFAULT_MODEL="${SEMIBOT_DEFAULT_MODEL:-}"
SEMIBOT_RUNTIME_HOST="${SEMIBOT_RUNTIME_HOST:-}"
SEMIBOT_RUNTIME_PORT="${SEMIBOT_RUNTIME_PORT:-}"
SEMIBOT_API_PORT="${SEMIBOT_API_PORT:-}"
SEMIBOT_WEB_PORT="${SEMIBOT_WEB_PORT:-}"
SEMIBOT_OPENAI_API_KEY="${SEMIBOT_OPENAI_API_KEY:-}"
SEMIBOT_ANTHROPIC_API_KEY="${SEMIBOT_ANTHROPIC_API_KEY:-}"
DOWNLOAD_ROOT="${SEMIBOT_DOWNLOAD_ROOT:-${TMPDIR:-/tmp}/semibot-install-public}"

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
  INIT_ARGS=()
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

resolve_release_from_manifest() {
  local manifest_url="$1"
  local temp_root manifest_file payload

  temp_root="$(mktemp -d "$DOWNLOAD_ROOT.manifest.XXXXXX")"
  manifest_file="$temp_root/latest.json"

  echo "[semibot-install] downloading release manifest: $manifest_url"
  curl -fsSL "$manifest_url" -o "$manifest_file"

  payload="$(python3 - "$manifest_file" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
print(str(payload.get("version") or "").strip())
print(str(payload.get("archive_url") or "").strip())
print(str(payload.get("archive_sha256") or "").strip())
PY
)"

  RESOLVED_VERSION="$(printf '%s\n' "$payload" | sed -n '1p')"
  SEMIBOT_RELEASE_URL="$(printf '%s\n' "$payload" | sed -n '2p')"
  if [[ -z "$SEMIBOT_RELEASE_SHA256" ]]; then
    SEMIBOT_RELEASE_SHA256="$(printf '%s\n' "$payload" | sed -n '3p')"
  fi

  if [[ -z "$SEMIBOT_RELEASE_URL" ]]; then
    echo "[semibot-install] error: release manifest does not contain archive_url" >&2
    exit 1
  fi
}

download_release_archive() {
  local release_url="$1"
  local expected_sha="$2"
  local temp_root archive_path extract_root discovered_release

  temp_root="$(mktemp -d "$DOWNLOAD_ROOT.release.XXXXXX")"
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

copy_release_and_install() {
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
    LOCAL_BIN="$LOCAL_BIN" \
    AUTO_UPDATE_PROFILE="${AUTO_UPDATE_PROFILE:-1}" \
    AUTO_INSTALL_NODE_PM2="${AUTO_INSTALL_NODE_PM2:-0}" \
    AUTO_INSTALL_PNPM_DEPS="${AUTO_INSTALL_PNPM_DEPS:-0}" \
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
    append_init_args
    echo "[semibot-install] bootstrapping install-mode config"
    if ! SEMIBOT_HOME="$SEMIBOT_HOME" "$launcher" --json init "${INIT_ARGS[@]}"; then
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

main() {
  check_supported_platform

  if [[ -z "$SEMIBOT_RELEASE_URL" ]]; then
    resolve_release_from_manifest "$SEMIBOT_RELEASE_MANIFEST_URL"
  fi

  download_release_archive "$SEMIBOT_RELEASE_URL" "$SEMIBOT_RELEASE_SHA256"

  if [[ -z "${RESOLVED_VERSION:-}" ]]; then
    RESOLVED_VERSION="$(python3 - "$RELEASE_DIR/manifest.json" <<'PY'
import json
import sys
from pathlib import Path
print(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")).get("version") or "local")
PY
)"
  fi

  copy_release_and_install "$RELEASE_DIR" "$RESOLVED_VERSION"
}

main "$@"
