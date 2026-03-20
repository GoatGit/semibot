#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
VENV_DIR="${VENV_DIR:-$ROOT_DIR/.venv}"
VENV_PY="$VENV_DIR/bin/python"
LOCAL_BIN="${LOCAL_BIN:-$HOME/.local/bin}"
AUTO_UPDATE_PROFILE="${AUTO_UPDATE_PROFILE:-1}"
AUTO_INSTALL_NODE_PM2="${AUTO_INSTALL_NODE_PM2:-1}"
AUTO_INSTALL_PNPM_DEPS="${AUTO_INSTALL_PNPM_DEPS:-1}"
ACTIVE_PATH_TARGET=""
INSTALL_LOG="$ROOT_DIR/.install-last.log"

python_meets_min_version() {
  local py_bin="$1"
  "$py_bin" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1
}

bundled_runtime_ready() {
  if [ ! -x "$VENV_PY" ]; then
    return 1
  fi
  "$VENV_PY" -c "import uvicorn, hatchling" >/dev/null 2>&1
}

select_python311_with_brew() {
  local brew_prefix=""
  local candidate=""

  if ! command -v brew >/dev/null 2>&1; then
    return 1
  fi

  echo "[semibot] detected Python < 3.11, trying: brew install python@3.11"
  if ! brew install python@3.11; then
    return 1
  fi

  brew_prefix="$(brew --prefix python@3.11 2>/dev/null || true)"
  for candidate in \
    "$brew_prefix/bin/python3.11" \
    "$(command -v python3.11 2>/dev/null || true)" \
    "$brew_prefix/bin/python3" \
    "$(command -v python3 2>/dev/null || true)"
  do
    if [ -n "$candidate" ] && [ -x "$candidate" ] && python_meets_min_version "$candidate"; then
      PYTHON_BIN="$candidate"
      echo "[semibot] switched python to: $PYTHON_BIN"
      return 0
    fi
  done

  return 1
}

detect_shell_profile() {
  local shell_name
  shell_name="$(basename "${SHELL:-}")"
  if [ "$shell_name" = "zsh" ] || [ -n "${ZSH_VERSION:-}" ]; then
    echo "$HOME/.zshrc"
    return 0
  fi
  if [ "$shell_name" = "bash" ] || [ -n "${BASH_VERSION:-}" ]; then
    if [ -f "$HOME/.bashrc" ]; then
      echo "$HOME/.bashrc"
      return 0
    fi
    if [ -f "$HOME/.bash_profile" ]; then
      echo "$HOME/.bash_profile"
      return 0
    fi
    echo "$HOME/.bashrc"
    return 0
  fi
  echo "$HOME/.profile"
  return 0
}

ensure_path_in_profile() {
  local target_dir="$1"
  local profile_file
  local line

  if [ "$AUTO_UPDATE_PROFILE" != "1" ]; then
    return 0
  fi

  profile_file="$(detect_shell_profile)"
  line="export PATH=\"$target_dir:\$PATH\""

  mkdir -p "$(dirname "$profile_file")" 2>/dev/null || true
  touch "$profile_file" 2>/dev/null || {
    echo "[semibot] warning: cannot write shell profile: $profile_file"
    return 0
  }

  if grep -F "$target_dir" "$profile_file" >/dev/null 2>&1; then
    echo "[semibot] PATH already contains $target_dir in $profile_file"
    return 0
  fi

  {
    echo ""
    echo "# Semibot CLI path"
    echo "$line"
  } >>"$profile_file"

  echo "[semibot] updated $profile_file"
  echo "[semibot] run: source \"$profile_file\""
}

ensure_path_in_current_shell_if_sourced() {
  local target_dir="$1"
  if [ -z "$target_dir" ]; then
    return 0
  fi
  # Only possible when script is sourced (not executed).
  if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
    case ":$PATH:" in
      *":$target_dir:"*) ;;
      *) export PATH="$target_dir:$PATH" ;;
    esac
    echo "[semibot] PATH applied to current shell (sourced mode): $target_dir"
  fi
}

link_global_launcher() {
  if mkdir -p "$LOCAL_BIN" 2>/dev/null && ln -sf "$ROOT_DIR/scripts/semibot" "$LOCAL_BIN/semibot" 2>/dev/null; then
    echo "[semibot] linked: $LOCAL_BIN/semibot -> $ROOT_DIR/scripts/semibot"
    return 0
  fi
  return 1
}

warn_legacy_runtime_scripts_path() {
  local profile_file
  profile_file="$(detect_shell_profile)"
  if [ -f "$profile_file" ] && grep -F "/semibot/runtime/scripts" "$profile_file" >/dev/null 2>&1; then
    echo "[semibot] note: detected legacy PATH entries for */runtime/scripts in $profile_file"
    echo "[semibot] note: with multiple worktrees, prefer using $LOCAL_BIN/semibot as the single entrypoint"
  fi
}

ensure_node_tooling() {
  local npm_global_prefix=""
  local npm_global_bin=""

  if [ "$AUTO_INSTALL_NODE_PM2" != "1" ]; then
    echo "[semibot] skip Node/npm auto install (AUTO_INSTALL_NODE_PM2=$AUTO_INSTALL_NODE_PM2)"
    return 0
  fi

  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "[semibot] node/npm not found"
    if [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
      echo "[semibot] trying: brew install node"
      if ! brew install node; then
        echo "[semibot] warning: brew install node failed; please install Node.js manually"
        return 0
      fi
    else
      echo "[semibot] warning: please install Node.js (includes npm) manually, then rerun install.sh"
      return 0
    fi
  fi

  npm_global_prefix="$(npm prefix -g 2>/dev/null || true)"
  npm_global_bin="$npm_global_prefix/bin"
  if [ -n "$npm_global_bin" ] && [ -d "$npm_global_bin" ]; then
    ensure_path_in_profile "$npm_global_bin"
    ensure_path_in_current_shell_if_sourced "$npm_global_bin"
  fi
}

ensure_pnpm_and_workspace_dependencies() {
  local project_root=""

  if [ "$AUTO_INSTALL_PNPM_DEPS" != "1" ]; then
    echo "[semibot] skip pnpm dependency install (AUTO_INSTALL_PNPM_DEPS=$AUTO_INSTALL_PNPM_DEPS)"
    return 0
  fi

  project_root="$(cd "$ROOT_DIR/.." && pwd)"
  if [ ! -f "$project_root/package.json" ] || [ ! -f "$project_root/pnpm-lock.yaml" ]; then
    echo "[semibot] skip pnpm dependency install (workspace files not found)"
    return 0
  fi

  if [ -d "$project_root/node_modules" ] && [ -f "$project_root/apps/api/dist/index.js" ] && [ -f "$project_root/apps/web/.next/BUILD_ID" ]; then
    echo "[semibot] detected bundled node_modules and build artifacts, skip pnpm install"
    return 0
  fi

  if ! command -v pnpm >/dev/null 2>&1; then
    if command -v npm >/dev/null 2>&1; then
      echo "[semibot] pnpm not found, trying: npm install -g pnpm"
      if ! npm install -g pnpm; then
        echo "[semibot] warning: failed to install pnpm globally"
        return 0
      fi
    else
      echo "[semibot] warning: npm not found, cannot install pnpm/workspace dependencies"
      return 0
    fi
  fi

  echo "[semibot] installing workspace dependencies with pnpm (non-interactive)"
  if CI=1 pnpm install --frozen-lockfile --dir "$project_root"; then
    echo "[semibot] workspace dependencies installed (frozen lockfile)"
  elif CI=1 pnpm install --dir "$project_root"; then
    echo "[semibot] workspace dependencies installed"
  else
    echo "[semibot] warning: pnpm install failed; UI/API may fail to start until dependencies are installed"
    return 0
  fi

  echo "[semibot] building workspace (pnpm build)"
  if pnpm --dir "$project_root" build; then
    echo "[semibot] workspace build succeeded"
  else
    echo "[semibot] warning: pnpm build failed; UI/API may not work correctly"
  fi
}

echo "[semibot] root: $ROOT_DIR"
echo "[semibot] python: $PYTHON_BIN"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "[semibot] error: python executable not found: $PYTHON_BIN" >&2
  exit 1
fi

if ! python_meets_min_version "$PYTHON_BIN"; then
  current_py_version="$("$PYTHON_BIN" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")' 2>/dev/null || echo "unknown")"
  echo "[semibot] python version is $current_py_version, but semibot requires >= 3.11"
  if [ "$(uname -s)" = "Darwin" ] && select_python311_with_brew; then
    :
  else
    echo "[semibot] error: please install Python 3.11+ and rerun this script"
    echo "[semibot] macOS quick fix: brew install python@3.11"
    exit 1
  fi
fi

echo "[semibot] using python: $PYTHON_BIN"

if [ -x "$VENV_PY" ] && ! python_meets_min_version "$VENV_PY"; then
  echo "[semibot] existing virtualenv uses Python < 3.11, recreating: $VENV_DIR"
  rm -rf "$VENV_DIR"
fi

if [ ! -x "$VENV_PY" ]; then
  echo "[semibot] creating virtualenv at $VENV_DIR"
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

if bundled_runtime_ready; then
  echo "[semibot] detected bundled runtime virtualenv, skip pip install"
  ensure_node_tooling
  ensure_pnpm_and_workspace_dependencies
  if link_global_launcher; then
    ACTIVE_PATH_TARGET="$LOCAL_BIN"
    ensure_path_in_profile "$LOCAL_BIN"
  else
    echo "[semibot] warning: cannot link $LOCAL_BIN/semibot, fallback to project-local path"
    ACTIVE_PATH_TARGET="$ROOT_DIR/scripts"
    ensure_path_in_profile "$ROOT_DIR/scripts"
  fi
  warn_legacy_runtime_scripts_path
  ensure_path_in_current_shell_if_sourced "$ACTIVE_PATH_TARGET"
  echo "[semibot] run:"
  echo "  semibot --help"
  if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
    return 0
  fi
  exit 0
fi

echo "[semibot] ensuring pip in virtualenv"
"$VENV_PY" -m ensurepip --upgrade >/dev/null 2>&1 || true

echo "[semibot] upgrading packaging tools (pip/setuptools/wheel/hatchling/editables)"
if ! "$VENV_PY" -m pip install -U pip setuptools wheel hatchling editables >/dev/null 2>&1; then
  echo "[semibot] warning: packaging tools upgrade failed (will still try install -e)"
fi

echo "[semibot] installing (pip install .)"
if "$VENV_PY" -m pip install "$ROOT_DIR" --no-build-isolation >"$INSTALL_LOG" 2>&1; then
  echo "[semibot] install succeeded"
  
  echo "[semibot] installing playwright chromium browser"
  "$VENV_PY" -m playwright install chromium || echo "[semibot] warning: playwright install chromium failed"

  ensure_node_tooling
  ensure_pnpm_and_workspace_dependencies
  if link_global_launcher; then
    ACTIVE_PATH_TARGET="$LOCAL_BIN"
    ensure_path_in_profile "$LOCAL_BIN"
  else
    echo "[semibot] warning: cannot link $LOCAL_BIN/semibot, fallback to project-local path"
    ACTIVE_PATH_TARGET="$ROOT_DIR/scripts"
    ensure_path_in_profile "$ROOT_DIR/scripts"
  fi
  warn_legacy_runtime_scripts_path
  ensure_path_in_current_shell_if_sourced "$ACTIVE_PATH_TARGET"
  echo "[semibot] run:"
  echo "  semibot --help"
  echo "[semibot] optional (activate venv): source \"$VENV_DIR/bin/activate\""
  if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
    return 0
  fi
  exit 0
fi

echo "[semibot] install failed (likely offline build backend/dependency issue)"
if [ -f "$INSTALL_LOG" ]; then
  echo "[semibot] last install log: $INSTALL_LOG"
  tail -n 40 "$INSTALL_LOG" || true
fi
echo "[semibot] falling back to local launcher script link"
ensure_node_tooling
ensure_pnpm_and_workspace_dependencies
if mkdir -p "$LOCAL_BIN" 2>/dev/null && ln -sf "$ROOT_DIR/scripts/semibot" "$LOCAL_BIN/semibot" 2>/dev/null; then
  ACTIVE_PATH_TARGET="$LOCAL_BIN"
  echo "[semibot] linked: $LOCAL_BIN/semibot -> $ROOT_DIR/scripts/semibot"
  ensure_path_in_profile "$LOCAL_BIN"
else
  echo "[semibot] warning: cannot write $LOCAL_BIN (permission denied)"
  echo "[semibot] use project-local launcher directly:"
  echo "  $ROOT_DIR/scripts/semibot --help"
  ACTIVE_PATH_TARGET="$ROOT_DIR/scripts"
  ensure_path_in_profile "$ROOT_DIR/scripts"
fi
warn_legacy_runtime_scripts_path
ensure_path_in_current_shell_if_sourced "$ACTIVE_PATH_TARGET"
echo "[semibot] then run:"
echo "  semibot --help"
