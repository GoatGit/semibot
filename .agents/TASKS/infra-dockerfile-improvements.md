# TASK: Dockerfile 改进

## 关联 PRD

[infra-dockerfile-improvements.md](../PRDS/infra-dockerfile-improvements.md)

## 状态

- [x] **已完成** (2026-02-06)

## 优先级

**P2 - Medium**

## 任务清单

### 1. 锁定基础镜像版本 [MEDIUM]

#### Dockerfile.api

- [x] 编辑 `infra/docker/Dockerfile.api`
- [x] 在文件开头添加 ARG: `ARG NODE_VERSION=20.11.0`
- [x] 修改所有 FROM 语句使用 `node:${NODE_VERSION}-alpine3.19`

#### Dockerfile.runtime

- [x] 编辑 `infra/docker/Dockerfile.runtime`
- [x] 在文件开头添加 ARG: `ARG PYTHON_VERSION=3.11.9`
- [x] 修改所有 FROM 语句使用 `python:${PYTHON_VERSION}-slim-bookworm`

### 2. pnpm 版本可配置 [MEDIUM]

- [x] 编辑 `infra/docker/Dockerfile.api`
- [x] 添加 ARG: `ARG PNPM_VERSION=9.0.0`
- [x] 修改 corepack 命令使用 `pnpm@${PNPM_VERSION}`

### 3. 创建 .dockerignore [LOW]

- [x] 创建项目根目录 `.dockerignore`
- [x] 包含 .git, .env, node_modules, dist, __pycache__ 等

### 4. 使用 Python 原生健康检查 (可选) [MEDIUM]

- [ ] 可选：修改 Dockerfile.runtime HEALTHCHECK 使用 Python urllib
- [ ] 可选：移除 curl 安装减少攻击面
- **决定**: 保留 curl，因为调试更方便

### 5. uvicorn workers 配置 (可选) [LOW]

- [ ] 可选：添加 UVICORN_WORKERS 环境变量
- **决定**: 保持单 worker，生产环境通过 docker-compose.prod.yml 配置

### 6. 统一 HEALTHCHECK 工具 [LOW]

- [ ] 可选：统一 wget/curl
- **决定**: 保持现状 (API 用 wget，Runtime 用 curl)

## 验证步骤

- [ ] `docker build -f infra/docker/Dockerfile.api .` 成功
- [ ] `docker build -f infra/docker/Dockerfile.runtime .` 成功
- [ ] 容器启动后健康检查通过
- [x] .dockerignore 排除了敏感文件

## 预计工时

2-3 小时

## 实际工时

~30 分钟

## 依赖

- [x] 建议在 infra-docker-security-hardening 完成后进行
