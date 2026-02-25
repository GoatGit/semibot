#!/bin/bash
# =============================================================================
# Semibot - 数据库迁移脚本
# 按顺序执行 database/migrations/ 下的 SQL 文件
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIGRATIONS_DIR="$PROJECT_ROOT/database/migrations"

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

# 加载环境变量
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
    error "未找到 .env.local 或 .env，请先运行 setup-env.sh"
    exit 1
  fi
}

# 检查 psql 可用
check_psql() {
  if ! command -v psql &>/dev/null; then
    error "psql 未安装"
    echo "  macOS:  brew install postgresql"
    echo "  Ubuntu: sudo apt install postgresql-client"
    exit 1
  fi
}

# 构建连接参数
get_pg_args() {
  local db_user="${POSTGRES_USER:-semibot}"
  local db_pass="${POSTGRES_PASSWORD:-}"
  local db_name="${POSTGRES_DB:-semibot}"
  local db_host="${POSTGRES_HOST:-localhost}"
  local db_port="${POSTGRES_PORT:-5432}"

  export PGPASSWORD="$db_pass"
  PG_ARGS="-h $db_host -p $db_port -U $db_user -d $db_name"
}

# 创建迁移追踪表
ensure_migration_table() {
  psql $PG_ARGS -q <<'SQL'
CREATE TABLE IF NOT EXISTS _migrations (
  id          SERIAL PRIMARY KEY,
  filename    TEXT NOT NULL UNIQUE,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL
}

# 获取已执行的迁移
get_applied() {
  psql $PG_ARGS -t -A -c "SELECT filename FROM _migrations ORDER BY filename;" 2>/dev/null || echo ""
}

# 执行迁移
run_migrations() {
  local applied
  applied="$(get_applied)"
  local count=0
  local failed=0

  if [ ! -d "$MIGRATIONS_DIR" ]; then
    error "迁移目录不存在: $MIGRATIONS_DIR"
    exit 1
  fi

  local files
  files=$(find "$MIGRATIONS_DIR" -name '*.sql' -type f | sort)

  if [ -z "$files" ]; then
    info "没有迁移文件"
    return
  fi

  for file in $files; do
    local filename
    filename="$(basename "$file")"

    if echo "$applied" | grep -qF "$filename"; then
      echo -e "  ${GREEN}✓${NC} $filename (已执行)"
      continue
    fi

    echo -n -e "  ${CYAN}→${NC} $filename ... "

    if psql $PG_ARGS -v ON_ERROR_STOP=1 -q -f "$file" 2>/tmp/semibot_migrate_err; then
      psql $PG_ARGS -q -c "INSERT INTO _migrations (filename) VALUES ('$filename');"
      echo -e "${GREEN}OK${NC}"
      ((count++))
    else
      echo -e "${RED}FAILED${NC}"
      cat /tmp/semibot_migrate_err
      ((failed++))
      error "迁移失败，已停止"
      exit 1
    fi
  done

  echo ""
  if [ $count -gt 0 ]; then
    info "成功执行 $count 个迁移"
  else
    info "数据库已是最新状态"
  fi
}

# 显示迁移状态
show_status() {
  local applied
  applied="$(get_applied)"

  echo -e "\n${CYAN}${BOLD}迁移状态${NC}\n"

  for file in $(find "$MIGRATIONS_DIR" -name '*.sql' -type f | sort); do
    local filename
    filename="$(basename "$file")"

    if echo "$applied" | grep -qF "$filename"; then
      echo -e "  ${GREEN}✓${NC} $filename"
    else
      echo -e "  ${YELLOW}○${NC} $filename (待执行)"
    fi
  done
  echo ""
}

# 重置数据库（危险操作）
reset_db() {
  local db_name="${POSTGRES_DB:-semibot}"
  warn "即将删除并重建数据库: $db_name"
  echo -n -e "${RED}${BOLD}确认? 输入数据库名称: ${NC}"
  read -r confirm
  if [ "$confirm" != "$db_name" ]; then
    info "已取消"
    exit 0
  fi

  local db_user="${POSTGRES_USER:-semibot}"
  local db_host="${POSTGRES_HOST:-localhost}"
  local db_port="${POSTGRES_PORT:-5432}"

  psql -h "$db_host" -p "$db_port" -U "$db_user" -d postgres -c "DROP DATABASE IF EXISTS \"$db_name\";"
  psql -h "$db_host" -p "$db_port" -U "$db_user" -d postgres -c "CREATE DATABASE \"$db_name\";"
  info "数据库已重建"

  ensure_migration_table
  run_migrations
}

# =============================================================================
usage() {
  echo "用法: $0 {migrate|status|reset}"
  echo ""
  echo "  migrate  执行待处理的迁移 (默认)"
  echo "  status   显示迁移状态"
  echo "  reset    删除并重建数据库 (危险!)"
}

main() {
  local command="${1:-migrate}"

  load_env
  check_psql
  get_pg_args

  case "$command" in
    migrate)
      echo -e "\n${CYAN}${BOLD}Semibot 数据库迁移${NC}\n"
      ensure_migration_table
      run_migrations
      ;;
    status)
      ensure_migration_table
      show_status
      ;;
    reset)
      reset_db
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
