# API 设计

## 1. 概述

API 采用 RESTful 风格设计，使用 JSON 作为数据交换格式。

**Base URL**: `https://api.semibot.dev/v1`

## 2. 认证

### 2.1 API Key 认证

```http
Authorization: Bearer sk-xxxxxxxxxxxxx
```

### 2.2 错误响应

```json
{
    "error": {
        "code": "unauthorized",
        "message": "Invalid API key",
        "status": 401
    }
}
```

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
        "total": 100,
        "page": 1,
        "limit": 20,
        "has_more": true
    }
}
```

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
GET /agents?page=1&limit=20&status=active
```

**Query Parameters**:

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| page | integer | 1 | 页码 |
| limit | integer | 20 | 每页数量 (max: 100) |
| status | string | - | 过滤状态: active/inactive |
| search | string | - | 搜索名称/描述 |

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

```
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

## 10. 健康检查

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
|------|------|
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
