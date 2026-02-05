#!/bin/bash
# ============================================================================
# create_partition.sh
# 自动创建分区脚本
# ============================================================================

set -euo pipefail

# ----------------------------------------------------------------------------
# 配置变量
# ----------------------------------------------------------------------------
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-semibot}"
DB_USER="${DB_USER:-postgres}"
MONTHS_AHEAD="${MONTHS_AHEAD:-3}"

# 需要分区的表
PARTITIONED_TABLES=(
    "messages_partitioned"
    "execution_logs_partitioned"
    "api_key_logs_partitioned"
)

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

show_usage() {
    cat << EOF
用法: $0 [选项]

自动创建分区脚本

选项:
    -h, --host      数据库主机 (默认: localhost)
    -p, --port      数据库端口 (默认: 5432)
    -d, --database  数据库名称 (默认: semibot)
    -u, --user      数据库用户 (默认: postgres)
    -m, --months    提前创建的月数 (默认: 3)
    --table         指定表名（可多次使用）
    --help          显示帮助信息

示例:
    $0                           # 为所有表创建未来 3 个月分区
    $0 -m 6                      # 创建未来 6 个月分区
    $0 --table messages_partitioned  # 仅为指定表创建分区
EOF
}

create_partitions() {
    local table="$1"
    local months="$2"

    log_info "为表 ${table} 创建未来 ${months} 个月的分区..."

    local result
    result=$(psql \
        -h "$DB_HOST" \
        -p "$DB_PORT" \
        -U "$DB_USER" \
        -d "$DB_NAME" \
        -tAc "SELECT create_future_partitions('${table}', ${months});" 2>&1)

    if [ $? -eq 0 ]; then
        log_success "表 ${table}: 创建了 ${result} 个分区"
    else
        log_error "表 ${table}: 创建分区失败 - ${result}"
        return 1
    fi
}

list_partitions() {
    log_info "当前分区列表:"
    psql \
        -h "$DB_HOST" \
        -p "$DB_PORT" \
        -U "$DB_USER" \
        -d "$DB_NAME" \
        -c "SELECT * FROM v_partition_stats ORDER BY parent_table, partition_name;" \
        2>/dev/null || log_info "  (无分区表或视图不存在)"
}

# ----------------------------------------------------------------------------
# 参数解析
# ----------------------------------------------------------------------------

CUSTOM_TABLES=()

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
        -m|--months)
            MONTHS_AHEAD="$2"
            shift 2
            ;;
        --table)
            CUSTOM_TABLES+=("$2")
            shift 2
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

# 如果指定了自定义表，使用自定义表列表
if [ ${#CUSTOM_TABLES[@]} -gt 0 ]; then
    PARTITIONED_TABLES=("${CUSTOM_TABLES[@]}")
fi

# ----------------------------------------------------------------------------
# 主逻辑
# ----------------------------------------------------------------------------

log_info "=========================================="
log_info "Semibot 分区管理脚本"
log_info "=========================================="
log_info "数据库: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
log_info "提前创建月数: ${MONTHS_AHEAD}"

# 检查 psql 是否可用
if ! command -v psql &> /dev/null; then
    log_error "psql 命令不可用，请确保 PostgreSQL 客户端已安装"
    exit 1
fi

# 为每个表创建分区
for table in "${PARTITIONED_TABLES[@]}"; do
    create_partitions "$table" "$MONTHS_AHEAD" || true
done

# 显示当前分区列表
list_partitions

log_info "=========================================="
log_success "分区管理完成"
log_info "=========================================="
