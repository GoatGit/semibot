#!/bin/bash
# =============================================================================
# Semibot - 本地开发启动脚本
# 启动 Web + API + Runtime (SemiGraph / OpenClaw)
# 基础设施 (PostgreSQL + Redis) 通过 Docker 容器运行
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

LOG_DIR="$PROJECT_ROOT/.logs"

# 默认参数
RUNTIME_MODE="semigraph"
SKIP_INFRA=false
SERVICES="all"  # all | api | web | runtime | infra

# 服务端口映射
get_service_port() {
  case "$1" in
    api)     echo "${API_PORT:-3001}" ;;
    web)     echo "${WEB_PORT:-3000}" ;;
    runtime) echo "${RUNTIME_PORT:-8801}" ;;
  esac
}

# 检查端口是否有进程监听
is_port_listening() {
  lsof -ti ":$1" &>/dev/null
}

# 获取监听指定端口的 PID 列表
get_port_pids() {
  lsof -ti ":$1" 2>/dev/null || true
}

# 停止监听指定端口的所有进程
kill_port() {
  local port="$1"
  local pids
  pids="$(get_port_pids "$port")"
  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill 2>/dev/null || true
    # 等待进程退出
    local retries=0
    while is_port_listening "$port" && [ $retries -lt 10 ]; do
      sleep 0.5
      ((retries++))
    done
    # 如果还没退出，强制 kill
    if is_port_listening "$port"; then
      get_port_pids "$port" | xargs kill -9 2>/dev/null || true
    fi
    return 0
  fi
  return 1
}

# =============================================================================
# 参数解析
# =============================================================================
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --runtime|-r)
        RUNTIME_MODE="${2:-semigraph}"
        shift 2
        ;;
      --skip-infra)
        SKIP_INFRA=true
        shift
        ;;
      --only|-o)
        SERVICES="${2:-all}"
        shift 2
        ;;
      stop)
        stop_all
        exit 0
        ;;
      status)
        show_status
        exit 0
        ;;
      logs)
        tail_logs "${2:-all}"
        exit 0
        ;;
      -h|--help|help)
        usage
        exit 0
        ;;
      *)
        error "未知参数: $1"
        usage
        exit 1
        ;;
    esac
  done
}

usage() {
  cat << EOF
用法: $0 [选项] [命令]

命令:
  (默认)          启动所有服务
  stop            停止所有服务
  status          查看服务状态
  logs [service]  查看日志 (api|web|runtime|all)

选项:
  --runtime, -r <mode>   Runtime 模式: semigraph (默认) | openclaw
  --skip-infra           跳过基础设施容器启动 (PostgreSQL/Redis)
  --only, -o <service>   只启动指定服务: api | web | runtime | infra

示例:
  $0                              启动全部 (SemiGraph 模式)
  $0 --runtime openclaw           启动全部 (OpenClaw 模式)
  $0 --only api                   只启动 API
  $0 --only web --skip-infra      只启动 Web (不启动容器)
  $0 stop                         停止所有服务
  $0 logs api                     查看 API 日志
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
  elif [ -f "$PROJECT_ROOT/.env" ]; then
    set -a
    source "$PROJECT_ROOT/.env"
    set +a
  else
    error "未找到 .env.local，请先运行: bash infra/scripts/setup-env.sh"
    exit 1
  fi
}

# =============================================================================
# 基础设施
# =============================================================================
start_infra() {
  if [ "$SKIP_INFRA" = true ]; then
    info "跳过基础设施启动"
    return
  fi

  if ! command -v docker &>/dev/null; then
    warn "Docker 未安装，跳过容器启动"
    return
  fi

  if ! docker info &>/dev/null; then
    warn "Docker daemon 未运行，跳过容器启动"
    warn "请先启动 Docker Desktop 或 dockerd"
    return
  fi

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
    info "PostgreSQL 启动中 (port $pg_port) ..."
    local retries=0
    while ! docker exec semibot-postgres pg_isready -U "$pg_user" -d "$pg_db" &>/dev/null; do
      sleep 1
      ((retries++))
      if [ $retries -ge 30 ]; then
        error "PostgreSQL 启动超时"
        exit 1
      fi
    done
    info "PostgreSQL 就绪"
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
        redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru --requirepass "$redis_pass" >/dev/null
    fi
    info "Redis 启动中 (port $redis_port) ..."
    local retries=0
    while ! docker exec semibot-redis redis-cli -a "$redis_pass" ping &>/dev/null 2>&1; do
      sleep 1
      ((retries++))
      if [ $retries -ge 15 ]; then
        error "Redis 启动超时"
        exit 1
      fi
    done
    info "Redis 就绪"
  fi
}

# =============================================================================
# API 服务
# =============================================================================
start_api() {
  mkdir -p "$LOG_DIR"
  local port
  port="$(get_service_port api)"

  if is_port_listening "$port"; then
    info "API 已在运行 (port $port)"
    return
  fi

  info "启动 API 服务 (port $port) ..."
  cd "$PROJECT_ROOT"
  nohup pnpm --filter @semibot/api dev > "$LOG_DIR/api.log" 2>&1 &
  info "API 启动中 ..."
}

# =============================================================================
# Web 服务
# =============================================================================
start_web() {
  mkdir -p "$LOG_DIR"
  local port
  port="$(get_service_port web)"

  if is_port_listening "$port"; then
    info "Web 已在运行 (port $port)"
    return
  fi

  info "启动 Web 服务 (port $port) ..."
  cd "$PROJECT_ROOT"
  nohup pnpm --filter @semibot/web dev > "$LOG_DIR/web.log" 2>&1 &
  info "Web 启动中 ..."
}

# =============================================================================
# Runtime 服务
# =============================================================================
start_runtime() {
  mkdir -p "$LOG_DIR"
  local port
  port="$(get_service_port runtime)"

  if is_port_listening "$port"; then
    info "Runtime 已在运行 (port $port)"
    return
  fi

  local runtime_dir="$PROJECT_ROOT/runtime"
  local venv_python="$runtime_dir/.venv/bin/python"

  case "$RUNTIME_MODE" in
    semigraph)
      info "启动 Runtime — SemiGraph 模式 ..."
      if [ ! -f "$venv_python" ]; then
        error "Python 虚拟环境不存在: $runtime_dir/.venv"
        error "请先运行: bash infra/scripts/install-local.sh"
        exit 1
      fi
      cd "$runtime_dir"
      nohup "$venv_python" -m src.main > "$LOG_DIR/runtime.log" 2>&1 &
      info "SemiGraph Runtime 启动中 ..."
      ;;

    openclaw)
      info "启动 Runtime — OpenClaw Bridge 模式 ..."
      local bridge_dir="$runtime_dir/openclaw-bridge"
      if [ ! -d "$bridge_dir" ]; then
        error "OpenClaw Bridge 目录不存在: $bridge_dir"
        exit 1
      fi
      cd "$bridge_dir"
      nohup pnpm dev > "$LOG_DIR/runtime.log" 2>&1 &
      info "OpenClaw Bridge 启动中 ..."
      ;;

    *)
      error "未知 Runtime 模式: $RUNTIME_MODE"
      echo "  可选: semigraph | openclaw"
      exit 1
      ;;
  esac
}

# =============================================================================
# 停止所有服务
# =============================================================================
stop_all() {
  echo -e "\n${CYAN}${BOLD}停止 Semibot 服务${NC}\n"

  for service in api web runtime; do
    local port
    port="$(get_service_port "$service")"
    if is_port_listening "$port"; then
      kill_port "$port"
      info "$service 已停止 (port $port)"
    else
      info "$service 未在运行"
    fi
  done

  echo ""
  echo -n -e "${BOLD}是否同时停止 PostgreSQL/Redis 容器? (y/N): ${NC}"
  read -r answer
  if [[ "$answer" =~ ^[Yy]$ ]]; then
    docker stop semibot-postgres semibot-redis 2>/dev/null || true
    info "基础设施容器已停止"
  fi
  echo ""
}

# =============================================================================
# 服务状态
# =============================================================================
show_status() {
  echo -e "\n${CYAN}${BOLD}Semibot 服务状态${NC}\n"

  # 应用服务 — 基于端口检测
  for service in api web runtime; do
    local port
    port="$(get_service_port "$service")"
    if is_port_listening "$port"; then
      local pids
      pids="$(get_port_pids "$port" | tr '\n' ',' | sed 's/,$//')"
      echo -e "  ${GREEN}●${NC} $service  ${DIM}port $port  PID $pids${NC}"
    else
      echo -e "  ${RED}○${NC} $service  ${DIM}未运行${NC}"
    fi
  done

  echo ""

  # 基础设施
  for container in semibot-postgres semibot-redis; do
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "$container"; then
      echo -e "  ${GREEN}●${NC} $container  ${DIM}running${NC}"
    else
      echo -e "  ${RED}○${NC} $container  ${DIM}stopped${NC}"
    fi
  done

  echo ""
}

# =============================================================================
# 查看日志
# =============================================================================
tail_logs() {
  local service="${1:-all}"
  mkdir -p "$LOG_DIR"

  if [ "$service" = "all" ]; then
    info "合并日志输出 (Ctrl+C 退出)"
    tail -f "$LOG_DIR"/*.log 2>/dev/null || warn "暂无日志文件"
  else
    local log_file="$LOG_DIR/$service.log"
    if [ -f "$log_file" ]; then
      tail -f "$log_file"
    else
      warn "日志文件不存在: $log_file"
    fi
  fi
}

# =============================================================================
# 等待服务就绪
# =============================================================================
wait_for_services() {
  echo ""
  info "等待服务就绪 ..."
  sleep 3

  local all_ok=true

  # API
  if [[ "$SERVICES" == "all" || "$SERVICES" == "api" ]]; then
    local retries=0
    while ! curl -sf --max-time 2 "http://localhost:${API_PORT:-3001}/health" &>/dev/null; do
      sleep 1
      ((retries++))
      if [ $retries -ge 20 ]; then
        warn "API 未响应 — 查看日志: $0 logs api"
        all_ok=false
        break
      fi
    done
    if [ $retries -lt 20 ]; then
      info "API 就绪 ✓"
    fi
  fi

  # Web
  if [[ "$SERVICES" == "all" || "$SERVICES" == "web" ]]; then
    local retries=0
    while ! curl -sf --max-time 2 "http://localhost:${WEB_PORT:-3000}" &>/dev/null; do
      sleep 1
      ((retries++))
      if [ $retries -ge 30 ]; then
        warn "Web 未响应 — 查看日志: $0 logs web"
        all_ok=false
        break
      fi
    done
    if [ $retries -lt 30 ]; then
      info "Web 就绪 ✓"
    fi
  fi

  if [ "$all_ok" = true ]; then
    echo ""
    echo -e "${GREEN}${BOLD}所有服务已就绪!${NC}"
    echo ""
    echo -e "  Web:     ${BOLD}http://localhost:${WEB_PORT:-3000}${NC}"
    echo -e "  API:     ${BOLD}http://localhost:${API_PORT:-3001}${NC}"
    echo -e "  Runtime: ${BOLD}$RUNTIME_MODE${NC}"
    echo ""
    echo -e "  查看状态: ${DIM}$0 status${NC}"
    echo -e "  查看日志: ${DIM}$0 logs [api|web|runtime]${NC}"
    echo -e "  停止服务: ${DIM}$0 stop${NC}"
    echo ""
  fi
}

# =============================================================================
# Main
# =============================================================================
main() {
  parse_args "$@"
  load_env

  echo -e "\n${CYAN}${BOLD}╔═══════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}${BOLD}║   Semibot 本地开发启动                    ║${NC}"
  echo -e "${CYAN}${BOLD}║   Runtime: $(printf '%-30s' "$RUNTIME_MODE")  ║${NC}"
  echo -e "${CYAN}${BOLD}╚═══════════════════════════════════════════╝${NC}"
  echo ""

  case "$SERVICES" in
    all)
      start_infra
      start_api
      start_web
      start_runtime
      wait_for_services
      ;;
    api)
      start_infra
      start_api
      wait_for_services
      ;;
    web)
      start_web
      wait_for_services
      ;;
    runtime)
      start_infra
      start_runtime
      ;;
    infra)
      start_infra
      ;;
    *)
      error "未知服务: $SERVICES"
      usage
      exit 1
      ;;
  esac
}

main "$@"
