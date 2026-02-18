# PRD: Webhook 事件分发系统

## 背景

API_DESIGN.md 规划了 CRUD /webhooks 端点，用于向外部系统推送事件通知（如 Agent 执行完成、进化技能生成、错误告警等）。当前仅在 `evolution.events.ts:70` 有一行 `// TODO: 发送到 Webhook 订阅者`，整个 Webhook 系统完全缺失。

## 功能需求

### 1. Webhook 订阅管理

- 用户可注册 Webhook URL，指定订阅的事件类型
- 支持的事件类型：`agent.execution.completed`、`agent.execution.failed`、`evolution.skill.created`、`evolution.skill.promoted`、`session.created`、`session.ended`
- 每个组织最多 20 个 Webhook 订阅
- 支持启用/禁用单个订阅

### 2. 事件分发机制

- 事件触发后异步推送到所有匹配的 Webhook URL
- 使用 HMAC-SHA256 签名验证（`X-Webhook-Signature` header）
- 支持重试：最多 3 次，指数退避（1s/2s/4s）
- 超时控制：单次请求 10s 超时
- 连续失败 10 次自动禁用，通知用户

### 3. Webhook 日志

- 记录每次推送的请求/响应/状态
- 支持按时间范围查询推送历史
- 保留 30 天日志

## 技术方案

### 数据模型

```sql
CREATE TABLE webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  url TEXT NOT NULL,
  secret VARCHAR(255) NOT NULL,
  events TEXT[] NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  failure_count INT NOT NULL DEFAULT 0,
  last_triggered_at TIMESTAMP,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by UUID NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE TABLE webhook_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id UUID NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  response_status INT,
  response_body TEXT,
  attempt INT NOT NULL DEFAULT 1,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/v1/webhooks | 创建订阅 |
| GET | /api/v1/webhooks | 列出订阅 |
| GET | /api/v1/webhooks/:id | 获取详情 |
| PUT | /api/v1/webhooks/:id | 更新订阅 |
| DELETE | /api/v1/webhooks/:id | 删除订阅 |
| GET | /api/v1/webhooks/:id/logs | 查看推送日志 |
| POST | /api/v1/webhooks/:id/test | 发送测试事件 |

### 涉及文件

- 新增 `apps/api/src/routes/v1/webhooks.ts`
- 新增 `apps/api/src/services/webhook.service.ts`
- 新增 `apps/api/src/repositories/webhook.repository.ts`
- 修改 `apps/api/src/routes/v1/index.ts` — 注册路由
- 修改 `apps/api/src/events/evolution.events.ts` — 接入 Webhook 分发
- 新增 `docs/sql/016_webhooks.sql`
- 新增 `packages/shared-types/src/webhook.ts`

## 优先级

**P1 — 设计文档已规划，外部集成的基础能力**

## 验收标准

- [ ] Webhook CRUD API 可用
- [ ] 事件触发后异步推送到订阅 URL
- [ ] HMAC-SHA256 签名验证正确
- [ ] 重试机制工作正常（3 次指数退避）
- [ ] 连续失败自动禁用
- [ ] 推送日志可查询
- [ ] 测试事件可发送
- [ ] 单元测试覆盖核心逻辑
