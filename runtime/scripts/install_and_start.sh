#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="$ROOT_DIR/.venv"
VENV_PY="$VENV_DIR/bin/python"
PYTHON_BIN="${PYTHON_BIN:-python3}"
SEMIBOT_HOME="${SEMIBOT_HOME:-$HOME/.semibot}"
ENV_FILE="$SEMIBOT_HOME/env.sh"
PROJECT_ENV_FILE="${PROJECT_ENV_FILE:-$ROOT_DIR/../.env.local}"

usage() {
  cat <<'EOF'
Semibot Runtime Install/Start Script

Usage:
  ./scripts/install_and_start.sh install
  ./scripts/install_and_start.sh setup-env
  ./scripts/install_and_start.sh doctor
  ./scripts/install_and_start.sh init
  ./scripts/install_and_start.sh chat
  ./scripts/install_and_start.sh run "<task>"
  ./scripts/install_and_start.sh serve [--host 127.0.0.1] [--port 8765]

Environment:
  PYTHON_BIN    Python executable (default: python3)
  SEMIBOT_HOME  Runtime home dir (default: ~/.semibot)
  SEMIBOT_ALLOW_CUSTOM_KEY_WITHOUT_BASE_URL
               Set to 1 to disable strict custom endpoint check

Optional (for LLM):
  OPENAI_API_KEY
  CUSTOM_LLM_API_KEY
  OPENAI_API_BASE_URL
  CUSTOM_LLM_API_BASE_URL
  CUSTOM_LLM_MODEL_NAME
  TAVILY_API_KEY
  SERPAPI_API_KEY
EOF
}

require_python() {
  if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
    echo "ERROR: Python not found: $PYTHON_BIN" >&2
    exit 1
  fi

  "$PYTHON_BIN" - <<'PY'
import sys
if sys.version_info < (3, 11):
    raise SystemExit("ERROR: Python >= 3.11 is required")
print(f"Python OK: {sys.version.split()[0]}")
PY
}

ensure_venv() {
  if [[ ! -x "$VENV_PY" ]]; then
    echo "Creating virtual env: $VENV_DIR"
    "$PYTHON_BIN" -m venv "$VENV_DIR"
  fi
}

ensure_env_file() {
  mkdir -p "$SEMIBOT_HOME"
  if [[ ! -f "$ENV_FILE" ]]; then
    touch "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi
}

set_env_if_missing() {
  local key="$1"
  local value="$2"
  # Keep explicitly provided env / env.sh values, only backfill missing ones.
  if [[ -z "${!key:-}" ]]; then
    export "$key=$value"
  fi
}

load_project_env_fallback() {
  local file="${PROJECT_ENV_FILE}"
  if [[ ! -f "$file" ]]; then
    return 0
  fi
  while IFS=$'\t' read -r key value; do
    [[ -z "${key:-}" ]] && continue
    set_env_if_missing "$key" "$value"
  done < <("$PYTHON_BIN" - "$file" <<'PY'
import re
import sys
from pathlib import Path

allowed = {
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_AI_API_KEY",
    "CUSTOM_LLM_API_KEY",
    "OPENAI_API_BASE_URL",
    "ANTHROPIC_API_BASE_URL",
    "GOOGLE_AI_API_BASE_URL",
    "CUSTOM_LLM_API_BASE_URL",
    "DEFAULT_LLM_MODEL",
    "FALLBACK_LLM_MODEL",
    "CUSTOM_LLM_MODEL_NAME",
    "TAVILY_API_KEY",
    "SERPAPI_API_KEY",
}

def parse_value(raw: str) -> str:
    value = raw.strip()
    if not value:
        return ""

    if value.startswith('"'):
        i = 1
        out = []
        escaped = False
        while i < len(value):
            ch = value[i]
            if escaped:
                out.append(ch)
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                break
            else:
                out.append(ch)
            i += 1
        return "".join(out)

    if value.startswith("'"):
        end = value.find("'", 1)
        if end == -1:
            return value[1:]
        return value[1:end]

    # Unquoted value: strip trailing inline comments.
    return value.split("#", 1)[0].rstrip()

content = Path(sys.argv[1]).read_text(encoding="utf-8")
for line in content.splitlines():
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        continue
    if stripped.startswith("export "):
        stripped = stripped[7:].lstrip()
    m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", stripped)
    if not m:
        continue
    key, raw_val = m.group(1), m.group(2)
    if key not in allowed:
        continue
    print(f"{key}\t{parse_value(raw_val)}")
PY
)
}

load_env_file() {
  ensure_env_file
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  load_project_env_fallback
}

upsert_env_var() {
  local key="$1"
  local value="$2"
  ensure_env_file
  "$PYTHON_BIN" - "$ENV_FILE" "$key" "$value" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]

lines = []
if path.exists():
    lines = path.read_text(encoding="utf-8").splitlines()
lines = [line for line in lines if not line.startswith(f"export {key}=")]
escaped = value.replace("\\", "\\\\").replace('"', '\\"')
lines.append(f'export {key}="{escaped}"')
path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
PY
  chmod 600 "$ENV_FILE"
}

status_bool() {
  local value="${1:-}"
  if [[ -n "$value" ]]; then
    echo "yes"
  else
    echo "no"
  fi
}

doctor() {
  load_env_file
  echo "Semibot Doctor"
  echo "  Python: $($PYTHON_BIN --version 2>&1)"
  echo "  Venv python exists: $( [[ -x "$VENV_PY" ]] && echo yes || echo no )"
  echo "  ENV file: $ENV_FILE"
  echo "  OPENAI_API_KEY: $(status_bool "${OPENAI_API_KEY:-}")"
  echo "  CUSTOM_LLM_API_KEY: $(status_bool "${CUSTOM_LLM_API_KEY:-}")"
  echo "  OPENAI_API_BASE_URL: $(status_bool "${OPENAI_API_BASE_URL:-}")"
  echo "  CUSTOM_LLM_API_BASE_URL: $(status_bool "${CUSTOM_LLM_API_BASE_URL:-}")"
  echo "  CUSTOM_LLM_MODEL_NAME: ${CUSTOM_LLM_MODEL_NAME:-<default:gpt-4o>}"
  echo "  TAVILY_API_KEY: $(status_bool "${TAVILY_API_KEY:-}")"
  echo "  SERPAPI_API_KEY: $(status_bool "${SERPAPI_API_KEY:-}")"
  if validate_llm_config >/dev/null 2>&1; then
    echo "  LLM config valid: yes"
  else
    echo "  LLM config valid: no"
    if [[ -n "${CUSTOM_LLM_API_KEY:-}" && -z "${CUSTOM_LLM_API_BASE_URL:-}" ]]; then
      echo "  Warning: CUSTOM_LLM_API_BASE_URL is required when CUSTOM_LLM_API_KEY is used."
    fi
  fi
}

has_llm_key() {
  [[ -n "${OPENAI_API_KEY:-}" || -n "${CUSTOM_LLM_API_KEY:-}" ]]
}

validate_llm_config() {
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    return 0
  fi
  if [[ -n "${CUSTOM_LLM_API_KEY:-}" ]]; then
    if [[ "${SEMIBOT_ALLOW_CUSTOM_KEY_WITHOUT_BASE_URL:-0}" == "1" ]]; then
      return 0
    fi
    if [[ -z "${CUSTOM_LLM_API_BASE_URL:-}" ]]; then
      echo "ERROR: CUSTOM_LLM_API_KEY is set but CUSTOM_LLM_API_BASE_URL is missing." >&2
      echo "Run: ./scripts/install_and_start.sh setup-env" >&2
      echo "Or export CUSTOM_LLM_API_BASE_URL manually." >&2
      return 1
    fi
    return 0
  fi
  echo "ERROR: Missing LLM API key." >&2
  echo "Run: ./scripts/install_and_start.sh setup-env" >&2
  echo "Or export OPENAI_API_KEY/CUSTOM_LLM_API_KEY manually." >&2
  return 1
}

require_llm_config() {
  if ! validate_llm_config; then
    exit 1
  fi
}

setup_env_interactive() {
  load_env_file
  echo "Configuring API keys (saved to: $ENV_FILE)"

  if ! has_llm_key; then
    echo "LLM key is required for chat/run."
    read -r -s -p "OPENAI_API_KEY (leave empty to skip): " openai_key
    echo
    if [[ -n "${openai_key:-}" ]]; then
      upsert_env_var "OPENAI_API_KEY" "$openai_key"
      export OPENAI_API_KEY="$openai_key"
      echo "Saved OPENAI_API_KEY"
      read -r -p "OPENAI_API_BASE_URL (optional, enter to skip): " openai_base
      if [[ -n "${openai_base:-}" ]]; then
        upsert_env_var "OPENAI_API_BASE_URL" "$openai_base"
        export OPENAI_API_BASE_URL="$openai_base"
        echo "Saved OPENAI_API_BASE_URL"
      fi
    else
      read -r -s -p "CUSTOM_LLM_API_KEY (leave empty to skip): " custom_key
      echo
      if [[ -n "${custom_key:-}" ]]; then
        upsert_env_var "CUSTOM_LLM_API_KEY" "$custom_key"
        export CUSTOM_LLM_API_KEY="$custom_key"
        echo "Saved CUSTOM_LLM_API_KEY"
        custom_base=""
        while [[ -z "${custom_base:-}" ]]; do
          read -r -p "CUSTOM_LLM_API_BASE_URL (required, e.g. https://api.openai.com/v1): " custom_base
        done
        upsert_env_var "CUSTOM_LLM_API_BASE_URL" "$custom_base"
        export CUSTOM_LLM_API_BASE_URL="$custom_base"
        echo "Saved CUSTOM_LLM_API_BASE_URL"
      fi
    fi
  else
    echo "LLM key already configured."
  fi

  if [[ -n "${CUSTOM_LLM_API_KEY:-}" && -z "${CUSTOM_LLM_API_BASE_URL:-}" ]]; then
    custom_base_existing=""
    while [[ -z "${custom_base_existing:-}" ]]; do
      read -r -p "CUSTOM_LLM_API_BASE_URL (required, e.g. https://api.openai.com/v1): " custom_base_existing
    done
    upsert_env_var "CUSTOM_LLM_API_BASE_URL" "$custom_base_existing"
    export CUSTOM_LLM_API_BASE_URL="$custom_base_existing"
    echo "Saved CUSTOM_LLM_API_BASE_URL"
  fi

  if [[ -n "${OPENAI_API_KEY:-}" && -z "${OPENAI_API_BASE_URL:-}" ]]; then
    read -r -p "OPENAI_API_BASE_URL (optional, enter to skip): " openai_base_existing
    if [[ -n "${openai_base_existing:-}" ]]; then
      upsert_env_var "OPENAI_API_BASE_URL" "$openai_base_existing"
      export OPENAI_API_BASE_URL="$openai_base_existing"
      echo "Saved OPENAI_API_BASE_URL"
    fi
  fi

  if [[ -z "${CUSTOM_LLM_MODEL_NAME:-}" ]]; then
    read -r -p "CUSTOM_LLM_MODEL_NAME [gpt-4o]: " custom_model
    custom_model="${custom_model:-gpt-4o}"
    upsert_env_var "CUSTOM_LLM_MODEL_NAME" "$custom_model"
    export CUSTOM_LLM_MODEL_NAME="$custom_model"
    echo "Saved CUSTOM_LLM_MODEL_NAME=$custom_model"
  fi

  if [[ -z "${TAVILY_API_KEY:-}" && -z "${SERPAPI_API_KEY:-}" ]]; then
    echo "Search API key is optional (recommended for research tasks)."
    read -r -s -p "TAVILY_API_KEY (leave empty to skip): " tavily_key
    echo
    if [[ -n "${tavily_key:-}" ]]; then
      upsert_env_var "TAVILY_API_KEY" "$tavily_key"
      export TAVILY_API_KEY="$tavily_key"
      echo "Saved TAVILY_API_KEY"
    fi
  fi

  echo "Done. You can inspect with: ./scripts/install_and_start.sh doctor"
}

install_runtime() {
  require_python
  ensure_venv
  echo "Installing Semibot runtime dependencies..."
  "$VENV_PY" -m pip install --upgrade pip
  "$VENV_PY" -m pip install -e ".[dev]"
}

run_semibot() {
  local args=("$@")
  "$VENV_PY" -m semibot "${args[@]}"
}

cmd="${1:-help}"
shift || true

cd "$ROOT_DIR"

case "$cmd" in
  install)
    install_runtime
    if [[ -t 0 ]]; then
      setup_env_interactive
    else
      echo "Skip interactive env setup (non-interactive shell)."
      echo "Run: ./scripts/install_and_start.sh setup-env"
    fi
    echo "Install done."
    ;;
  setup-env)
    install_runtime
    setup_env_interactive
    ;;
  doctor)
    doctor
    ;;
  init)
    install_runtime
    load_env_file
    run_semibot init
    ;;
  chat)
    install_runtime
    load_env_file
    require_llm_config
    run_semibot init
    run_semibot chat "$@"
    ;;
  run)
    if [[ $# -lt 1 ]]; then
      echo "ERROR: run requires a task string." >&2
      usage
      exit 1
    fi
    install_runtime
    load_env_file
    require_llm_config
    run_semibot init
    run_semibot run "$@"
    ;;
  serve)
    host="127.0.0.1"
    port="8765"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --host)
          host="${2:-}"
          shift 2
          ;;
        --port)
          port="${2:-}"
          shift 2
          ;;
        *)
          echo "ERROR: Unknown option: $1" >&2
          usage
          exit 1
          ;;
      esac
    done
    install_runtime
    load_env_file
    run_semibot init
    run_semibot serve --host "$host" --port "$port"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "ERROR: Unknown command: $cmd" >&2
    usage
    exit 1
    ;;
esac
