#!/bin/bash
# =============================================================================
# Semibot - 服务器/虚拟机 启动管理脚本
# 通过 systemd 管理所有服务的 start / stop / restart / status
# 支持 SemiGraph / OpenClaw 运行时切换
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
DIM='\033[2m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 默认参数
RUNTIME_MODE="semigraph"
COMMAND=""

# =============================================================================
# 参数解析
# =============================================================================
parse_args() {
  COMMAND="${1:-help}"
  shift || true

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --runtime|-r)
        RUNTIME_MODE="${2:-semigraph}"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done
}

usage() {
  cat << EOF
用法: $0 <命令> [选项]

命令:
  start           启动所有服务
  stop            停止所有服务
  restart         重启所有服务
  status          查看服务状态
  infra           只启动基础设施 (PostgreSQL + Redis)
  switch-runtime  切换 Runtime 模式 (需要 --runtime 参数)
  logs <service>  查看服务日志 (api|web|runtime|openclaw|infra)
  update          拉取最新代码并重新部署

选项:
  --runtime, -r <mode>   Runtime 模式: semigraph (默认) | openclaw

示例:
  $0 start                              启动全部 (SemiGraph)
  $0 start --runtime openclaw           启动全部 (OpenClaw)
  $0 switch-runtime --runtime openclaw  切换到 OpenClaw
  $0 status                             查看状态
  $0 logs api                           查看 API 日志
  $0 update                             更新部署
EOF
}

# =============================================================================
# 加载环境变量
# =============================================================================
load_env() {
  if [ -f "$PROJECT_ROOT/.env.local" ]; then
    set -a
    source "$PROJECT_ROOT/.env.local"
    set +a
  fi
}

# =============================================================================
# 基础设施 (Docker 容器)
# =============================================================================
start_infra() {
  info "启动基础设施 ..."

  load_env

  local pg_user="${POSTGRES_USER:-semibot}"
  local pg_pass="${POSTGRES_PASSWORD:-semibot}"
  local pg_db="${POSTGRES_DB:-semibot}"
  local pg_port="${POSTGRES_PORT:-5432}"
  local redis_pass="${REDIS_PASSWORD:-semibot}"
  local redis_port="${REDIS_PORT:-6379}"

  # PostgreSQL
  if docker ps --format '{{.Names}}' | grep -q "semibot-postgres"; then
    info "PostgreSQL 已运行"
  else
    if docker ps -a --format '{{.Names}}' | grep -q "semibot-postgres"; then
      docker start semibot-postgres >/dev/null
    else
      docker run -d \
        --name semibot-postgres \
        -e POSTGRES_USER="$pg_user" \
        -e POSTGRES_PASSWORD="$pg_pass" \
        -e POSTGRES_DB="$pg_db" \
        -p "127.0.0.1:${pg_port}:5432" \
        -v semibot-postgres-data:/var/lib/postgresql/data \
        --restart unless-stopped \
        pgvector/pgvector:pg16 >/dev/null
    fi

    local retries=0
    while ! docker exec semibot-postgres pg_isready -U "$pg_user" -d "$pg_db" &>/dev/null; do
      sleep 1
      ((retries++))
      if [ $retries -ge 30 ]; then
        error "PostgreSQL 启动超时"
        return 1
      fi
    done
    info "PostgreSQL 就绪 (port $pg_port)"
  fi

  # Redis
  if docker ps --format '{{.Names}}' | grep -q "semibot-redis"; then
    info "Redis 已运行"
  else
    if docker ps -a --format '{{.Names}}' | grep -q "semibot-redis"; then
      docker start semibot-redis >/dev/null
    else
      docker run -d \
        --name semibot-redis \
        -p "127.0.0.1:${redis_port}:6379" \
        -v semibot-redis-data:/data \
        --restart unless-stopped \
        redis:7-alpine \
        redis-server --appendonly yes --maxmemory 512mb --maxmemory-policy allkeys-lru --requirepass "$redis_pass" >/dev/null
    fi

    local retries=0
    while ! docker exec semibot-redis redis-cli -a "$redis_pass" ping &>/dev/null 2>&1; do
      sleep 1
      ((retries++))
      if [ $retries -ge 15 ]; then
        error "Redis 启动超时"
        return 1
      fi
    done
    info "Redis 就绪 (port $redis_port)"
  fi
}

stop_infra() {
  info "停止基础设施 ..."
  docker stop semibot-postgres semibot-redis 2>/dev/null || true
  info "基础设施已停止"
}

# =============================================================================
# 应用服务 (systemd)
# =============================================================================
get_runtime_service() {
  case "$RUNTIME_MODE" in
    semigraph) echo "semibot-runtime" ;;
    openclaw)  echo "semibot-openclaw" ;;
    *)
      error "未知 Runtime 模式: $RUNTIME_MODE"
      exit 1
      ;;
  esac
}

get_inactive_runtime() {
  case "$RUNTIME_MODE" in
    semigraph) echo "semibot-openclaw" ;;
    openclaw)  echo "semibot-runtime" ;;
  esac
}

start_services() {
  info "启动服务 (Runtime: $RUNTIME_MODE) ..."

  local runtime_svc
  runtime_svc="$(get_runtime_service)"
  local inactive_svc
  inactive_svc="$(get_inactive_runtime)"

  # 确保互斥的 runtime 已停止
  systemctl stop "$inactive_svc" 2>/dev/null || true

  # 启动基础设施
  start_infra

  # 启动应用服务
  systemctl start semibot-api
  info "API 启动中 ..."

  systemctl start semibot-web
  info "Web 启动中 ..."

  systemctl start "$runtime_svc"
  info "$runtime_svc 启动中 ..."

  # 等待就绪
  sleep 3
  show_status_compact
}

stop_services() {
  info "停止所有服务 ..."

  systemctl stop semibot-api 2>/dev/null || true
  systemctl stop semibot-web 2>/dev/null || true
  systemctl stop semibot-runtime 2>/dev/null || true
  systemctl stop semibot-openclaw 2>/dev/null || true

  info "应用服务已停止"

  echo -n -e "${BOLD}是���同时停止基础设施? (y/N): ${NC}"
  read -r answer
  if [[ "$answer" =~ ^[Yy]$ ]]; then
    stop_infra
  fi
}

restart_services() {
  info "重启所有服务 ..."

  local runtime_svc
  runtime_svc="$(get_runtime_service)"
  local inactive_svc
  inactive_svc="$(get_inactive_runtime)"

  systemctl stop "$inactive_svc" 2>/dev/null || true

  systemctl restart semibot-api
  systemctl restart semibot-web
  systemctl restart "$runtime_svc"

  sleep 3
  show_status_compact
}

# =============================================================================
# 切换 Runtime
# =============================================================================
switch_runtime() {
  local new_svc
  new_svc="$(get_runtime_service)"
  local old_svc
  old_svc="$(get_inactive_runtime)"

  info "切换 Runtime: $old_svc → $new_svc"

  systemctl stop "$old_svc" 2>/dev/null || true
  systemctl start "$new_svc"

  sleep 2
  local status
  status="$(systemctl is-active "$new_svc" 2>/dev/null || echo "failed")"
  if [ "$status" = "active" ]; then
    info "$new_svc 已启动 ✓"
  else
    error "$new_svc 启动失败"
    echo "  查看日志: journalctl -u $new_svc -n 50"
  fi
}

# =============================================================================
# 状态
# =============================================================================
show_status_compact() {
  echo ""
  echo -e "${CYAN}${BOLD}Semibot 服务状态${NC}"
  echo -e "${DIM}─────────────────────────────────────${NC}"

  for svc in semibot-api semibot-web semibot-runtime semibot-openclaw; do
    local status
    status="$(systemctl is-active "$svc" 2>/dev/null || echo "inactive")"
    local label="${svc#semibot-}"

    case "$status" in
      active)
        echo -e "  ${GREEN}●${NC} $(printf '%-12s' "$label") ${GREEN}running${NC}"
        ;;
      inactive)
        echo -e "  ${DIM}○${NC} $(printf '%-12s' "$label") ${DIM}stopped${NC}"
        ;;
      failed)
        echo -e "  ${RED}●${NC} $(printf '%-12s' "$label") ${RED}failed${NC}"
        ;;
      *)
        echo -e "  ${YELLOW}●${NC} $(printf '%-12s' "$label") ${YELLOW}$status${NC}"
        ;;
    esac
  done

  echo ""

  # Docker 容器
  for container in semibot-postgres semibot-redis; do
    local label="${container#semibot-}"
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "$container"; then
      echo -e "  ${GREEN}●${NC} $(printf '%-12s' "$label") ${GREEN}running${NC}"
    else
      echo -e "  ${RED}○${NC} $(printf '%-12s' "$label") ${DIM}stopped${NC}"
    fi
  done

  # Nginx
  if systemctl is-active nginx &>/dev/null; then
    echo -e "  ${GREEN}●${NC} $(printf '%-12s' "nginx") ${GREEN}running${NC}"
  else
    echo -e "  ${DIM}○${NC} $(printf '%-12s' "nginx") ${DIM}stopped${NC}"
  fi

  echo ""

  # 端口
  echo -e "${DIM}端口:${NC}"
  for port_info in "3000:Web" "3001:API" "8801:Runtime" "5432:PostgreSQL" "6379:Redis" "80:HTTP" "443:HTTPS"; do
    local port="${port_info%%:*}"
    local name="${port_info##*:}"
    if ss -tlnp 2>/dev/null | grep -q ":${port} " || lsof -i ":$port" &>/dev/null 2>&1; then
      echo -e "  ${GREEN}●${NC} :$port  $name"
    else
      echo -e "  ${DIM}○${NC} :$port  $name"
    fi
  done
  echo ""
}

# =============================================================================
# 日志
# =============================================================================
show_logs() {
  local service="${1:-}"

  case "$service" in
    api)      journalctl -u semibot-api -f --no-pager ;;
    web)      journalctl -u semibot-web -f --no-pager ;;
    runtime)  journalctl -u semibot-runtime -f --no-pager ;;
    openclaw) journalctl -u semibot-openclaw -f --no-pager ;;
    infra)
      echo "=== PostgreSQL ==="
      docker logs --tail 20 semibot-postgres 2>/dev/null
      echo ""
      echo "=== Redis ==="
      docker logs --tail 20 semibot-redis 2>/dev/null
      ;;
    all|"")
      journalctl -u 'semibot-*' -f --no-pager
      ;;
    *)
      error "未知服务: $service"
      echo "  可选: api | web | runtime | openclaw | infra | all"
      ;;
  esac
}

# =============================================================================
# 更新部署
# =============================================================================
update_deploy() {
  info "更新部署 ..."

  cd "$PROJECT_ROOT"

  # 拉取最新代码
  info "拉取最新代码 ..."
  git pull --ff-only

  # 安装依赖
  info "安装依赖 ..."
  pnpm install --frozen-lockfile

  # 构建
  info "构建 shared packages ..."
  pnpm --filter @semibot/shared-types build 2>/dev/null || true
  pnpm --filter @semibot/shared-config build 2>/dev/null || true

  info "构建 API ..."
  pnpm --filter @semibot/api build

  info "构建 Web ..."
  pnpm --filter @semibot/web build

  # Python 依赖
  info "更新 Python 依赖 ..."
  "$PROJECT_ROOT/runtime/.venv/bin/pip" install -r "$PROJECT_ROOT/runtime/requirements.txt" -q

  # OpenClaw Bridge
  if [ -d "$PROJECT_ROOT/runtime/openclaw-bridge" ]; then
    info "构建 OpenClaw Bridge ..."
    cd "$PROJECT_ROOT/runtime/openclaw-bridge"
    pnpm install
    pnpm build 2>/dev/null || true
  fi

  # 数据库迁移
  info "执行数据库迁移 ..."
  bash "$SCRIPT_DIR/migrate-db.sh" migrate

  # 重启服务
  info "重启服务 ..."
  restart_services

  info "更新完成"
}

# =============================================================================
# Main
# =============================================================================
main() {
  parse_args "$@"

  case "$COMMAND" in
    start)
      start_services
      ;;
    stop)
      stop_services
      ;;
    restart)
      restart_services
      ;;
    status)
      show_status_compact
      ;;
    infra)
      start_infra
      ;;
    switch-runtime)
      switch_runtime
      ;;
    logs)
      show_logs "${2:-all}"
      ;;
    update)
      update_deploy
      ;;
    help|-h|--help)
      usage
      ;;
    *)
      error "未知命令: $COMMAND"
      usage
      exit 1
      ;;
  esac
}

main "$@"
