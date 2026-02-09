# 部署指南

本文档提供 Semibot-Z1 的完整部署指南，包括本地开发、Docker 部署和生产环境部署。

## 目录

- [环境要求](#环境要求)
- [本地开发部署](#本地开发部署)
- [Docker 部署](#docker-部署)
- [生产环境部署](#生产环境部署)
- [部署检查清单](#部署检查清单)
- [故障排除](#故障排除)

---

## 环境要求

### 基础依赖

| 组件 | 最低版本 | 推荐版本 |
|------|----------|----------|
| Node.js | 18.x | 20.x LTS |
| Python | 3.11 | 3.12 |
| PostgreSQL | 14 | 16 |
| Redis | 6.x | 7.x |
| pnpm | 8.x | 9.x |

### 可选组件

| 组件 | 用途 |
|------|------|
| Docker | 容器化部署 |
| Docker Compose | 多容器编排 |
| Nginx | 反向代理 |
| PM2 | 进程管理 |

---

## 本地开发部署

### 1. 克隆仓库

```bash
git clone https://github.com/your-org/semibot-z1.git
cd semibot-z1
```

### 2. 安装依赖

```bash
# 安装 Node.js 依赖
pnpm install

# 安装 Python 依赖
cd runtime
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cd ..
```

### 3. 配置环境变量

```bash
# 复制示例配置
cp .env.example .env
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
cp runtime/.env.example runtime/.env
```

编辑 `.env` 文件，配置以下必要变量：

```env
# 数据库
DATABASE_URL=postgresql://user:password@localhost:5432/semibot

# Redis
REDIS_URL=redis://localhost:6379

# JWT 密钥（生产环境必须使用强密钥）
JWT_SECRET=your-secret-key-at-least-32-chars

# LLM API Keys（至少配置一个）
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

### 4. 初始化数据库

```bash
# 运行数据库迁移
pnpm db:migrate

# 可选：运行种子数据
pnpm db:seed
```

### 5. 启动服务

```bash
# 启动所有服务（开发模式）
pnpm dev

# 或分别启动
pnpm --filter api dev     # API 服务 (端口 3001)
pnpm --filter web dev     # Web 前端 (端口 3000)
cd runtime && python -m src.main  # Runtime 服务 (端口 8000)
```

---

## Docker 部署

### 1. 构建镜像

```bash
# 构建所有服务镜像
docker-compose build

# 或单独构建
docker build -t semibot-api -f apps/api/Dockerfile .
docker build -t semibot-web -f apps/web/Dockerfile .
docker build -t semibot-runtime -f runtime/Dockerfile .
```

### 2. 配置 docker-compose.yml

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: semibot
      POSTGRES_USER: semibot
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U semibot"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  api:
    image: semibot-api
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://semibot:${DB_PASSWORD}@postgres:5432/semibot
      REDIS_URL: redis://redis:6379
      JWT_SECRET: ${JWT_SECRET}
      NODE_ENV: production
    ports:
      - "3001:3001"

  web:
    image: semibot-web
    depends_on:
      - api
    environment:
      NEXT_PUBLIC_API_URL: http://api:3001
    ports:
      - "3000:3000"

  runtime:
    image: semibot-runtime
    depends_on:
      - redis
    environment:
      REDIS_URL: redis://redis:6379
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
    ports:
      - "8000:8000"

volumes:
  postgres_data:
  redis_data:
```

### 3. 启动服务

```bash
# 启动所有服务
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
```

---

## 生产环境部署

### 1. 服务器准备

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx

# 安装 Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 安装 pnpm
npm install -g pnpm

# 安装 PM2
npm install -g pm2
```

### 2. Nginx 配置

```nginx
# /etc/nginx/sites-available/semibot
upstream api {
    server 127.0.0.1:3001;
}

upstream web {
    server 127.0.0.1:3000;
}

upstream runtime {
    server 127.0.0.1:8000;
}

server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # 前端
    location / {
        proxy_pass http://web;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    # API
    location /api/ {
        proxy_pass http://api/;
        proxy_http_version 1.1;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host $host;
    }

    # SSE 端点（需要特殊配置）
    location /api/v1/chat/ {
        proxy_pass http://api/v1/chat/;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        chunked_transfer_encoding off;
    }

    # Runtime WebSocket
    location /runtime/ {
        proxy_pass http://runtime/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
    }
}
```

### 3. PM2 进程管理

```javascript
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'semibot-api',
      cwd: './apps/api',
      script: 'dist/index.js',
      instances: 'max',
      exec_mode: 'cluster',
      env_production: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
    },
    {
      name: 'semibot-web',
      cwd: './apps/web',
      script: 'node_modules/.bin/next',
      args: 'start',
      instances: 2,
      exec_mode: 'cluster',
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
    {
      name: 'semibot-runtime',
      cwd: './runtime',
      script: '.venv/bin/python',
      args: '-m src.main',
      instances: 1,
      env_production: {
        PYTHONPATH: '.',
      },
    },
  ],
}
```

```bash
# 启动所有服务
pm2 start ecosystem.config.js --env production

# 保存进程列表
pm2 save

# 设置开机自启
pm2 startup
```

---

## 部署检查清单

### 部署前检查

- [ ] 所有环境变量已正确配置
- [ ] 数据库连接测试通过
- [ ] Redis 连接测试通过
- [ ] LLM API Key 有效性验证
- [ ] SSL 证书已配置（生产环境）
- [ ] 防火墙规则已配置
- [ ] 备份策略已就位

### 部署后验证

- [ ] 健康检查端点响应正常 (`/api/health`)
- [ ] 用户可以正常登录
- [ ] Agent 创建和对话功能正常
- [ ] SSE 连接稳定
- [ ] 日志正常输出
- [ ] 监控告警配置完成

### 安全检查

- [ ] JWT_SECRET 使用强随机密钥
- [ ] 数据库密码足够复杂
- [ ] API Key 未暴露在日志中
- [ ] HTTPS 强制启用
- [ ] CORS 配置正确
- [ ] Rate Limiting 已启用

---

## 故障排除

### 常见问题

#### 1. 数据库连接失败

```bash
# 检查 PostgreSQL 状态
sudo systemctl status postgresql

# 检查连接
psql -h localhost -U semibot -d semibot -c "SELECT 1"
```

#### 2. Redis 连接失败

```bash
# 检查 Redis 状态
sudo systemctl status redis

# 测试连接
redis-cli ping
```

#### 3. SSE 连接中断

检查 Nginx 配置中的 `proxy_buffering off` 和 `proxy_read_timeout` 设置。

#### 4. Runtime 服务无响应

```bash
# 检查 Python 环境
source runtime/.venv/bin/activate
python -c "import src; print('OK')"

# 检查端口占用
lsof -i :8000
```

### 日志位置

| 服务 | 日志位置 |
|------|----------|
| API | `apps/api/logs/` 或 PM2 日志 |
| Web | PM2 日志 |
| Runtime | `runtime/logs/` |
| Nginx | `/var/log/nginx/` |

### 监控端点

- 健康检查: `GET /api/health`
- 就绪检查: `GET /api/ready`
- 指标: `GET /api/metrics`

---

## 灾难恢复

### 数据库备份

```bash
# 备份
pg_dump -h localhost -U semibot semibot > backup_$(date +%Y%m%d).sql

# 恢复
psql -h localhost -U semibot semibot < backup_20240101.sql
```

### Redis 备份

```bash
# 触发 RDB 快照
redis-cli BGSAVE

# 备份文件位置
/var/lib/redis/dump.rdb
```

### 回滚流程

1. 停止当前服务
2. 恢复上一版本代码
3. 恢复数据库（如需要）
4. 重启服务
5. 验证功能

---

**最后更新**: 2026-02-09
