#!/bin/bash
# =============================================================================
# Semibot - 服务器/虚拟机完整安装脚本
# 适用于 Ubuntu 22.04+ / Debian 12+ 全新服务器
# 安装系统依赖、Node.js、pnpm、Python、Docker、Nginx、SSL、应用代码
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

# 默认参数
NODE_VERSION="20"
PYTHON_VERSION="3.11"
INSTALL_NGINX=true
INSTALL_SSL=false
DOMAIN=""
DEPLOY_USER="semibot"
DEPLOY_DIR="/opt/semibot"

# =============================================================================
# 参数解析
# =============================================================================
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --domain)
        DOMAIN="${2:-}"
        INSTALL_SSL=true
        shift 2
        ;;
      --no-nginx)
        INSTALL_NGINX=false
        shift
        ;;
      --deploy-dir)
        DEPLOY_DIR="${2:-/opt/semibot}"
        shift 2
        ;;
      --deploy-user)
        DEPLOY_USER="${2:-semibot}"
        shift 2
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
用法: sudo $0 [选项]

选项:
  --domain <domain>        域名 (启用 SSL 证书申请)
  --no-nginx               不安装 Nginx
  --deploy-dir <path>      部署目录 (默认: /opt/semibot)
  --deploy-user <user>     运行用户 (默认: semibot)

示例:
  sudo $0                                    基础安装
  sudo $0 --domain app.example.com           安装并配置 SSL
  sudo $0 --deploy-dir /home/app/semibot     自定义部署目录
EOF
}

# =============================================================================
# 0. 权限检查
# =============================================================================
check_root() {
  if [ "$(id -u)" -ne 0 ]; then
    error "请使用 sudo 运行此脚本"
    exit 1
  fi
}

check_os() {
  if [ ! -f /etc/os-release ]; then
    error "不支持的操作系统"
    exit 1
  fi
  source /etc/os-release
  if [[ "$ID" != "ubuntu" && "$ID" != "debian" ]]; then
    warn "此脚本针对 Ubuntu/Debian 优化，其他发行版可能需要调整"
  fi
  info "操作系统: $PRETTY_NAME"
}

# =============================================================================
# 1. 系统依赖
# =============================================================================
install_system_deps() {
  title "1/8 系统依赖"

  apt-get update -qq
  apt-get install -y -qq \
    curl wget git build-essential \
    ca-certificates gnupg lsb-release \
    software-properties-common \
    libpq-dev \
    unzip jq \
    > /dev/null

  info "系统依赖安装完成"
}

# =============================================================================
# 2. Docker
# =============================================================================
install_docker() {
  title "2/8 Docker"

  if command -v docker &>/dev/null; then
    info "Docker 已安装: $(docker --version)"
    return
  fi

  info "安装 Docker ..."
  curl -fsSL https://get.docker.com | sh

  # 添加部署用户到 docker 组
  if id "$DEPLOY_USER" &>/dev/null; then
    usermod -aG docker "$DEPLOY_USER"
  fi

  systemctl enable docker
  systemctl start docker
  info "Docker 安装完成"
}

# =============================================================================
# 3. Node.js + pnpm
# =============================================================================
install_nodejs() {
  title "3/8 Node.js $NODE_VERSION + pnpm"

  if command -v node &>/dev/null; then
    local ver
    ver="$(node -v | sed 's/v//' | cut -d. -f1)"
    if [ "$ver" -ge 20 ]; then
      info "Node.js 已安装: $(node -v)"
    else
      warn "Node.js 版本过低 ($ver)，重新安装 ..."
    fi
  fi

  if ! command -v node &>/dev/null || [ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y -qq nodejs > /dev/null
    info "Node.js $(node -v) 安装完成"
  fi

  # pnpm
  if ! command -v pnpm &>/dev/null; then
    corepack enable
    corepack prepare pnpm@9.0.0 --activate
  fi
  info "pnpm $(pnpm -v) 就绪"
}

# =============================================================================
# 4. Python
# =============================================================================
install_python() {
  title "4/8 Python $PYTHON_VERSION"

  local python_cmd=""
  for cmd in python3.11 python3.12 python3; do
    if command -v "$cmd" &>/dev/null; then
      local minor
      minor="$($cmd --version 2>&1 | awk '{print $2}' | cut -d. -f2)"
      if [ "$minor" -ge 11 ]; then
        python_cmd="$cmd"
        break
      fi
    fi
  done

  if [ -z "$python_cmd" ]; then
    info "安装 Python $PYTHON_VERSION ..."
    add-apt-repository -y ppa:deadsnakes/ppa 2>/dev/null || true
    apt-get update -qq
    apt-get install -y -qq \
      python${PYTHON_VERSION} \
      python${PYTHON_VERSION}-venv \
      python${PYTHON_VERSION}-dev \
      > /dev/null
    python_cmd="python${PYTHON_VERSION}"
  fi

  info "Python $($python_cmd --version) 就绪"
  PYTHON_CMD="$python_cmd"
}

# =============================================================================
# 5. 创建部署用户和目录
# =============================================================================
setup_deploy_user() {
  title "5/8 部署用户和目录"

  if ! id "$DEPLOY_USER" &>/dev/null; then
    useradd -r -m -s /bin/bash "$DEPLOY_USER"
    usermod -aG docker "$DEPLOY_USER" 2>/dev/null || true
    info "用户 $DEPLOY_USER 已创建"
  else
    info "用户 $DEPLOY_USER 已存在"
  fi

  mkdir -p "$DEPLOY_DIR"
  mkdir -p /var/lib/semibot/skills
  mkdir -p /var/log/semibot
  mkdir -p /tmp/semibot/chat-uploads

  chown -R "$DEPLOY_USER":"$DEPLOY_USER" "$DEPLOY_DIR"
  chown -R "$DEPLOY_USER":"$DEPLOY_USER" /var/lib/semibot
  chown -R "$DEPLOY_USER":"$DEPLOY_USER" /var/log/semibot
  chown -R "$DEPLOY_USER":"$DEPLOY_USER" /tmp/semibot

  info "目录结构就绪"
}

# =============================================================================
# 6. 安装应用代码和依赖
# =============================================================================
install_app() {
  title "6/8 应用代码和依赖"

  # 如果脚本从项目目录运行，复制代码到部署目录
  if [ "$PROJECT_ROOT" != "$DEPLOY_DIR" ]; then
    info "同步代码到 $DEPLOY_DIR ..."
    rsync -a --delete \
      --exclude node_modules \
      --exclude .venv \
      --exclude .next \
      --exclude dist \
      --exclude .pids \
      --exclude .logs \
      --exclude .env.local \
      --exclude .env \
      "$PROJECT_ROOT/" "$DEPLOY_DIR/"
    chown -R "$DEPLOY_USER":"$DEPLOY_USER" "$DEPLOY_DIR"
  fi

  # Node.js 依赖
  info "安装 Node.js 依赖 ..."
  su - "$DEPLOY_USER" -c "cd $DEPLOY_DIR && pnpm install --frozen-lockfile"

  # 构建 shared packages
  info "构建 shared packages ..."
  su - "$DEPLOY_USER" -c "cd $DEPLOY_DIR && pnpm --filter @semibot/shared-types build" 2>/dev/null || true
  su - "$DEPLOY_USER" -c "cd $DEPLOY_DIR && pnpm --filter @semibot/shared-config build" 2>/dev/null || true

  # 构建 API
  info "构建 API ..."
  su - "$DEPLOY_USER" -c "cd $DEPLOY_DIR && pnpm --filter @semibot/api build"

  # 构建 Web
  info "构建 Web ..."
  su - "$DEPLOY_USER" -c "cd $DEPLOY_DIR && pnpm --filter @semibot/web build"

  # Python 虚拟环境
  info "安装 Python 依赖 ..."
  local venv_dir="$DEPLOY_DIR/runtime/.venv"
  su - "$DEPLOY_USER" -c "$PYTHON_CMD -m venv $venv_dir"
  su - "$DEPLOY_USER" -c "$venv_dir/bin/pip install --upgrade pip -q"
  su - "$DEPLOY_USER" -c "$venv_dir/bin/pip install -r $DEPLOY_DIR/runtime/requirements.txt -q"

  # OpenClaw Bridge
  if [ -d "$DEPLOY_DIR/runtime/openclaw-bridge" ]; then
    info "构建 OpenClaw Bridge ..."
    su - "$DEPLOY_USER" -c "cd $DEPLOY_DIR/runtime/openclaw-bridge && pnpm install && pnpm build" 2>/dev/null || true
  fi

  info "应用构建完成"
}

# =============================================================================
# 7. Systemd 服务
# =============================================================================
setup_systemd() {
  title "7/8 Systemd 服务"

  # --- semibot-api ---
  cat > /etc/systemd/system/semibot-api.service << EOF
[Unit]
Description=Semibot API Server
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
User=$DEPLOY_USER
Group=$DEPLOY_USER
WorkingDirectory=$DEPLOY_DIR/apps/api
EnvironmentFile=$DEPLOY_DIR/.env.local
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/semibot/api.log
StandardError=append:/var/log/semibot/api.log

# 安全加固
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/semibot /tmp/semibot /var/log/semibot
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

  # --- semibot-web ---
  cat > /etc/systemd/system/semibot-web.service << EOF
[Unit]
Description=Semibot Web (Next.js)
After=semibot-api.service

[Service]
Type=simple
User=$DEPLOY_USER
Group=$DEPLOY_USER
WorkingDirectory=$DEPLOY_DIR/apps/web
EnvironmentFile=$DEPLOY_DIR/.env.local
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=/usr/bin/node .next/standalone/apps/web/server.js
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/semibot/web.log
StandardError=append:/var/log/semibot/web.log

NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/log/semibot
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

  # --- semibot-runtime (SemiGraph) ---
  cat > /etc/systemd/system/semibot-runtime.service << EOF
[Unit]
Description=Semibot Runtime (SemiGraph)
After=semibot-api.service

[Service]
Type=simple
User=$DEPLOY_USER
Group=$DEPLOY_USER
WorkingDirectory=$DEPLOY_DIR/runtime
EnvironmentFile=$DEPLOY_DIR/.env.local
Environment=PYTHONPATH=$DEPLOY_DIR/runtime
ExecStart=$DEPLOY_DIR/runtime/.venv/bin/python -m src.main
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/semibot/runtime.log
StandardError=append:/var/log/semibot/runtime.log

NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/semibot /tmp/semibot /var/log/semibot
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

  # --- semibot-openclaw (OpenClaw Bridge, 可选) ---
  cat > /etc/systemd/system/semibot-openclaw.service << EOF
[Unit]
Description=Semibot Runtime (OpenClaw Bridge)
After=semibot-api.service
Conflicts=semibot-runtime.service

[Service]
Type=simple
User=$DEPLOY_USER
Group=$DEPLOY_USER
WorkingDirectory=$DEPLOY_DIR/runtime/openclaw-bridge
EnvironmentFile=$DEPLOY_DIR/.env.local
ExecStart=/usr/bin/node dist/main.js
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/semibot/openclaw.log
StandardError=append:/var/log/semibot/openclaw.log

NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/semibot /tmp/semibot /var/log/semibot
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

  # --- 基础设施 (PostgreSQL + Redis via Docker) ---
  cat > /etc/systemd/system/semibot-infra.service << EOF
[Unit]
Description=Semibot Infrastructure (PostgreSQL + Redis)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
EnvironmentFile=$DEPLOY_DIR/.env.local
ExecStart=/bin/bash -c 'docker start semibot-postgres semibot-redis 2>/dev/null || $DEPLOY_DIR/infra/scripts/start-vm.sh infra'
ExecStop=/bin/bash -c 'docker stop semibot-postgres semibot-redis'

[Install]
WantedBy=multi-user.target
EOF

  # --- 聚合 target ---
  cat > /etc/systemd/system/semibot.target << EOF
[Unit]
Description=Semibot Full Stack
Requires=semibot-infra.service semibot-api.service semibot-web.service semibot-runtime.service
After=semibot-infra.service

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable semibot-infra semibot-api semibot-web semibot-runtime semibot.target

  info "Systemd 服务已配置"
  echo -e "  ${BOLD}semibot-api${NC}      API 服务"
  echo -e "  ${BOLD}semibot-web${NC}      Web 前端"
  echo -e "  ${BOLD}semibot-runtime${NC}  SemiGraph Runtime"
  echo -e "  ${BOLD}semibot-openclaw${NC} OpenClaw Bridge (可选，与 runtime 互斥)"
  echo -e "  ${BOLD}semibot-infra${NC}    PostgreSQL + Redis"
  echo -e "  ${BOLD}semibot.target${NC}   全部启动"
}

# =============================================================================
# 8. Nginx + SSL
# =============================================================================
setup_nginx() {
  title "8/8 Nginx"

  if [ "$INSTALL_NGINX" = false ]; then
    info "跳过 Nginx 安装"
    return
  fi

  if ! command -v nginx &>/dev/null; then
    apt-get install -y -qq nginx > /dev/null
  fi
  info "Nginx $(nginx -v 2>&1 | awk -F/ '{print $2}') 就绪"

  local server_name="${DOMAIN:-_}"

  cat > /etc/nginx/sites-available/semibot << NGINXEOF
upstream semibot_api {
    server 127.0.0.1:3001;
    keepalive 32;
}

upstream semibot_web {
    server 127.0.0.1:3000;
    keepalive 32;
}

server {
    listen 80;
    server_name $server_name;

    # 安全头
    add_header X-Frame-Options SAMEORIGIN always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Gzip
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml;
    gzip_min_length 1000;

    # API 路由
    location /api/ {
        proxy_pass http://semibot_api;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # SSE 支持
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # WebSocket 支持
    location /ws/ {
        proxy_pass http://semibot_api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 3600s;
    }

    # 前端
    location / {
        proxy_pass http://semibot_web;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # 健康检查
    location /nginx-health {
        return 200 'ok';
        add_header Content-Type text/plain;
    }

    # 上传大小限制
    client_max_body_size 50M;
}
NGINXEOF

  ln -sf /etc/nginx/sites-available/semibot /etc/nginx/sites-enabled/semibot
  rm -f /etc/nginx/sites-enabled/default

  nginx -t
  systemctl enable nginx
  systemctl reload nginx
  info "Nginx 配置完成"

  # SSL (Let's Encrypt)
  if [ "$INSTALL_SSL" = true ] && [ -n "$DOMAIN" ]; then
    info "申请 SSL 证书: $DOMAIN ..."
    if ! command -v certbot &>/dev/null; then
      apt-get install -y -qq certbot python3-certbot-nginx > /dev/null
    fi
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "admin@${DOMAIN}" || {
      warn "SSL 证书申请失败，请手动运行: certbot --nginx -d $DOMAIN"
    }
  fi
}

# =============================================================================
# Main
# =============================================================================
main() {
  parse_args "$@"
  check_root
  check_os

  echo -e "\n${CYAN}${BOLD}╔═══════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}${BOLD}║   Semibot 服务器安装                      ║${NC}"
  echo -e "${CYAN}${BOLD}║   部署目录: $(printf '%-29s' "$DEPLOY_DIR")  ║${NC}"
  echo -e "${CYAN}${BOLD}║   运行用户: $(printf '%-29s' "$DEPLOY_USER")  ║${NC}"
  echo -e "${CYAN}${BOLD}╚═══════════════════════════════════════════╝${NC}"

  install_system_deps
  install_docker
  install_nodejs
  install_python
  setup_deploy_user
  install_app
  setup_systemd
  setup_nginx

  echo ""
  title "安装完成!"
  echo -e "  下一步:"
  echo -e "    1. 配置环境变量:  ${BOLD}cp .env.example $DEPLOY_DIR/.env.local && vim $DEPLOY_DIR/.env.local${NC}"
  echo -e "       或交互式生成:  ${BOLD}bash $DEPLOY_DIR/infra/scripts/setup-env.sh${NC}"
  echo -e ""
  echo -e "    2. 初始化数据库:  ${BOLD}bash $DEPLOY_DIR/infra/scripts/migrate-db.sh${NC}"
  echo -e ""
  echo -e "    3. 启动服务:"
  echo -e "       全部启动:      ${BOLD}bash $DEPLOY_DIR/infra/scripts/start-vm.sh start${NC}"
  echo -e "       SemiGraph:     ${BOLD}bash $DEPLOY_DIR/infra/scripts/start-vm.sh start --runtime semigraph${NC}"
  echo -e "       OpenClaw:      ${BOLD}bash $DEPLOY_DIR/infra/scripts/start-vm.sh start --runtime openclaw${NC}"
  echo -e ""
  echo -e "    4. Systemd 管理:"
  echo -e "       ${BOLD}systemctl start semibot.target${NC}    启动全部"
  echo -e "       ${BOLD}systemctl status semibot-api${NC}      查看 API 状态"
  echo -e "       ${BOLD}journalctl -u semibot-api -f${NC}      查看 API 日志"
  echo ""
}

main "$@"
