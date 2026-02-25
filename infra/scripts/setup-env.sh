#!/bin/bash
# =============================================================================
# Semibot - 环境变量初始化脚本
# 从 .env.example 生成 .env.local，自动生成密钥，交互式填写 LLM Key
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_EXAMPLE="$PROJECT_ROOT/.env.example"
ENV_LOCAL="$PROJECT_ROOT/.env.local"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }
title() { echo -e "\n${CYAN}${BOLD}$1${NC}"; }

# 生成随机密钥
gen_secret() {
  openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64
}

gen_password() {
  openssl rand -hex 16 2>/dev/null || head -c 16 /dev/urandom | xxd -p
}

# 交互式读取（带默认值）
ask() {
  local prompt="$1"
  local default="$2"
  local var_name="$3"
  local is_secret="${4:-false}"

  if [ -n "$default" ]; then
    prompt="$prompt [${default}]"
  fi

  if [ "$is_secret" = "true" ]; then
    echo -n -e "${BOLD}$prompt: ${NC}"
    read -rs value
    echo ""
  else
    echo -n -e "${BOLD}$prompt: ${NC}"
    read -r value
  fi

  value="${value:-$default}"
  eval "$var_name='$value'"
}

# =============================================================================
main() {
  title "Semibot 环境变量初始化"
  echo ""

  if [ ! -f "$ENV_EXAMPLE" ]; then
    error ".env.example 不存在: $ENV_EXAMPLE"
    exit 1
  fi

  if [ -f "$ENV_LOCAL" ]; then
    warn ".env.local 已存在"
    ask "是否覆盖? (y/N)" "N" OVERWRITE
    if [[ ! "$OVERWRITE" =~ ^[Yy]$ ]]; then
      info "已取消"
      exit 0
    fi
    cp "$ENV_LOCAL" "$ENV_LOCAL.bak.$(date +%s)"
    info "已备份到 .env.local.bak.*"
  fi

  # -------------------------------------------------------------------------
  title "1. 数据库配置"
  # -------------------------------------------------------------------------
  local pg_password
  pg_password="$(gen_password)"

  ask "PostgreSQL 用户名" "semibot" PG_USER
  ask "PostgreSQL 密码 (���空自动生成)" "" PG_PASS true
  PG_PASS="${PG_PASS:-$pg_password}"
  ask "PostgreSQL 数据库名" "semibot" PG_DB
  ask "PostgreSQL 端口" "5432" PG_PORT

  local redis_password
  redis_password="$(gen_password)"
  ask "Redis 密码 (留空自动生成)" "" REDIS_PASS true
  REDIS_PASS="${REDIS_PASS:-$redis_password}"
  ask "Redis 端口" "6379" REDIS_PORT

  # -------------------------------------------------------------------------
  title "2. 认证密钥 (自动生成)"
  # -------------------------------------------------------------------------
  JWT_SECRET="$(gen_secret)"
  SESSION_SECRET="$(gen_secret)"
  info "JWT_SECRET     已生成"
  info "SESSION_SECRET 已生成"

  # -------------------------------------------------------------------------
  title "3. LLM 提供商 (可选，留空跳过)"
  # -------------------------------------------------------------------------
  ask "OpenAI API Key" "" OPENAI_KEY true
  ask "OpenAI Base URL (自定义端点)" "" OPENAI_BASE_URL
  ask "Anthropic API Key" "" ANTHROPIC_KEY true
  ask "Anthropic Base URL" "" ANTHROPIC_BASE_URL
  ask "Google AI API Key" "" GOOGLE_KEY true
  ask "自定义 LLM API Key (DeepSeek 等)" "" CUSTOM_LLM_KEY true
  ask "自定义 LLM Base URL" "" CUSTOM_LLM_BASE_URL

  # -------------------------------------------------------------------------
  title "4. 应用配置"
  # -------------------------------------------------------------------------
  ask "前端地址" "http://localhost:3000" APP_URL
  ask "API 地址 (浏览器端)" "http://localhost:3001/api/v1" API_URL
  ask "API 内网地址" "http://localhost:3001" API_INTERNAL
  ask "Runtime 地址" "http://localhost:8801" RUNTIME_URL
  ask "日志级别 (debug/info/warn/error)" "info" LOG_LEVEL

  # -------------------------------------------------------------------------
  title "5. 写入 .env.local"
  # -------------------------------------------------------------------------

  cat > "$ENV_LOCAL" << ENVEOF
# =============================================================================
# Semibot 环境变量 - 由 setup-env.sh 自动生成于 $(date '+%Y-%m-%d %H:%M:%S')
# =============================================================================

# --- 数据库 ---
POSTGRES_USER="${PG_USER}"
POSTGRES_PASSWORD="${PG_PASS}"
POSTGRES_DB="${PG_DB}"
POSTGRES_PORT="${PG_PORT}"
DATABASE_URL="postgresql://${PG_USER}:${PG_PASS}@localhost:${PG_PORT}/${PG_DB}"

REDIS_PASSWORD="${REDIS_PASS}"
REDIS_PORT="${REDIS_PORT}"
REDIS_URL="redis://:${REDIS_PASS}@localhost:${REDIS_PORT}"

# --- 认证 ---
JWT_SECRET="${JWT_SECRET}"
SESSION_SECRET="${SESSION_SECRET}"

# --- LLM 提供商 ---
OPENAI_API_KEY="${OPENAI_KEY}"
OPENAI_API_BASE_URL="${OPENAI_BASE_URL}"
OPENAI_ORG_ID=""

ANTHROPIC_API_KEY="${ANTHROPIC_KEY}"
ANTHROPIC_API_BASE_URL="${ANTHROPIC_BASE_URL}"

GOOGLE_AI_API_KEY="${GOOGLE_KEY}"
GOOGLE_AI_API_BASE_URL=""

AZURE_OPENAI_API_KEY=""
AZURE_OPENAI_API_BASE_URL=""
AZURE_OPENAI_API_VERSION=""
AZURE_OPENAI_DEPLOYMENT_NAME=""

CUSTOM_LLM_API_KEY="${CUSTOM_LLM_KEY}"
CUSTOM_LLM_API_BASE_URL="${CUSTOM_LLM_BASE_URL}"

# --- 外部服务 ---
SUPABASE_URL=""
SUPABASE_ANON_KEY=""
SUPABASE_SERVICE_ROLE_KEY=""

# --- 应用 ---
NODE_ENV="development"
NEXT_PUBLIC_APP_URL="${APP_URL}"
NEXT_PUBLIC_API_URL="${API_URL}"
API_INTERNAL_URL="${API_INTERNAL}"
WEB_BASE_URL="${APP_URL}"

# --- Runtime ---
RUNTIME_URL="${RUNTIME_URL}"
CHAT_RUNTIME_TIMEOUT_THRESHOLD_MS="300000"
CHAT_RUNTIME_ERROR_RATE_THRESHOLD="0.5"

# --- 可观测性 ---
SENTRY_DSN=""
LOG_LEVEL="${LOG_LEVEL}"

# --- Skills ---
SKILL_STORAGE_PATH="/var/lib/semibot/skills"
SKILL_MAX_SIZE_MB="100"
SKILL_MAX_CONCURRENT_INSTALLS="50"
ENVEOF

  chmod 600 "$ENV_LOCAL"
  info ".env.local 已生成 (权限 600)"

  echo ""
  title "完成!"
  echo -e "  配置文件: ${BOLD}$ENV_LOCAL${NC}"
  echo -e "  下一步:   ${BOLD}bash infra/scripts/install-local.sh${NC}  (本地开发)"
  echo -e "            ${BOLD}bash infra/scripts/install-vm.sh${NC}     (服务器部署)"
  echo ""
}

main "$@"
