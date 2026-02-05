#!/bin/bash
# ============================================================================
# init.sh
# 数据库初始化脚本
# ============================================================================

set -euo pipefail

# ----------------------------------------------------------------------------
# 配置变量（可通过环境变量覆盖）
# ----------------------------------------------------------------------------
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-semibot}"
DB_USER="${DB_USER:-postgres}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MIGRATIONS_DIR="${PROJECT_ROOT}/database/migrations"
SEEDS_DIR="${PROJECT_ROOT}/database/seeds"

# ----------------------------------------------------------------------------
# 函数定义
# ----------------------------------------------------------------------------

log_info() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [INFO] $1"
}

log_error() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [ERROR] $1" >&2
}

log_success() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [SUCCESS] $1"
}

log_warn() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [WARN] $1"
}

show_usage() {
    cat << EOF
用法: $0 [选项]

数据库初始化脚本

选项:
    -h, --host      数据库主机 (默认: localhost)
    -p, --port      数据库端口 (默认: 5432)
    -d, --database  数据库名称 (默认: semibot)
    -u, --user      数据库用户 (默认: postgres)
    -e, --env       环境 (dev/prod，默认: dev)
    --seed-only     仅执行种子数据，跳过迁移
    --migrate-only  仅执行迁移，跳过种子数据
    --drop          先删除现有数据库（危险操作）
    --help          显示帮助信息

环境变量:
    DB_HOST, DB_PORT, DB_NAME, DB_USER
    PGPASSWORD (用于自动认证)

示例:
    $0                           # 执行迁移和开发环境种子数据
    $0 -e prod                   # 仅执行迁移（生产环境）
    $0 --seed-only -e dev        # 仅导入开发种子数据
    $0 --drop -e dev             # 重置数据库并重新初始化
EOF
}

execute_sql_file() {
    local file="$1"
    local filename=$(basename "$file")

    log_info "执行: ${filename}"

    if psql \
        -h "$DB_HOST" \
        -p "$DB_PORT" \
        -U "$DB_USER" \
        -d "$DB_NAME" \
        -f "$file" \
        --quiet \
        --set ON_ERROR_STOP=1; then
        log_success "  完成: ${filename}"
        return 0
    else
        log_error "  失败: ${filename}"
        return 1
    fi
}

run_migrations() {
    log_info "=========================================="
    log_info "执行数据库迁移..."
    log_info "=========================================="

    if [ ! -d "$MIGRATIONS_DIR" ]; then
        log_error "迁移目录不存在: ${MIGRATIONS_DIR}"
        exit 1
    fi

    local migration_files=($(find "$MIGRATIONS_DIR" -name "*.sql" -type f | sort))
    local migration_count=${#migration_files[@]}

    if [ "$migration_count" -eq 0 ]; then
        log_warn "没有找到迁移文件"
        return 0
    fi

    log_info "找到 ${migration_count} 个迁移文件"

    for file in "${migration_files[@]}"; do
        execute_sql_file "$file" || exit 1
    done

    log_success "所有迁移执行完成"
}

run_seeds() {
    local env="$1"
    local seed_dir="${SEEDS_DIR}/${env}"

    log_info "=========================================="
    log_info "导入种子数据 (环境: ${env})..."
    log_info "=========================================="

    if [ ! -d "$seed_dir" ]; then
        log_warn "种子数据目录不存在: ${seed_dir}"
        return 0
    fi

    local seed_files=($(find "$seed_dir" -name "*.sql" -type f | sort))
    local seed_count=${#seed_files[@]}

    if [ "$seed_count" -eq 0 ]; then
        log_warn "没有找到种子数据文件"
        return 0
    fi

    log_info "找到 ${seed_count} 个种子数据文件"

    for file in "${seed_files[@]}"; do
        execute_sql_file "$file" || exit 1
    done

    log_success "种子数据导入完成"
}

drop_database() {
    log_warn "=========================================="
    log_warn "删除现有数据库: ${DB_NAME}"
    log_warn "=========================================="

    # 终止现有连接
    log_info "终止现有数据库连接..."
    psql \
        -h "$DB_HOST" \
        -p "$DB_PORT" \
        -U "$DB_USER" \
        -d "postgres" \
        -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();" \
        --quiet || true

    # 删除数据库
    log_info "删除数据库..."
    psql \
        -h "$DB_HOST" \
        -p "$DB_PORT" \
        -U "$DB_USER" \
        -d "postgres" \
        -c "DROP DATABASE IF EXISTS ${DB_NAME};" \
        --quiet

    # 创建数据库
    log_info "创建新数据库..."
    psql \
        -h "$DB_HOST" \
        -p "$DB_PORT" \
        -U "$DB_USER" \
        -d "postgres" \
        -c "CREATE DATABASE ${DB_NAME};" \
        --quiet

    log_success "数据库已重新创建"
}

check_database_exists() {
    psql \
        -h "$DB_HOST" \
        -p "$DB_PORT" \
        -U "$DB_USER" \
        -d "postgres" \
        -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}';" 2>/dev/null | grep -q 1
}

create_database_if_not_exists() {
    if ! check_database_exists; then
        log_info "数据库不存在，创建: ${DB_NAME}"
        psql \
            -h "$DB_HOST" \
            -p "$DB_PORT" \
            -U "$DB_USER" \
            -d "postgres" \
            -c "CREATE DATABASE ${DB_NAME};" \
            --quiet
        log_success "数据库已创建"
    fi
}

# ----------------------------------------------------------------------------
# 参数解析
# ----------------------------------------------------------------------------

ENV="dev"
SEED_ONLY=false
MIGRATE_ONLY=false
DROP_DB=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--host)
            DB_HOST="$2"
            shift 2
            ;;
        -p|--port)
            DB_PORT="$2"
            shift 2
            ;;
        -d|--database)
            DB_NAME="$2"
            shift 2
            ;;
        -u|--user)
            DB_USER="$2"
            shift 2
            ;;
        -e|--env)
            ENV="$2"
            shift 2
            ;;
        --seed-only)
            SEED_ONLY=true
            shift
            ;;
        --migrate-only)
            MIGRATE_ONLY=true
            shift
            ;;
        --drop)
            DROP_DB=true
            shift
            ;;
        --help)
            show_usage
            exit 0
            ;;
        *)
            log_error "未知选项: $1"
            show_usage
            exit 1
            ;;
    esac
done

# ----------------------------------------------------------------------------
# 主逻辑
# ----------------------------------------------------------------------------

log_info "=========================================="
log_info "Semibot 数据库初始化"
log_info "=========================================="
log_info "数据库: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
log_info "环境: ${ENV}"

# 检查 psql 是否可用
if ! command -v psql &> /dev/null; then
    log_error "psql 命令不可用，请确保 PostgreSQL 客户端已安装"
    exit 1
fi

# 删除数据库（如果指定）
if [ "$DROP_DB" = true ]; then
    read -p "确认删除数据库 ${DB_NAME}? (y/N): " confirm
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
        drop_database
    else
        log_info "取消操作"
        exit 0
    fi
else
    create_database_if_not_exists
fi

# 执行迁移
if [ "$SEED_ONLY" = false ]; then
    run_migrations
fi

# 导入种子数据（仅开发环境或明确指定）
if [ "$MIGRATE_ONLY" = false ]; then
    if [ "$ENV" = "prod" ]; then
        log_warn "生产环境默认不导入种子数据"
        log_warn "如需导入，请使用 --seed-only -e prod"
    else
        run_seeds "$ENV"
    fi
fi

log_info "=========================================="
log_success "数据库初始化完成"
log_info "=========================================="

# 显示表统计
log_info "数据库表统计:"
psql \
    -h "$DB_HOST" \
    -p "$DB_PORT" \
    -U "$DB_USER" \
    -d "$DB_NAME" \
    -c "SELECT schemaname, tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;" \
    --quiet 2>/dev/null || log_warn "  (无法获取表信息)"
