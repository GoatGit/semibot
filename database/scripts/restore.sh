#!/bin/bash
# ============================================================================
# restore.sh
# 数据库恢复脚本
# ============================================================================

set -euo pipefail

# ----------------------------------------------------------------------------
# 配置变量（可通过环境变量覆盖）
# ----------------------------------------------------------------------------
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-semibot}"
DB_USER="${DB_USER:-postgres}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"

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
用法: $0 [选项] <备份文件>

数据库恢复脚本

选项:
    -h, --host      数据库主机 (默认: localhost)
    -p, --port      数据库端口 (默认: 5432)
    -d, --database  数据库名称 (默认: semibot)
    -u, --user      数据库用户 (默认: postgres)
    -l, --list      列出可用的备份文件
    --latest        使用最新的备份文件
    --force         跳过确认提示
    --help          显示帮助信息

环境变量:
    DB_HOST, DB_PORT, DB_NAME, DB_USER, BACKUP_DIR
    PGPASSWORD (用于自动认证)

示例:
    $0 --list
    $0 --latest
    $0 backups/semibot_20240101_120000.sql.gz
    $0 --force --latest
EOF
}

list_backups() {
    log_info "可用的备份文件 (${BACKUP_DIR}):"
    echo ""
    if ls "$BACKUP_DIR"/${DB_NAME}_*.sql.gz 1>/dev/null 2>&1; then
        ls -lht "$BACKUP_DIR"/${DB_NAME}_*.sql.gz | head -20
        echo ""
        BACKUP_COUNT=$(ls "$BACKUP_DIR"/${DB_NAME}_*.sql.gz 2>/dev/null | wc -l)
        log_info "共 ${BACKUP_COUNT} 个备份文件"
    else
        log_warn "没有找到备份文件"
    fi
}

get_latest_backup() {
    ls -t "$BACKUP_DIR"/${DB_NAME}_*.sql.gz 2>/dev/null | head -1
}

# ----------------------------------------------------------------------------
# 参数解析
# ----------------------------------------------------------------------------

BACKUP_FILE=""
LIST_MODE=false
USE_LATEST=false
FORCE_MODE=false

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
        -l|--list)
            LIST_MODE=true
            shift
            ;;
        --latest)
            USE_LATEST=true
            shift
            ;;
        --force)
            FORCE_MODE=true
            shift
            ;;
        --help)
            show_usage
            exit 0
            ;;
        -*)
            log_error "未知选项: $1"
            show_usage
            exit 1
            ;;
        *)
            BACKUP_FILE="$1"
            shift
            ;;
    esac
done

# ----------------------------------------------------------------------------
# 主逻辑
# ----------------------------------------------------------------------------

# 列表模式
if [ "$LIST_MODE" = true ]; then
    list_backups
    exit 0
fi

# 确定备份文件
if [ "$USE_LATEST" = true ]; then
    BACKUP_FILE=$(get_latest_backup)
    if [ -z "$BACKUP_FILE" ]; then
        log_error "没有找到可用的备份文件"
        exit 1
    fi
    log_info "使用最新备份: ${BACKUP_FILE}"
fi

# 验证备份文件
if [ -z "$BACKUP_FILE" ]; then
    log_error "请指定备份文件或使用 --latest 选项"
    show_usage
    exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
    log_error "备份文件不存在: ${BACKUP_FILE}"
    exit 1
fi

# 显示恢复信息
log_info "准备恢复数据库..."
log_info "目标数据库: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
log_info "备份文件: ${BACKUP_FILE}"

# 获取备份文件信息
BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
BACKUP_DATE=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "$BACKUP_FILE" 2>/dev/null || stat -c "%y" "$BACKUP_FILE" 2>/dev/null | cut -d'.' -f1)
log_info "备份大小: ${BACKUP_SIZE}"
log_info "备份时间: ${BACKUP_DATE}"

# 确认操作
if [ "$FORCE_MODE" = false ]; then
    echo ""
    log_warn "⚠️  警告: 此操作将覆盖目标数据库中的所有数据！"
    echo ""
    read -p "确认要继续吗? (输入 'yes' 确认): " CONFIRM

    if [ "$CONFIRM" != "yes" ]; then
        log_info "操作已取消"
        exit 0
    fi
fi

# 检查 psql 是否可用
if ! command -v psql &> /dev/null; then
    log_error "psql 命令不可用，请确保 PostgreSQL 客户端已安装"
    exit 1
fi

# 执行恢复
log_info "开始恢复数据库..."

if [[ "$BACKUP_FILE" == *.gz ]]; then
    # 压缩文件
    if gunzip -c "$BACKUP_FILE" | psql \
        -h "$DB_HOST" \
        -p "$DB_PORT" \
        -U "$DB_USER" \
        -d "$DB_NAME" \
        --quiet \
        -v ON_ERROR_STOP=1; then

        log_success "数据库恢复完成"
    else
        log_error "数据库恢复失败"
        exit 1
    fi
else
    # 非压缩文件
    if psql \
        -h "$DB_HOST" \
        -p "$DB_PORT" \
        -U "$DB_USER" \
        -d "$DB_NAME" \
        --quiet \
        -v ON_ERROR_STOP=1 \
        -f "$BACKUP_FILE"; then

        log_success "数据库恢复完成"
    else
        log_error "数据库恢复失败"
        exit 1
    fi
fi

# 显示恢复后的表信息
log_info "恢复后的表统计:"
psql \
    -h "$DB_HOST" \
    -p "$DB_PORT" \
    -U "$DB_USER" \
    -d "$DB_NAME" \
    -c "SELECT schemaname, tablename, n_tup_ins as rows FROM pg_stat_user_tables ORDER BY tablename;" \
    2>/dev/null || log_warn "无法获取表统计信息"

log_success "恢复任务完成"
