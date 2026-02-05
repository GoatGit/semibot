#!/bin/bash
# ============================================================================
# archive_old_data.sh
# 数据归档脚本
# ============================================================================

set -euo pipefail

# ----------------------------------------------------------------------------
# 配置变量
# ----------------------------------------------------------------------------
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-semibot}"
DB_USER="${DB_USER:-postgres}"
ARCHIVE_DIR="${ARCHIVE_DIR:-./archives}"
RETENTION_MONTHS="${RETENTION_MONTHS:-12}"

# 需要归档的表
ARCHIVE_TABLES=(
    "messages"
    "execution_logs"
    "api_key_logs"
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

log_warn() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [WARN] $1"
}

show_usage() {
    cat << EOF
用法: $0 [选项]

数据归档脚本

选项:
    -h, --host        数据库主机 (默认: localhost)
    -p, --port        数据库端口 (默认: 5432)
    -d, --database    数据库名称 (默认: semibot)
    -u, --user        数据库用户 (默认: postgres)
    -o, --output      归档目录 (默认: ./archives)
    -r, --retention   保留月数 (默认: 12)
    --table           指定表名（可多次使用）
    --dry-run         仅显示将要执行的操作
    --delete          归档后删除源数据
    --help            显示帮助信息

示例:
    $0                           # 归档超过 12 个月的数据
    $0 -r 6 --delete             # 归档超过 6 个月的数据并删除
    $0 --dry-run                 # 预览将要归档的数据
EOF
}

get_archive_date() {
    # 计算归档截止日期
    date -v-${RETENTION_MONTHS}m +"%Y-%m-%d" 2>/dev/null || \
    date -d "${RETENTION_MONTHS} months ago" +"%Y-%m-%d"
}

count_archive_rows() {
    local table="$1"
    local archive_date="$2"

    psql \
        -h "$DB_HOST" \
        -p "$DB_PORT" \
        -U "$DB_USER" \
        -d "$DB_NAME" \
        -tAc "SELECT COUNT(*) FROM ${table} WHERE created_at < '${archive_date}'::timestamptz;" 2>/dev/null
}

archive_table() {
    local table="$1"
    local archive_date="$2"
    local output_file="${ARCHIVE_DIR}/${table}_$(date +%Y%m%d_%H%M%S).csv.gz"

    local row_count
    row_count=$(count_archive_rows "$table" "$archive_date")

    if [ "$row_count" -eq 0 ]; then
        log_info "表 ${table}: 无需归档的数据"
        return 0
    fi

    log_info "表 ${table}: 发现 ${row_count} 行需要归档 (< ${archive_date})"

    if [ "$DRY_RUN" = true ]; then
        log_info "  [DRY-RUN] 将导出到: ${output_file}"
        return 0
    fi

    # 导出数据
    log_info "  导出数据到: ${output_file}"
    psql \
        -h "$DB_HOST" \
        -p "$DB_PORT" \
        -U "$DB_USER" \
        -d "$DB_NAME" \
        -c "\\COPY (SELECT * FROM ${table} WHERE created_at < '${archive_date}'::timestamptz) TO STDOUT WITH CSV HEADER" \
        | gzip > "$output_file"

    local file_size
    file_size=$(du -h "$output_file" | cut -f1)
    log_success "  导出完成: ${output_file} (${file_size})"

    # 删除源数据（如果指定）
    if [ "$DELETE_AFTER_ARCHIVE" = true ]; then
        log_warn "  删除源数据..."
        local deleted
        deleted=$(psql \
            -h "$DB_HOST" \
            -p "$DB_PORT" \
            -U "$DB_USER" \
            -d "$DB_NAME" \
            -tAc "DELETE FROM ${table} WHERE created_at < '${archive_date}'::timestamptz RETURNING 1;" | wc -l)
        log_success "  已删除 ${deleted} 行"
    fi
}

# ----------------------------------------------------------------------------
# 参数解析
# ----------------------------------------------------------------------------

CUSTOM_TABLES=()
DRY_RUN=false
DELETE_AFTER_ARCHIVE=false

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
        -o|--output)
            ARCHIVE_DIR="$2"
            shift 2
            ;;
        -r|--retention)
            RETENTION_MONTHS="$2"
            shift 2
            ;;
        --table)
            CUSTOM_TABLES+=("$2")
            shift 2
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --delete)
            DELETE_AFTER_ARCHIVE=true
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

# 如果指定了自定义表，使用自定义表列表
if [ ${#CUSTOM_TABLES[@]} -gt 0 ]; then
    ARCHIVE_TABLES=("${CUSTOM_TABLES[@]}")
fi

# ----------------------------------------------------------------------------
# 主逻辑
# ----------------------------------------------------------------------------

log_info "=========================================="
log_info "Semibot 数据归档脚本"
log_info "=========================================="
log_info "数据库: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
log_info "保留月数: ${RETENTION_MONTHS}"
log_info "归档目录: ${ARCHIVE_DIR}"
log_info "Dry Run: ${DRY_RUN}"
log_info "删除源数据: ${DELETE_AFTER_ARCHIVE}"

# 检查 psql 是否可用
if ! command -v psql &> /dev/null; then
    log_error "psql 命令不可用，请确保 PostgreSQL 客户端已安装"
    exit 1
fi

# 创建归档目录
if [ "$DRY_RUN" = false ] && [ ! -d "$ARCHIVE_DIR" ]; then
    log_info "创建归档目录: ${ARCHIVE_DIR}"
    mkdir -p "$ARCHIVE_DIR"
fi

# 计算归档截止日期
ARCHIVE_DATE=$(get_archive_date)
log_info "归档截止日期: ${ARCHIVE_DATE}"

# 确认删除操作
if [ "$DELETE_AFTER_ARCHIVE" = true ] && [ "$DRY_RUN" = false ]; then
    log_warn "=========================================="
    log_warn "警告：归档后将删除源数据！"
    log_warn "=========================================="
    read -p "确认继续? (y/N): " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        log_info "取消操作"
        exit 0
    fi
fi

# 归档每个表
for table in "${ARCHIVE_TABLES[@]}"; do
    archive_table "$table" "$ARCHIVE_DATE" || true
done

# 显示归档文件列表
if [ "$DRY_RUN" = false ] && [ -d "$ARCHIVE_DIR" ]; then
    log_info "当前归档文件:"
    ls -lh "$ARCHIVE_DIR"/*.csv.gz 2>/dev/null | tail -10 || log_info "  (无归档文件)"
fi

log_info "=========================================="
log_success "归档任务完成"
log_info "=========================================="
