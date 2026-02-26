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

