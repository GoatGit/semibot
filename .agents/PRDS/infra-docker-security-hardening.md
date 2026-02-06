# PRD: Infra Docker 安全加固

## 概述

对 `/infra/docker/` 目录下的 Docker 配置进行安全加固，修复审查发现的 CRITICAL 和 HIGH 级别安全问题。

## 背景

2026-02-06 审查发现 infra 配置存在多个安全风险：
- PostgreSQL 使用不安全默认密码
- Redis 未启用认证
- 数据库端口暴露到宿主机
- 敏感环境变量缺少必填校验

## 问题清单

### CRITICAL 级别

| ID | 问题 | 文件 | 行号 |
|----|------|------|------|
| C1 | PostgreSQL 使用默认密码 `semibot` | docker-compose.yml | 94-95 |
| C2 | Redis 未启用密码认证 | docker-compose.yml | 118 |
| C3 | Dockerfile.runtime uvicorn 模块路径可能错误 | Dockerfile.runtime | 68 |

### HIGH 级别

| ID | 问题 | 文件 | 行号 |
|----|------|------|------|
| H1 | PostgreSQL 端口 5432 暴露到宿主机 | docker-compose.yml | 92 |
| H2 | Redis 端口 6379 暴露到宿主机 | docker-compose.yml | 117 |
| H3 | JWT_SECRET 等关键变量缺少必填校验 | docker-compose.yml | 26-29 |
| H4 | requirements.txt 可能缺少 fastapi/uvicorn | runtime/requirements.txt | - |

## 需求

### 1. 修复 PostgreSQL 默认密码问题

**变更前:**
```yaml
- POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-semibot}
```

**变更后:**
```yaml
- POSTGRES_PASSWORD=${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}
```

### 2. 为 Redis 启用密码认证

**变更前:**
```yaml
command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru
```

**变更后:**
```yaml
command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru --requirepass ${REDIS_PASSWORD:?REDIS_PASSWORD is required}
```

同时更新所有服务的 REDIS_URL:
```yaml
- REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379
```

### 3. 限制数据库端口暴露

将端口绑定到 localhost:
```yaml
ports:
  - "127.0.0.1:${POSTGRES_PORT:-5432}:5432"
  - "127.0.0.1:${REDIS_PORT:-6379}:6379"
```

### 4. 添加关键环境变量校验

```yaml
- JWT_SECRET=${JWT_SECRET:?JWT_SECRET is required}
- SESSION_SECRET=${SESSION_SECRET:?SESSION_SECRET is required}
```

### 5. 修复 Dockerfile.runtime 启动命令

验证并修复 uvicorn 模块路径:
```dockerfile
# 方案1: 使用完整模块路径
CMD ["python", "-m", "uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]

# 或方案2: 更改工作目录
WORKDIR /app/src
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### 6. 更新 .env.example

添加新增的必填变量:
```
REDIS_PASSWORD=your_strong_redis_password_here
```

## 验收标准

- [ ] docker-compose.yml 无默认密码
- [ ] Redis 启用密码认证
- [ ] 数据库端口仅绑定到 localhost
- [ ] 关键环境变量使用 `:?` 语法校验
- [ ] 容器能正常启动并通过健康检查
- [ ] .env.example 包含所有必填变量

## 优先级

**P0 - Critical** - 生产部署前必须完成

## 相关文档

- TASK: infra-docker-security-hardening.md
