# 管理员账号指南

## 角色体系

系统采用组织级 RBAC，三种角色：

| 角色 | 权限 | 说明 |
|------|------|------|
| **owner** | `['*']` | 组织所有者，拥有全部权限（等同超级管理员） |
| **admin** | `agents:*`, `sessions:*`, `chat:*`, `skills:*`, `tools:*`, `mcp:*`, `members:read` | 管理员，可管理 Agent、Skill、MCP 等 |
| **member** | `agents:read`, `sessions:*`, `chat:*` | 普通成员，只能使用 Agent 和聊天 |

## 创建超级管理员

### 方式一：CLI 脚本（推荐）

```bash
# 交互式，会提示输入邮箱、密码、姓名、组织名
pnpm --filter @semibot/api create-admin

# 环境变量方式（适合 CI / Docker）
ADMIN_EMAIL=admin@example.com \
ADMIN_PASSWORD=your-secure-password \
ADMIN_NAME="Super Admin" \
ORG_NAME="My Organization" \
pnpm --filter @semibot/api create-admin
```

脚本逻辑：
- ���果邮箱不存在 → 创建新组织 + owner 用户
- 如果邮箱已存在且角色不是 owner → 自动升级为 owner
- 如果邮箱已存在且已是 owner → 跳过，提示无需操作

### 方式二：注册 API

```bash
curl -X POST http://localhost:3001/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@example.com",
    "password": "your-secure-password",
    "name": "Super Admin",
    "orgName": "My Organization"
  }'
```

通过 API 注册的用户自动成为所在组织的 owner。

### 方式三：开发环境 Seed 数据

运行 seed 脚本导入预置账号：

```bash
psql -U postgres -d semibot -f database/seeds/dev/001_sample_org.sql
```

## 开发环境预置账号

> 仅用于开发测试，切勿在生产环境使用。

| 邮箱 | 密码 | 角色 | 组织 |
|------|------|------|------|
| admin@semibot.dev | password123 | owner | Semibot Dev Team |
| developer@semibot.dev | password123 | admin | Semibot Dev Team |
| tester@semibot.dev | password123 | member | Semibot Dev Team |
| demo@example.com | password123 | owner | Demo Organization |
| 12611171@qq.com | admin123 | member | Semibot Dev Team |

## 认证机制

- JWT Access Token：有效期 24 小时
- JWT Refresh Token：有效期 7 天
- 登出后 Token 通过 Redis 黑名单失效
- 支持 API Key 认证（`sk-` 前缀），适用于程序化访问
