#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
VENV_DIR="${VENV_DIR:-$ROOT_DIR/.venv}"
VENV_PY="$VENV_DIR/bin/python"
LOCAL_BIN="${LOCAL_BIN:-$HOME/.local/bin}"
AUTO_UPDATE_PROFILE="${AUTO_UPDATE_PROFILE:-1}"
ACTIVE_PATH_TARGET=""
INSTALL_LOG="$ROOT_DIR/.install-last.log"

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

echo "[semibot] root: $ROOT_DIR"
echo "[semibot] python: $PYTHON_BIN"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "[semibot] error: python executable not found: $PYTHON_BIN" >&2
  exit 1
fi

if [ ! -x "$VENV_PY" ]; then
  echo "[semibot] creating virtualenv at $VENV_DIR"
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi

echo "[semibot] ensuring pip in virtualenv"
"$VENV_PY" -m ensurepip --upgrade >/dev/null 2>&1 || true

echo "[semibot] upgrading packaging tools (pip/setuptools/wheel/hatchling/editables)"
if ! "$VENV_PY" -m pip install -U pip setuptools wheel hatchling editables >/dev/null 2>&1; then
  echo "[semibot] warning: packaging tools upgrade failed (will still try install -e)"
fi

echo "[semibot] trying editable install (pip install -e .)"
if "$VENV_PY" -m pip install -e "$ROOT_DIR" --no-build-isolation >"$INSTALL_LOG" 2>&1; then
  echo "[semibot] editable install succeeded"
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
  echo "[semibot] optional (for python dev commands): source \"$VENV_DIR/bin/activate\""
  if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
    return 0
  fi
  exit 0
fi

echo "[semibot] editable install failed (likely offline build backend/dependency issue)"
if [ -f "$INSTALL_LOG" ]; then
  echo "[semibot] last install log: $INSTALL_LOG"
  tail -n 40 "$INSTALL_LOG" || true
fi
echo "[semibot] falling back to local launcher script link"
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
