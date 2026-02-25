#!/bin/bash
# =============================================================================
# Semibot - 本地开发环境安装脚本
# 适用于 macOS / Linux 开发机
# 安装 Node.js 依赖、Python 虚拟环境、基础设施容器、数据库迁移
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

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
title() { echo -e "\n${CYAN}${BOLD}═══ $1 ═══${NC}\n"; }

OS="$(uname -s)"

# =============================================================================
# 1. 前置检查
# =============================================================================
check_prerequisites() {
  title "1/6 前置检查"

  # Node.js
  if command -v node &>/dev/null; then
    local node_ver
    node_ver="$(node -v | sed 's/v//')"
    local node_major
    node_major="$(echo "$node_ver" | cut -d. -f1)"
    if [ "$node_major" -ge 20 ]; then
      info "Node.js $node_ver ✓"
    else
      error "Node.js >= 20 required, found $node_ver"
      echo "  推荐: nvm install 20 && nvm use 20"
      exit 1
    fi
  else
    error "Node.js 未安装"
    echo "  推荐: https://github.com/nvm-sh/nvm"
    exit 1
  fi

  # pnpm
  if command -v pnpm &>/dev/null; then
    local pnpm_ver
    pnpm_ver="$(pnpm -v)"
    info "pnpm $pnpm_ver ✓"
  else
    warn "pnpm 未安装，正在安装..."
    corepack enable
    corepack prepare pnpm@9.0.0 --activate
    info "pnpm 已安装"
  fi

  # Python
  local python_cmd=""
  for cmd in python3.11 python3.12 python3; do
    if command -v "$cmd" &>/dev/null; then
      local py_ver
      py_ver="$($cmd --version 2>&1 | awk '{print $2}')"
      local py_minor
      py_minor="$(echo "$py_ver" | cut -d. -f2)"
      if [ "$py_minor" -ge 11 ]; then
        python_cmd="$cmd"
        info "Python $py_ver ($cmd) ✓"
        break
      fi
    fi
  done

  if [ -z "$python_cmd" ]; then
    error "Python >= 3.11 required"
    if [ "$OS" = "Darwin" ]; then
      echo "  推荐: brew install python@3.11"
    else
      echo "  推荐: sudo apt install python3.11 python3.11-venv"
    fi
    exit 1
  fi
  PYTHON_CMD="$python_cmd"

  # Docker (for postgres + redis)
  if command -v docker &>/dev/null; then
    info "Docker ✓"
  else
    warn "Docker 未安装 — 需要手动启动 PostgreSQL 和 Redis"
  fi

  # psql
  if command -v psql &>/dev/null; then
    info "psql ✓"
  else
    warn "psql 未安装 — 数据库迁移需要 psql"
    if [ "$OS" = "Darwin" ]; then
      echo "  推荐: brew install postgresql"
    else
      echo "  推荐: sudo apt install postgresql-client"
    fi
  fi
}

# =============================================================================
# 2. 环境变量
# =============================================================================
setup_env() {
  title "2/6 环境变量"

  if [ -f "$PROJECT_ROOT/.env.local" ]; then
    info ".env.local 已存在，跳过"
  else
    warn ".env.local 不存在"
    echo -n -e "${BOLD}是否运行 setup-env.sh 生成? (Y/n): ${NC}"
    read -r answer
    if [[ ! "$answer" =~ ^[Nn]$ ]]; then
      bash "$SCRIPT_DIR/setup-env.sh"
    else
      warn "请手动创建 .env.local (参考 .env.example)"
    fi
  fi
}

# =============================================================================
# 3. Node.js 依赖
# =============================================================================
install_node_deps() {
  title "3/6 Node.js 依赖"

  cd "$PROJECT_ROOT"
  info "pnpm install ..."
  pnpm install

  info "构建 shared packages ..."
  pnpm --filter @semibot/shared-types build 2>/dev/null || true
  pnpm --filter @semibot/shared-config build 2>/dev/null || true

  info "Node.js 依赖安装完成"
}

# =============================================================================
# 4. Python 虚拟环境
# =============================================================================
setup_python_venv() {
  title "4/6 Python Runtime 环境"

  local runtime_dir="$PROJECT_ROOT/runtime"
  local venv_dir="$runtime_dir/.venv"

  if [ -d "$venv_dir" ] && [ -f "$venv_dir/bin/python" ]; then
    info "虚拟环境已存在: $venv_dir"
  else
    info "创建虚拟环境 ..."
    $PYTHON_CMD -m venv "$venv_dir"
    info "虚拟环境已创建"
  fi

  info "安装 Python 依赖 ..."
  "$venv_dir/bin/pip" install --upgrade pip -q
  "$venv_dir/bin/pip" install -r "$runtime_dir/requirements.txt" -q

  if [ -f "$runtime_dir/requirements-dev.txt" ]; then
    "$venv_dir/bin/pip" install -r "$runtime_dir/requirements-dev.txt" -q
  fi

  # OpenClaw Bridge 依赖
  local bridge_dir="$runtime_dir/openclaw-bridge"
  if [ -d "$bridge_dir" ] && [ -f "$bridge_dir/package.json" ]; then
    info "安装 OpenClaw Bridge 依赖 ..."
    cd "$bridge_dir"
    pnpm install
    pnpm build 2>/dev/null || true
  fi

  info "Python 环境就绪"
}

# =============================================================================
# 5. 基础设施容器 (PostgreSQL + Redis)
# =============================================================================
start_infra_containers() {
  title "5/6 基础设施 (PostgreSQL + Redis)"

  if ! command -v docker &>/dev/null; then
    warn "Docker 未安装，跳过容器启动"
    warn "请确保 PostgreSQL 和 Redis 已在本地运行"
    return
  fi

  # 加载环境变量
  if [ -f "$PROJECT_ROOT/.env.local" ]; then
    set -a
    source "$PROJECT_ROOT/.env.local"
    set +a
  fi

  local pg_user="${POSTGRES_USER:-semibot}"
  local pg_pass="${POSTGRES_PASSWORD:-semibot}"
  local pg_db="${POSTGRES_DB:-semibot}"
  local pg_port="${POSTGRES_PORT:-5432}"
  local redis_pass="${REDIS_PASSWORD:-semibot}"
  local redis_port="${REDIS_PORT:-6379}"

  # PostgreSQL
  if docker ps --format '{{.Names}}' | grep -q "semibot-postgres"; then
    info "PostgreSQL 容器已运行"
  else
    if docker ps -a --format '{{.Names}}' | grep -q "semibot-postgres"; then
      info "启动已有 PostgreSQL 容器 ..."
      docker start semibot-postgres
    else
      info "创建 PostgreSQL 容器 ..."
      docker run -d \
        --name semibot-postgres \
        -e POSTGRES_USER="$pg_user" \
        -e POSTGRES_PASSWORD="$pg_pass" \
        -e POSTGRES_DB="$pg_db" \
        -p "127.0.0.1:${pg_port}:5432" \
        -v semibot-postgres-data:/var/lib/postgresql/data \
        --restart unless-stopped \
        pgvector/pgvector:pg16
    fi

    info "等待 PostgreSQL 就绪 ..."
    local retries=0
    while ! docker exec semibot-postgres pg_isready -U "$pg_user" -d "$pg_db" &>/dev/null; do
      sleep 1
      ((retries++))
      if [ $retries -ge 30 ]; then
        error "PostgreSQL 启动超时"
        exit 1
      fi
    done
    info "PostgreSQL 就绪 (port $pg_port)"
  fi

  # Redis
  if docker ps --format '{{.Names}}' | grep -q "semibot-redis"; then
    info "Redis 容器已运行"
  else
    if docker ps -a --format '{{.Names}}' | grep -q "semibot-redis"; then
      info "启动已有 Redis 容器 ..."
      docker start semibot-redis
    else
      info "创建 Redis 容器 ..."
      docker run -d \
        --name semibot-redis \
        -p "127.0.0.1:${redis_port}:6379" \
        -v semibot-redis-data:/data \
        --restart unless-stopped \
        redis:7-alpine \
        redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru --requirepass "$redis_pass"
    fi

    info "等待 Redis 就绪 ..."
    local retries=0
    while ! docker exec semibot-redis redis-cli -a "$redis_pass" ping &>/dev/null 2>&1; do
      sleep 1
      ((retries++))
      if [ $retries -ge 15 ]; then
        error "Redis 启动超时"
        exit 1
      fi
    done
    info "Redis 就绪 (port $redis_port)"
  fi
}

# =============================================================================
# 6. 数据库迁移
# =============================================================================
run_migrations() {
  title "6/6 数据库迁移"

  if ! command -v psql &>/dev/null; then
    warn "psql 未安装，跳过迁移"
    warn "请手动运行: bash infra/scripts/migrate-db.sh"
    return
  fi

  bash "$SCRIPT_DIR/migrate-db.sh" migrate
}

# =============================================================================
# Main
# =============================================================================
main() {
  echo -e "\n${CYAN}${BOLD}╔═══════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}${BOLD}║   Semibot 本地开发环境安装                ║${NC}"
  echo -e "${CYAN}${BOLD}╚═══════════════════════════════════════════╝${NC}"

  check_prerequisites
  setup_env
  install_node_deps
  setup_python_venv
  start_infra_containers
  run_migrations

  echo ""
  title "安装完成!"
  echo -e "  启动开发服务: ${BOLD}bash infra/scripts/start-local.sh${NC}"
  echo -e "  指定 Runtime:  ${BOLD}bash infra/scripts/start-local.sh --runtime semigraph${NC}"
  echo -e "                 ${BOLD}bash infra/scripts/start-local.sh --runtime openclaw${NC}"
  echo ""
}

main "$@"
