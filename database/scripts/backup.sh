#!/bin/bash
# ============================================================================
# backup.sh
# 数据库备份脚本
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
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

# 时间戳格式
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/${DB_NAME}_${TIMESTAMP}.sql.gz"

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

数据库备份脚本

选项:
    -h, --host      数据库主机 (默认: localhost)
    -p, --port      数据库端口 (默认: 5432)
    -d, --database  数据库名称 (默认: semibot)
    -u, --user      数据库用户 (默认: postgres)
    -o, --output    备份目录 (默认: ./backups)
    -r, --retention 备份保留天数 (默认: 30)
    --help          显示帮助信息

环境变量:
    DB_HOST, DB_PORT, DB_NAME, DB_USER, BACKUP_DIR, BACKUP_RETENTION_DAYS
    PGPASSWORD (用于自动认证)

示例:
    $0
    $0 -h db.example.com -d mydb -u admin
    PGPASSWORD=secret $0 -h production.db.com
EOF
}

# ----------------------------------------------------------------------------
# 参数解析
# ----------------------------------------------------------------------------

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
            BACKUP_DIR="$2"
            shift 2
            ;;
        -r|--retention)
            BACKUP_RETENTION_DAYS="$2"
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

# ----------------------------------------------------------------------------
# 主逻辑
# ----------------------------------------------------------------------------

log_info "开始备份数据库..."
log_info "数据库: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

# 创建备份目录
if [ ! -d "$BACKUP_DIR" ]; then
    log_info "创建备份目录: ${BACKUP_DIR}"
    mkdir -p "$BACKUP_DIR"
fi

# 检查 pg_dump 是否可用
if ! command -v pg_dump &> /dev/null; then
    log_error "pg_dump 命令不可用，请确保 PostgreSQL 客户端已安装"
    exit 1
fi

# 执行备份
log_info "执行 pg_dump..."
log_info "备份文件: ${BACKUP_FILE}"

if pg_dump \
    -h "$DB_HOST" \
    -p "$DB_PORT" \
    -U "$DB_USER" \
    -d "$DB_NAME" \
    --format=plain \
    --no-owner \
    --no-acl \
    --clean \
    --if-exists \
    | gzip > "$BACKUP_FILE"; then

    # 获取文件大小
    BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    log_success "备份完成: ${BACKUP_FILE} (${BACKUP_SIZE})"
else
    log_error "备份失败"
    rm -f "$BACKUP_FILE"
    exit 1
fi

# 清理旧备份
log_info "清理 ${BACKUP_RETENTION_DAYS} 天前的旧备份..."
DELETED_COUNT=$(find "$BACKUP_DIR" -name "${DB_NAME}_*.sql.gz" -type f -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete | wc -l)

if [ "$DELETED_COUNT" -gt 0 ]; then
    log_info "已删除 ${DELETED_COUNT} 个旧备份文件"
else
    log_info "没有需要清理的旧备份"
fi

# 显示当前备份列表
log_info "当前备份列表:"
ls -lh "$BACKUP_DIR"/${DB_NAME}_*.sql.gz 2>/dev/null | tail -10 || log_info "  (无备份文件)"

log_success "备份任务完成"
