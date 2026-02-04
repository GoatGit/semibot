# API 设计

## 1. 概述

API 采用 RESTful 风格设计，使用 JSON 作为数据交换格式。

**Base URL**: `https://api.semibot.dev/v1`

## 2. 认证

### 2.1 API Key 认证

```http
Authorization: Bearer sk-xxxxxxxxxxxxx
```

### 2.2 JWT Token 认证（用户登录后）

```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

### 2.3 错误响应

```json
{
    "error": {
        "code": "unauthorized",
        "message": "Invalid API key",
        "status": 401
    }
}
```

---

## 2.5 Auth API

### 2.5.1 用户注册

```http
POST /auth/register
Content-Type: application/json

{
    "email": "user@example.com",
    "password": "securePassword123",
    "name": "张三",
    "org_name": "我的团队"
}
```

**Response**:

```json
{
    "success": true,
    "data": {
        "user": {
            "id": "user_abc123",
            "email": "user@example.com",
            "name": "张三"
        },
        "organization": {
            "id": "org_xyz789",
            "name": "我的团队",
            "slug": "my-team"
        },
        "token": "eyJhbGciOiJIUzI1NiIs...",
        "expires_at": "2024-01-08T00:00:00Z"
    }
}
```

### 2.5.2 用户登录

```http
POST /auth/login
Content-Type: application/json

{
    "email": "user@example.com",
    "password": "securePassword123"
}
```

**Response**:

```json
{
    "success": true,
    "data": {
        "user": {
            "id": "user_abc123",
            "email": "user@example.com",
            "name": "张三",
            "org_id": "org_xyz789"
        },
        "token": "eyJhbGciOiJIUzI1NiIs...",
        "refresh_token": "rt_xxxxx",
        "expires_at": "2024-01-08T00:00:00Z"
    }
}
```

### 2.5.3 刷新 Token

```http
POST /auth/refresh
Content-Type: application/json

{
    "refresh_token": "rt_xxxxx"
}
```

### 2.5.4 登出

```http
POST /auth/logout
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

---

## 2.6 Organizations API

### 2.6.1 获取当前组织信息

```http
GET /organizations/current
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

**Response**:

```json
{
    "success": true,
    "data": {
        "id": "org_xyz789",
        "name": "我的团队",
        "slug": "my-team",
        "plan": "pro",
        "quota": {
            "max_agents": 20,
            "max_tokens_per_month": 1000000,
            "max_api_calls_per_day": 10000
        },
        "settings": {},
        "owner_id": "user_abc123",
        "is_active": true,
        "created_at": "2024-01-01T00:00:00Z"
    }
}
```

### 2.6.2 更新组织信息

```http
PUT /organizations/current
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: application/json

{
    "name": "新团队名称",
    "settings": {
        "default_model": "gpt-4o",
        "allow_public_agents": false
    }
}
```

**Response**:

```json
{
    "success": true,
    "data": {
        "id": "org_xyz789",
        "name": "新团队名称",
        "slug": "my-team",
        "settings": {
            "default_model": "gpt-4o",
            "allow_public_agents": false
        },
        "updated_at": "2024-01-02T00:00:00Z"
    }
}
```

### 2.6.3 获取组织成员列表

```http
GET /organizations/current/members?limit=20&cursor=xxx
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

**Response**:

```json
{
    "success": true,
    "data": [
        {
            "id": "user_abc123",
            "email": "owner@example.com",
            "name": "张三",
            "role": "owner",
            "joined_at": "2024-01-01T00:00:00Z",
            "last_login_at": "2024-01-05T10:30:00Z"
        },
        {
            "id": "user_def456",
            "email": "member@example.com",
            "name": "李四",
            "role": "member",
            "joined_at": "2024-01-02T00:00:00Z",
            "last_login_at": "2024-01-04T15:20:00Z"
        }
    ],
    "meta": {
        "next_cursor": "xxx"
    }
}
```

### 2.6.4 邀请成员

```http
POST /organizations/current/members/invite
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: application/json

{
    "email": "newmember@example.com",
    "role": "member"
}
```

**Response**:

```json
{
    "success": true,
    "data": {
        "invitation_id": "inv_abc123",
        "email": "newmember@example.com",
        "role": "member",
        "expires_at": "2024-01-08T00:00:00Z",
        "status": "pending"
    }
}
```

### 2.6.5 更新成员角色

```http
PUT /organizations/current/members/:user_id
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: application/json

{
    "role": "admin"
}
```

**Response**:

```json
{
    "success": true,
    "data": {
        "id": "user_def456",
        "role": "admin",
        "updated_at": "2024-01-02T00:00:00Z"
    }
}
```

### 2.6.6 移除成员

```http
DELETE /organizations/current/members/:user_id
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

**Response**:

```json
{
    "success": true,
    "data": {
        "removed_user_id": "user_def456",
        "removed_at": "2024-01-02T00:00:00Z"
    }
}
```

### 2.6.7 转让组织所有权

```http
POST /organizations/current/transfer
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: application/json

{
    "new_owner_id": "user_def456"
}
```

**Response**:

```json
{
    "success": true,
    "data": {
        "previous_owner_id": "user_abc123",
        "new_owner_id": "user_def456",
        "transferred_at": "2024-01-02T00:00:00Z"
    }
}
```

---

## 2.7 API Keys 管理

### 2.6.1 创建 API Key

```http
POST /api-keys
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: application/json

{
    "name": "Production Key",
    "permissions": ["agents:*", "chat:*", "sessions:*"],
    "expires_at": "2025-01-01T00:00:00Z"
}
```

**Response**:

```json
{
    "success": true,
    "data": {
        "id": "key_abc123",
        "name": "Production Key",
        "key": "sk-live-xxxxxxxxxxxxxxxxxxxx",
        "key_prefix": "sk-live-xxxx",
        "permissions": ["agents:*", "chat:*", "sessions:*"],
        "expires_at": "2025-01-01T00:00:00Z",
        "created_at": "2024-01-01T00:00:00Z"
    }
}
```

> **注意**: `key` 完整值仅在创建时返回一次，请妥善保存。

### 2.6.2 列出 API Keys

```http
GET /api-keys
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

**Response**:

```json
{
    "success": true,
    "data": [
        {
            "id": "key_abc123",
            "name": "Production Key",
            "key_prefix": "sk-live-xxxx",
            "permissions": ["agents:*", "chat:*"],
            "last_used_at": "2024-01-05T10:30:00Z",
            "expires_at": "2025-01-01T00:00:00Z",
            "is_active": true
        }
    ]
}
```

### 2.6.3 删除 API Key

```http
DELETE /api-keys/:id
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

---

## 3. 通用响应格式

### 3.1 成功响应

```json
{
    "success": true,
    "data": { ... },
    "meta": {
        "request_id": "req_abc123",
        "timestamp": "2024-01-01T00:00:00Z"
    }
}
```

### 3.2 分页响应

```json
{
    "success": true,
    "data": [ ... ],
    "meta": {
        "next_cursor": "eyJpZCI6Inh4eCJ9",
        "has_more": true
    }
}
```

> **分页说明**: 所有列表 API 统一使用 cursor 分页。`next_cursor` 为下一页的游标，`has_more` 表示是否还有更多数据。

### 3.3 错误响应

```json
{
    "success": false,
    "error": {
        "code": "validation_error",
        "message": "Invalid request parameters",
        "details": [
            {
                "field": "name",
                "message": "Name is required"
            }
        ]
    }
}
```

## 4. Agents API

### 4.1 创建 Agent

```http
POST /agents
Content-Type: application/json

{
    "name": "Research Assistant",
    "description": "An AI agent that helps with research tasks",
    "system_prompt": "You are a helpful research assistant...",
    "config": {
        "model": "gpt-4o",
        "temperature": 0.7
    },
    "skills": ["skill_web_search", "skill_summarize"],
    "sub_agents": []
}
```

**Response**:

```json
{
    "success": true,
    "data": {
        "id": "agent_abc123",
        "name": "Research Assistant",
        "description": "An AI agent that helps with research tasks",
        "system_prompt": "You are a helpful research assistant...",
        "config": {
            "model": "gpt-4o",
            "temperature": 0.7,
            "max_tokens": 4096
        },
        "skills": ["skill_web_search", "skill_summarize"],
        "sub_agents": [],
        "is_active": true,
        "created_at": "2024-01-01T00:00:00Z",
        "updated_at": "2024-01-01T00:00:00Z"
    }
}
```

### 4.2 列出所有 Agents

```http
GET /agents?limit=20&cursor=xxx&status=active
```

**Query Parameters**:

| 参数 | 类型 | 默认值 | 说明 |
| ---- | ---- | ------ | ---- |
| limit | integer | 20 | 每页数量 (max: 100) |
| cursor | string | - | 分页游标（由上次响应返回） |
| status | string | - | 过滤状态: active/inactive |
| search | string | - | 搜索名称/描述 |

**Response**:

```json
{
    "success": true,
    "data": [...],
    "meta": {
        "next_cursor": "eyJpZCI6ImFnZW50XzEyMyJ9"
    }
}
```

### 4.3 获取 Agent 详情

```http
GET /agents/:id
```

### 4.4 更新 Agent

```http
PUT /agents/:id
Content-Type: application/json

{
    "name": "Updated Name",
    "config": {
        "temperature": 0.8
    }
}
```

### 4.5 删除 Agent

```http
DELETE /agents/:id
```

### 4.6 批量创建 Agents

```http
POST /agents/batch
Content-Type: application/json

{
    "agents": [
        {
            "name": "Agent 1",
            "system_prompt": "You are assistant 1...",
            "config": {"model": "gpt-4o"}
        },
        {
            "name": "Agent 2",
            "system_prompt": "You are assistant 2...",
            "config": {"model": "gpt-4o-mini"}
        }
    ]
}
```

**Response**:

```json
{
    "success": true,
    "data": {
        "created": [
            {"id": "agent_abc123", "name": "Agent 1"},
            {"id": "agent_def456", "name": "Agent 2"}
        ],
        "failed": [],
        "total_created": 2,
        "total_failed": 0
    }
}
```

### 4.7 批量删除 Agents

```http
POST /agents/batch/delete
Content-Type: application/json

{
    "ids": ["agent_abc123", "agent_def456", "agent_ghi789"]
}
```

**Response**:

```json
{
    "success": true,
    "data": {
        "deleted": ["agent_abc123", "agent_def456"],
        "failed": [
            {"id": "agent_ghi789", "reason": "Agent not found"}
        ],
        "total_deleted": 2,
        "total_failed": 1
    }
}
```

### 4.8 批量更新 Agents 状态

```http
POST /agents/batch/update
Content-Type: application/json

{
    "ids": ["agent_abc123", "agent_def456"],
    "updates": {
        "is_active": false
    }
}
```

**Response**:

```json
{
    "success": true,
    "data": {
        "updated": ["agent_abc123", "agent_def456"],
        "failed": [],
        "total_updated": 2,
        "total_failed": 0
    }
}
```

## 5. Skills API

### 5.1 创建 Skill

```http
POST /skills
Content-Type: application/json

{
    "name": "web_search",
    "description": "Search the web for information",
    "trigger_keywords": ["search", "find", "look up"],
    "tools": [
        {
            "tool_id": "tool_search_api",
            "required": true
        }
    ],
    "config": {
        "max_results": 10
    }
}
```

### 5.2 列出所有 Skills

```http
GET /skills?builtin=false
```

### 5.3 获取 Skill 详情

```http
GET /skills/:id
```

### 5.4 更新 Skill

```http
PUT /skills/:id
```

### 5.5 删除 Skill

```http
DELETE /skills/:id
```

## 6. Tools API

### 6.1 创建 Tool

```http
POST /tools
Content-Type: application/json

{
    "name": "search_api",
    "type": "api",
    "description": "Call external search API",
    "schema": {
        "name": "search",
        "description": "Search for information",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query"
                }
            },
            "required": ["query"]
        }
    },
    "implementation": {
        "type": "api",
        "endpoint": "https://api.search.com/v1/search",
        "method": "GET",
        "headers": {
            "Authorization": "Bearer ${SEARCH_API_KEY}"
        }
    }
}
```

### 6.2 列出所有 Tools

```http
GET /tools?type=api
```

### 6.3 获取 Tool 详情

```http
GET /tools/:id
```

### 6.4 测试 Tool

```http
POST /tools/:id/test
Content-Type: application/json

{
    "params": {
        "query": "test query"
    }
}
```

## 7. Sessions API

### 7.1 创建 Session

```http
POST /sessions
Content-Type: application/json

{
    "agent_id": "agent_abc123",
    "user_id": "user_xyz789",
    "metadata": {
        "source": "web",
        "language": "zh-CN"
    }
}
```

**Response**:

```json
{
    "success": true,
    "data": {
        "id": "session_def456",
        "agent_id": "agent_abc123",
        "user_id": "user_xyz789",
        "status": "active",
        "metadata": {
            "source": "web",
            "language": "zh-CN"
        },
        "started_at": "2024-01-01T00:00:00Z"
    }
}
```

### 7.2 获取 Session 详情

```http
GET /sessions/:id
```

### 7.3 获取 Session 消息历史

```http
GET /sessions/:id/messages?limit=50
```

### 7.4 结束 Session

```http
POST /sessions/:id/end
```

## 8. Chat API (核心)

### 8.1 发送消息

```http
POST /chat
Content-Type: application/json

{
    "session_id": "session_def456",
    "message": "帮我搜索一下最新的 AI Agent 技术",
    "stream": false
}
```

**Response** (非流式):

```json
{
    "success": true,
    "data": {
        "id": "msg_ghi789",
        "session_id": "session_def456",
        "role": "assistant",
        "content": "我来帮您搜索最新的 AI Agent 技术相关信息...",
        "tool_calls": [
            {
                "id": "call_001",
                "type": "function",
                "function": {
                    "name": "web_search",
                    "arguments": "{\"query\": \"latest AI agent technology 2024\"}"
                }
            }
        ],
        "metadata": {
            "model": "gpt-4o",
            "tokens_used": 256,
            "latency_ms": 1234
        },
        "created_at": "2024-01-01T00:00:01Z"
    }
}
```

### 8.2 流式响应

```http
POST /chat
Content-Type: application/json

{
    "session_id": "session_def456",
    "message": "请详细解释一下",
    "stream": true
}
```

**Response** (SSE):

```text
event: message_start
data: {"id": "msg_abc", "role": "assistant"}

event: content_delta
data: {"delta": "好的"}

event: content_delta
data: {"delta": "，我来"}

event: content_delta
data: {"delta": "详细解释"}

event: tool_call
data: {"id": "call_001", "name": "search", "arguments": "..."}

event: tool_result
data: {"id": "call_001", "result": "..."}

event: message_end
data: {"tokens_used": 512, "latency_ms": 2345}
```

### 8.3 获取流式响应 (GET 方式)

```http
GET /chat/:session_id/stream
Accept: text/event-stream
```

## 9. Memories API

### 9.1 搜索相似记忆

```http
POST /memories/search
Content-Type: application/json

{
    "agent_id": "agent_abc123",
    "query": "关于项目架构的讨论",
    "limit": 10,
    "memory_type": "semantic",
    "min_similarity": 0.7
}
```

**Response**:

```json
{
    "success": true,
    "data": [
        {
            "id": "mem_001",
            "content": "用户讨论了微服务架构的优缺点...",
            "memory_type": "semantic",
            "importance": 0.8,
            "similarity": 0.92,
            "created_at": "2024-01-01T00:00:00Z"
        }
    ]
}
```

### 9.2 创建记忆

```http
POST /memories
Content-Type: application/json

{
    "agent_id": "agent_abc123",
    "content": "用户偏好使用 TypeScript",
    "memory_type": "semantic",
    "importance": 0.9,
    "metadata": {
        "source": "conversation",
        "confidence": 0.95
    }
}
```

### 9.3 删除记忆

```http
DELETE /memories/:id
```

## 10. Webhooks API

Webhook 允许您的服务器在特定事件发生时接收 HTTP 回调通知。

### 10.1 创建 Webhook

```http
POST /webhooks
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: application/json

{
    "url": "https://your-server.com/webhook",
    "events": ["session.completed", "agent.error", "quota.exceeded"],
    "secret": "your-webhook-secret",
    "description": "Production webhook"
}
```

**Response**:

```json
{
    "success": true,
    "data": {
        "id": "wh_abc123",
        "url": "https://your-server.com/webhook",
        "events": ["session.completed", "agent.error", "quota.exceeded"],
        "is_active": true,
        "created_at": "2024-01-01T00:00:00Z"
    }
}
```

### 10.2 列出 Webhooks

```http
GET /webhooks
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

### 10.3 更新 Webhook

```http
PUT /webhooks/:id
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
Content-Type: application/json

{
    "events": ["session.completed"],
    "is_active": false
}
```

### 10.4 删除 Webhook

```http
DELETE /webhooks/:id
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

### 10.5 测试 Webhook

```http
POST /webhooks/:id/test
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

**Response**:

```json
{
    "success": true,
    "data": {
        "delivered": true,
        "response_status": 200,
        "response_time_ms": 150
    }
}
```

### 10.6 支持的事件类型

| 事件 | 说明 |
| ---- | ---- |
| session.created | 会话创建 |
| session.completed | 会话完成 |
| session.failed | 会话失败 |
| agent.created | Agent 创建 |
| agent.updated | Agent 更新 |
| agent.deleted | Agent 删除 |
| agent.error | Agent 执行错误 |
| tool.error | 工具调用错误 |
| quota.warning | 配额使用达到 80% |
| quota.exceeded | 配额超限 |

### 10.7 Webhook 回调格式

```json
{
    "id": "evt_abc123",
    "type": "session.completed",
    "created_at": "2024-01-01T00:00:00Z",
    "data": {
        "session_id": "session_def456",
        "agent_id": "agent_xyz789",
        "status": "completed",
        "messages_count": 10,
        "tokens_used": 1500,
        "duration_ms": 12500
    }
}
```

### 10.8 签名验证

Webhook 请求包含签名头，用于验证请求真实性：

```http
X-Webhook-Signature: sha256=xxxxxxxxxxxx
X-Webhook-Timestamp: 1704067200
```

**验证示例** (Node.js):

```javascript
const crypto = require('crypto');

function verifyWebhook(payload, signature, timestamp, secret) {
    const signedPayload = `${timestamp}.${payload}`;
    const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(signedPayload)
        .digest('hex');

    return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(`sha256=${expectedSignature}`)
    );
}
```

---

## 11. 健康检查

```http
GET /health
```

**Response**:

```json
{
    "status": "healthy",
    "version": "1.0.0",
    "services": {
        "database": "connected",
        "redis": "connected",
        "llm": "available"
    }
}
```

## 11. 速率限制

| 端点 | 限制 |
| ---- | ---- |
| /chat | 60 requests/minute |
| /agents | 100 requests/minute |
| /skills | 100 requests/minute |
| /tools | 100 requests/minute |
| /sessions | 100 requests/minute |
| /memories | 100 requests/minute |

超出限制时返回:

```http
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1704067200

{
    "error": {
        "code": "rate_limit_exceeded",
        "message": "Too many requests, please retry after 60 seconds"
    }
}
```

## 12. WebSocket API

### 12.1 连接

```javascript
const ws = new WebSocket('wss://api.semibot.dev/v1/ws?token=sk-xxx');
```

### 12.2 消息格式

**发送消息**:

```json
{
    "type": "chat",
    "session_id": "session_def456",
    "content": "你好"
}
```

**接收响应**:

```json
{
    "type": "response",
    "session_id": "session_def456",
    "message_id": "msg_abc",
    "content": "你好！有什么可以帮助你的？",
    "done": true
}
```

**心跳**:

```json
// Client -> Server
{"type": "ping"}

// Server -> Client
{"type": "pong"}
```

## 13. Usage API

### 13.1 获取使用量统计

```http
GET /usage?period=daily&start=2024-01-01&end=2024-01-31
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

**Query Parameters**:

| 参数 | 类型 | 默认值 | 说明 |
| ---- | ---- | ------ | ---- |
| period | string | daily | 统计周期: hourly/daily/monthly |
| start | date | - | 开始日期 |
| end | date | - | 结束日期 |
| agent_id | string | - | 按 Agent 筛选 |

**Response**:

```json
{
    "success": true,
    "data": {
        "summary": {
            "tokens_input": 150000,
            "tokens_output": 50000,
            "api_calls": 1200,
            "sessions_count": 300,
            "cost_usd": 12.50
        },
        "by_period": [
            {
                "period_start": "2024-01-01T00:00:00Z",
                "tokens_input": 5000,
                "tokens_output": 2000,
                "api_calls": 50,
                "cost_usd": 0.45
            }
        ],
        "quota": {
            "max_tokens_per_month": 1000000,
            "used_tokens": 200000,
            "remaining_tokens": 800000,
            "reset_at": "2024-02-01T00:00:00Z"
        }
    }
}
```

### 13.2 获取配额信息

```http
GET /usage/quota
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

**Response**:

```json
{
    "success": true,
    "data": {
        "plan": "pro",
        "limits": {
            "max_agents": 20,
            "max_tokens_per_month": 1000000,
            "max_api_calls_per_day": 10000
        },
        "current": {
            "agents_count": 5,
            "tokens_used_this_month": 200000,
            "api_calls_today": 500
        }
    }
}
```

## 14. Execution Logs API

### 14.1 获取 Agent 执行日志

```http
GET /agents/:agent_id/logs?limit=50&session_id=xxx
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

**Query Parameters**:

| 参数 | 类型 | 默认值 | 说明 |
| ---- | ---- | ------ | ---- |
| limit | integer | 50 | 返回数量 (max: 200) |
| session_id | string | - | 按会话筛选 |
| state | string | - | 按状态筛选: PLAN/ACT/OBSERVE/REFLECT |
| has_error | boolean | - | 仅显示错误 |
| start | datetime | - | 开始时间 |
| end | datetime | - | 结束时间 |

**Response**:

```json
{
    "success": true,
    "data": [
        {
            "id": "log_abc123",
            "session_id": "session_def456",
            "state": "ACT",
            "action_type": "tool_call",
            "action_name": "web_search",
            "action_input": {"query": "AI agents"},
            "action_output": {"results": [...]},
            "duration_ms": 1234,
            "tokens_input": 100,
            "tokens_output": 500,
            "model": "gpt-4o",
            "created_at": "2024-01-01T10:30:00Z"
        }
    ],
    "meta": {
        "total": 150,
        "has_more": true
    }
}
```

### 14.2 获取单条日志详情

```http
GET /logs/:log_id
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

### 14.3 获取会话执行追踪

```http
GET /sessions/:session_id/trace
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

**Response**: 返回该会话的完整执行流程，包括所有状态转换和工具调用。

---

## 15. 通用约定

### 15.1 分页

```http
GET /agents?limit=20&cursor=xxx
```

- `limit` 默认 20，最大 100
- `cursor` 为游标（后端返回）

**Response**:

```json
{
    "success": true,
    "data": [...],
    "meta": {
        "next_cursor": "xxx"
    }
}
```

### 15.2 幂等请求

对于创建类接口，建议支持:

```http
Idempotency-Key: 1b9c4f1d-xxxx
```

后端应基于 `Idempotency-Key` + `user_id` 去重写入。

### 15.3 速率限制

响应头示例:

```http
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 10
X-RateLimit-Reset: 1700000000
```

### 15.4 请求追踪

```http
X-Request-Id: req_abc123
```

所有日志与 execution_logs 记录 `request_id`，便于跨服务追踪。
