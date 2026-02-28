# API 契约（事件/规则/审批）

> 目标：明确请求与响应结构，降低实现分歧。

## 1. `GET /v1/events`

查询参数：
- `type` 可选
- `since` 可选，ISO8601
- `limit` 可选，默认 50

响应：

```json
{
  "items": [
    {
      "id": "evt_001",
      "event_type": "task.completed",
      "source": "agent",
      "subject": "task:123",
      "payload": {},
      "risk_hint": "low",
      "created_at": "2026-02-26T12:00:00Z"
    }
  ],
  "next_cursor": null
}
```

## 2. `POST /v1/events/replay`

请求：

```json
{
  "event_id": "evt_001"
}
```

响应：

```json
{
  "accepted": true,
  "replay_id": "rpl_001"
}
```

## 3. `GET /v1/rules`

响应：

```json
{
  "items": [
    {
      "id": "rule_001",
      "name": "system_health_alert",
      "event_type": "system.health.unreachable",
      "action_mode": "ask",
      "risk_level": "medium",
      "priority": 50,
      "is_active": true
    }
  ]
}
```

## 4. `POST /v1/rules`

请求：

```json
{
  "name": "tool_failure_alert",
  "event_type": "tool.exec.failed",
  "conditions": { "all": [] },
  "action_mode": "suggest",
  "actions": [
    { "action_type": "notify", "params": { "channel": "chat" } }
  ],
  "risk_level": "low",
  "priority": 30,
  "dedupe_window_seconds": 300,
  "cooldown_seconds": 600,
  "attention_budget_per_day": 10,
  "is_active": true
}
```

响应：

```json
{
  "id": "rule_002",
  "created": true
}
```

## 5. `POST /v1/approvals/{id}/approve` / `reject`

请求：

```json
{
  "reason": "manual review passed"
}
```

响应：

```json
{
  "id": "appr_001",
  "status": "approved"
}
```

## 6. 错误响应（统一）

```json
{
  "error": {
    "code": "RULE_VALIDATION_ERROR",
    "message": "invalid action_mode",
    "details": {}
  }
}
```

## 7. `POST /v1/webhooks/{event_type}`

用途：外部系统（飞书/钉钉/内部系统）推送事件入口。

请求（支持两种）：

```json
{
  "subject": "chat:group_001",
  "payload": { "text": "请分析这个问题" },
  "source": "webhook",
  "idempotency_key": "wx:msg:123"
}
```

或直接把整个 body 作为 payload：

```json
{
  "event": { "msg_id": "123" },
  "header": { "app_id": "cli_xxx" }
}
```

响应：

```json
{
  "event_id": "evt_webhook_xxx",
  "event_type": "chat.message.received",
  "matched_rules": 1
}
```

## 8. `POST /v1/system/heartbeat`

用途：手工或外部守护进程上报心跳，进入统一事件流。

请求：

```json
{
  "source": "system.api",
  "subject": "node:local",
  "payload": { "cpu": 0.23 }
}
```

响应：

```json
{
  "event_id": "evt_heartbeat_xxx",
  "matched_rules": 0
}
```

## 9. `GET /v1/dashboard/live`

新增关键参数：

- `mode=snapshot_delta|delta`（默认 `snapshot_delta`）
- `resume_from`（游标别名，等价 `cursor`）
- `event_types`（逗号分隔多类型过滤）

## 10. `POST /v1/integrations/feishu/events`

用途：飞书事件回调入口（URL 验证 + 群消息事件）。

URL 验证请求：

```json
{
  "type": "url_verification",
  "token": "token_123",
  "challenge": "abc"
}
```

URL 验证响应：

```json
{
  "challenge": "abc"
}
```

消息事件请求（示例）：

```json
{
  "token": "token_123",
  "header": {
    "event_id": "evt_f_001",
    "event_type": "im.message.receive_v1"
  },
  "event": {
    "message": {
      "message_id": "om_001",
      "chat_id": "oc_group_001",
      "message_type": "text",
      "content": "{\"text\":\"hello\"}"
    }
  }
}
```

响应：

```json
{
  "accepted": true,
  "event_id": "evt_feishu_xxx",
  "event_type": "chat.message.received",
  "matched_rules": 1
}
```

## 11. `POST /v1/integrations/feishu/card-actions`

用途：飞书卡片审批/动作回传入口。

请求：

```json
{
  "token": "token_123",
  "action": {
    "value": {
      "approval_id": "appr_xxx",
      "decision": "approve"
    }
  }
}
```

响应：

```json
{
  "accepted": true,
  "approval_id": "appr_xxx",
  "decision": "approved",
  "resolved": true,
  "status": "approved",
  "approval_action_event_id": "evt_approval_action_xxx",
  "event_id": "evt_feishu_action_xxx",
  "matched_rules": 0
}
```

## Gateway 配置 API（新增）

用于配置管理页的 `Gateways` Tab，统一管理 `feishu` 和 `telegram`。

### `GET /v1/config/gateways`

响应：

```json
{
  "data": [
    {
      "provider": "feishu",
      "displayName": "Feishu",
      "isActive": true,
      "status": "ready",
      "config": {
        "verifyToken": "***",
        "webhookUrl": "https://open.feishu.cn/..."
      }
    },
    {
      "provider": "telegram",
      "displayName": "Telegram",
      "isActive": false,
      "status": "not_configured",
      "config": {
        "botToken": null,
        "defaultChatId": null
      }
    }
  ]
}
```

### `GET /v1/config/gateways/{provider}`

`provider`：`feishu` | `telegram`

### `PUT /v1/config/gateways/{provider}`

请求（Telegram 示例）：

```json
{
  "isActive": true,
  "config": {
    "botToken": "123456:ABCDEF",
    "defaultChatId": "-10012345678",
    "allowedChatIds": ["-10012345678"],
    "notifyEventTypes": ["approval.requested", "task.completed"]
  }
}
```

### `POST /v1/config/gateways/{provider}/test`

请求：

```json
{
  "message": "Semibot gateway connectivity test",
  "channel": "default"
}
```

响应：

```json
{
  "sent": true
}
```

## Telegram Gateway API（新增）

### `POST /v1/integrations/telegram/webhook`

用途：接收 Telegram Bot Webhook Update。

请求（示例）：

```json
{
  "update_id": 123456789,
  "message": {
    "message_id": 88,
    "chat": { "id": -10012345678, "type": "supergroup" },
    "text": "同意 appr_abc123"
  }
}
```

响应（审批命中）：

```json
{
  "accepted": true,
  "event_type": "approval.action",
  "resolved": true,
  "approval_id": "appr_abc123",
  "decision": "approved"
}
```

响应（普通消息）：

```json
{
  "accepted": true,
  "event_id": "evt_tg_xxx",
  "event_type": "chat.message.received",
  "matched_rules": 1
}
```

### `POST /v1/integrations/telegram/outbound/test`

用途：发送测试消息到 Telegram 默认 chat。

## 12. `POST /v1/tasks/run`

用途：单次任务执行入口（CLI/WebUI 可直接调用），走本地 Orchestrator + Event Engine。

请求：

```json
{
  "task": "研究阿里巴巴股票并生成PDF报告",
  "agent_id": "analyst",
  "session_id": "optional_session",
  "model": "gpt-4o",
  "system_prompt": "你是资深投研分析师"
}
```

响应：

```json
{
  "task": "研究阿里巴巴股票并生成PDF报告",
  "status": "completed",
  "session_id": "sess_demo",
  "agent_id": "analyst",
  "final_response": "报告已生成",
  "error": null,
  "tool_results": [],
  "runtime_events": [],
  "llm_configured": true
}
```

## 13. `POST /v1/chat`

用途：统一聊天入口，可选流式 SSE。

请求：

```json
{
  "message": "帮我做一个执行计划",
  "agent_id": "semibot",
  "stream": false
}
```

响应（非流式）：

```json
{
  "message": "帮我做一个执行计划",
  "status": "completed",
  "session_id": "sess_chat",
  "agent_id": "semibot",
  "final_response": "已生成计划",
  "error": null
}
```

当 `stream=true` 时，返回 `text/event-stream`，事件流包含 `start` 和 `done`。

## 14. `GET /v1/skills`

用途：列出当前可用内置 tools/skills。

响应：

```json
{
  "tools": ["search", "file_io", "code_executor", "browser_automation"],
  "skills": ["xlsx", "pdf"]
}
```

## 15. `GET /health`

用途：健康检查别名（与 `/healthz` 一致）。

## 16. `GET /v1/sessions` / `DELETE /v1/sessions/{session_id}`

用途：本地运行时会话查询与清理入口。

`GET /v1/sessions` 响应：

```json
{
  "items": [
    {
      "session_id": "sess_1",
      "last_seen_at": "2026-02-26T18:00:00+00:00"
    }
  ]
}
```

`DELETE /v1/sessions/{session_id}` 响应：

```json
{
  "deleted": true,
  "session_id": "sess_1"
}
```

## 17. `GET /v1/agents`

用途：列出当前运行中出现过的 agent（最小实现）。

## 18. `GET /v1/memories/search`

用途：本地记忆查询（当前阶段基于事件与 payload 文本检索，后续可切换到 Memory Adapter）。

## 19. `POST /v1/skills/install`

用途：技能安装占位接口；当前阶段建议使用本地 skill 管理流程。

说明：
- 网关会额外写入一条 `approval.action` 事件（`approval_action_event_id`），用于审批行为审计与回放。

## 12. `POST /v1/integrations/feishu/outbound/test`

用途：发送测试卡片，验证 Semibot 到飞书 webhook 的出站连通性。

请求：

```json
{
  "title": "Semibot 测试",
  "content": "这是一条测试通知",
  "channel": "default"
}
```

响应：

```json
{
  "sent": true
}
```
