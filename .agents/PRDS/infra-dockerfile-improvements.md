# PRD: Dockerfile 改进

## 概述

改进 Dockerfile.api 和 Dockerfile.runtime 的配置，修复 MEDIUM 和 LOW 级别问题。

## 背景

2026-02-06 审查发现以下改进点：

### Dockerfile.api

| 级别 | 问题 |
|------|------|
| MEDIUM | 基础镜像版本未锁定到具体 digest |
| MEDIUM | pnpm 版本应使用 ARG 可配置 |
| LOW | 缺少 .dockerignore 验证 |
| LOW | HEALTHCHECK 使用 wget 无 SSL 验证 |

### Dockerfile.runtime

| 级别 | 问题 |
|------|------|
| MEDIUM | 基础镜像版本未锁定 |
| MEDIUM | HEALTHCHECK 使用 curl 增加攻击面 |
| LOW | uvicorn 未配置 workers 数量 |

## 需求

### 1. 锁定基础镜像版本

**Dockerfile.api:**
```dockerfile
# 变更前
FROM node:20-alpine AS deps

# 变更后
ARG NODE_VERSION=20.11.0
FROM node:${NODE_VERSION}-alpine3.19 AS deps
```

**Dockerfile.runtime:**
```dockerfile
# 变更前
FROM python:3.11-slim AS builder

# 变更后
ARG PYTHON_VERSION=3.11.9
FROM python:${PYTHON_VERSION}-slim-bookworm AS builder
```

### 2. pnpm 版本可配置

```dockerfile
ARG PNPM_VERSION=9.0.0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
```

### 3. 使用 Python 原生健康检查

**Dockerfile.runtime:**
```dockerfile
# 变更前
HEALTHCHECK ... CMD curl --fail http://localhost:8801/health || exit 1

# 变更后
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8801/health')" || exit 1
```

移除 `curl` 安装以减少攻击面。

### 4. 创建 .dockerignore

创建 `/infra/docker/.dockerignore`:

```
.git
.gitignore
.env
.env.*
*.md
*.log
node_modules
dist
coverage
__tests__
tests
.pytest_cache
__pycache__
*.pyc
.mypy_cache
.turbo
```

### 5. uvicorn workers 配置（可选）

```dockerfile
# 使用环境变量控制
ENV UVICORN_WORKERS=4
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8801", "--workers", "${UVICORN_WORKERS}"]
```

## 验收标准

- [ ] 基础镜像使用具体版本标签
- [ ] pnpm 版本通过 ARG 可配置
- [ ] .dockerignore 创建并包含必要排除项
- [ ] Dockerfile.runtime 可选移除 curl 依赖
- [ ] 所有 Dockerfile 能正常构建

## 优先级

**P2 - Medium** - 建议在 P0/P1 之后完成

## 相关文档

- TASK: infra-dockerfile-improvements.md
