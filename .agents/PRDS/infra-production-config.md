# PRD: Infra 生产环境配置完善

## 概述

补充 infra 目录缺失的生产环境配置，包括 docker-compose.prod.yml、Nginx 反向代理、Web Dockerfile 等。

## 背景

2026-02-06 审查发现 infra 配置功能不完整：
- 缺少 docker-compose.prod.yml 生产环境配置
- 缺少 Nginx 反向代理配置
- 缺少 Web 前端 Dockerfile
- 日志和监控配置缺失

## 缺失配置清单

### P0 - Critical

| ID | 配置 | 说明 |
|----|------|------|
| P0-1 | docker-compose.prod.yml | 生产环境覆盖配置 |
| P0-2 | Nginx 反向代理 | SSL 终止、安全头、路由 |

### P1 - High

| ID | 配置 | 说明 |
|----|------|------|
| P1-1 | Dockerfile.web | Next.js 前端容器化 |
| P1-2 | CI/CD Docker 构建步骤 | 自动构建推送镜像 |

### P2 - Medium

| ID | 配置 | 说明 |
|----|------|------|
| P2-1 | 日志收集配置 | Fluentd/Loki 配置 |
| P2-2 | 监控配置 | Prometheus + Grafana |
| P2-3 | 备份定时任务 | CronJob 配置 |

## 需求详情

### 1. docker-compose.prod.yml

创建 `infra/docker/docker-compose.prod.yml`:

```yaml
# 生产环境覆盖配置
services:
  api:
    volumes: []  # 移除开发挂载
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

  runtime:
    volumes: []
    deploy:
      resources:
        limits:
          cpus: '4'
          memory: 4G

  postgres:
    ports: []  # 移除端口暴露

  redis:
    ports: []
```

### 2. Nginx 反向代理

创建 `infra/nginx/nginx.conf`:

```nginx
upstream api {
    server api:3001;
}

upstream runtime {
    server runtime:8000;
}

server {
    listen 80;
    listen 443 ssl;

    # SSL 配置
    ssl_certificate /etc/nginx/certs/cert.pem;
    ssl_certificate_key /etc/nginx/certs/key.pem;

    # 安全头
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    location /api/ {
        proxy_pass http://api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /runtime/ {
        proxy_pass http://runtime/;
    }
}
```

### 3. Dockerfile.web

创建 `infra/docker/Dockerfile.web`:

```dockerfile
FROM node:20-alpine AS deps
# ... Next.js 标准多阶段构建
```

### 4. 日志配置

在 docker-compose.yml 中添加:

```yaml
logging:
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "3"
```

## 目标目录结构

```
infra/
├── docker/
│   ├── Dockerfile.api          # 已有
│   ├── Dockerfile.runtime      # 已有
│   ├── Dockerfile.web          # 新增
│   ├── docker-compose.yml      # 已有
│   └── docker-compose.prod.yml # 新增
├── nginx/                       # 新增
│   ├── nginx.conf
│   └── ssl/
└── scripts/                     # 新增
    ├── deploy.sh
    └── healthcheck.sh
```

## 验收标准

- [ ] docker-compose.prod.yml 创建并测试
- [ ] Nginx 配置创建并能正常路由
- [ ] Dockerfile.web 创建并能构建 Next.js 应用
- [ ] 所有服务配置日志驱动
- [ ] 生产环境移除开发卷挂载
- [ ] 生产环境移除数据库端口暴露

## 优先级

**P0-P1** - 生产部署前必须完成 P0，P1 可并行进行

## 相关文档

- TASK: infra-production-config.md
