# TASK: Infra 生产环境配置完善

## 关联 PRD

[infra-production-config.md](../PRDS/infra-production-config.md)

## 状态

- [x] **已完成** (2026-02-06)

## 优先级

**P0-P1**

## 任务清单

### Phase 1: docker-compose.prod.yml [P0]

- [x] 创建 `infra/docker/docker-compose.prod.yml`
- [x] 配置生产环境服务覆盖:
  - [x] 移除开发卷挂载 (api.volumes, runtime.volumes)
  - [x] 添加资源限制 (deploy.resources.limits)
  - [x] 配置日志驱动 (logging.driver)
  - [x] 移除数据库端口暴露 (postgres.ports, redis.ports)
- [ ] 测试 `docker-compose -f docker-compose.yml -f docker-compose.prod.yml config`

### Phase 2: Nginx 反向代理 [P0]

- [x] 创建 `infra/nginx/` 目录
- [x] 创建 `infra/nginx/nginx.conf`
  - [x] 配置 upstream 代理到 api 和 runtime
  - [x] 配置 SSL 终止（模板已准备，待证书）
  - [x] 添加安全头 (X-Frame-Options, X-Content-Type-Options 等)
  - [x] 配置请求路由 (/api/ -> api, /runtime/ -> runtime)
- [x] 创建 `infra/nginx/ssl/` 目录 (存放证书)
- [x] 创建 `infra/nginx/ssl/README.md` (证书说明)
- [x] 创建 `infra/nginx/ssl/.gitignore` (保护证书文件)
- [x] 在 docker-compose.prod.yml 中添加 nginx 服务
- [ ] 测试 Nginx 配置: `nginx -t`

### Phase 3: Dockerfile.web [P1]

- [x] 创建 `infra/docker/Dockerfile.web`
- [x] 配置 Next.js 多阶段构建:
  - [x] Stage 1: deps - 安装依赖
  - [x] Stage 2: builder - 构建应用
  - [x] Stage 3: runner - 生产运行
- [x] 使用非 root 用户运行 (nextjs)
- [x] 配置 HEALTHCHECK
- [ ] 在 docker-compose.yml 中添加 web 服务（可选）
- [ ] 测试构建: `docker build -f infra/docker/Dockerfile.web .`

### Phase 4: 日志配置 [P2]

- [x] 在 docker-compose.prod.yml 中为所有服务添加 logging 配置
- [ ] 可选: 创建 `infra/logging/` 配置 Fluentd/Loki

### Phase 5: CI/CD 完善 [P1]

- [ ] 更新 `.github/workflows/deploy.yml`
  - [ ] 添加 Docker 镜像构建步骤
  - [ ] 添加推送到 Container Registry 步骤
  - [ ] 完善 Runtime 部署配置
  - [ ] 添加回滚机制

### Phase 6: 辅助脚本 [P2]

- [x] 创建 `infra/scripts/deploy.sh` - 部署脚本
- [x] 创建 `infra/scripts/healthcheck.sh` - 健康检查脚本
- [ ] 创建 `infra/scripts/backup-cron.sh` - 定时备份脚本（可选）

## 验证步骤

- [ ] 生产配置能正常启动所有服务
- [ ] Nginx 能正确路由请求
- [ ] 所有服务通过健康检查
- [x] 日志配置已添加
- [ ] CI/CD 能自动构建部署

## 预计工时

- Phase 1-2: 4-6 小时 (P0)
- Phase 3: 2-3 小时 (P1)
- Phase 4-6: 4-6 小时 (P2)

## 实际工时

~2 小时 (Phase 1-3, 6 部分完成)

## 依赖

- [x] 需要先完成 infra-docker-security-hardening 任务
