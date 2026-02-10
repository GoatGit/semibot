# 部署规范

## Docker 镜像

- 基础镜像锁定版本号（如 `node:20.11.0-alpine3.19`），禁止 `latest`
- 多阶段构建：依赖安装 → 编译 → 运行时，最小化最终镜像
- 创建 `.dockerignore` 排除 `.git`、`.env`、`node_modules`、`__pycache__`、`dist`

---

## 服务安全

- 数据库端口绑定 `127.0.0.1`，禁止 `0.0.0.0`
- Redis 启用 `--requirepass`
- 必需环境变量用 `${VAR:?error}` 语法，缺失时快速失败

---

## 健康检查

实现健康检查端点，验证数据库、Redis、外部服务连通性。

---

## 优雅关闭

处理 SIGTERM/SIGINT 信号，按顺序：关闭连接 → 刷新缓冲 → 完成在途请求。

---

## 数据库迁移

迁移脚本必须幂等（`IF NOT EXISTS` / `IF EXISTS`），可安全重复执行。
