# TASK: Infra Docker 安全加固

## 关联 PRD

[infra-docker-security-hardening.md](../PRDS/infra-docker-security-hardening.md)

## 状态

- [x] **已完成** (2026-02-06)

## 优先级

**P0 - Critical**

## 任务清单

### 1. 修复 PostgreSQL 默认密码 [CRITICAL]

- [x] 编辑 `infra/docker/docker-compose.yml`
- [x] 将第 94-95 行的 `:-semibot` 改为 `:?xxx is required`
- [x] 同步更新第 24 行 DATABASE_URL 中的默认值

### 2. 为 Redis 启用密码认证 [CRITICAL]

- [x] 编辑 `infra/docker/docker-compose.yml` 第 118 行添加 `--requirepass`
- [x] 更新 api 服务 REDIS_URL (第 25 行)
- [x] 更新 runtime 服务 REDIS_URL (第 62 行)

### 3. 验证 Dockerfile.runtime 启动命令 [CRITICAL]

- [x] 检查 `runtime/src/main.py` 是否存在
- [x] 保持现有配置（PYTHONPATH 已正确设置）

### 4. 限制数据库端口暴露 [HIGH]

- [x] 编辑 `infra/docker/docker-compose.yml`
- [x] PostgreSQL 端口改为 `127.0.0.1:${POSTGRES_PORT:-5432}:5432`
- [x] Redis 端口改为 `127.0.0.1:${REDIS_PORT:-6379}:6379`

### 5. 添加关键环境变量校验 [HIGH]

- [x] 更新 JWT_SECRET 为 `${JWT_SECRET:?JWT_SECRET is required}`
- [x] 更新 SESSION_SECRET 为 `${SESSION_SECRET:?SESSION_SECRET is required}`

### 6. 更新 .env.example [HIGH]

- [x] 添加 `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`
- [x] 添加 `REDIS_PASSWORD`
- [x] 更新连接 URL 格式

### 7. 验证修改

- [x] 配置语法验证通过
- [ ] 待用户本地测试容器启动

## 预计工时

2-3 小时

## 实际工时

~1 小时

## 备注

- 修改后需要更新所有开发者的本地 `.env` 文件
- 生产环境需要在部署前设置所有必填环境变量
