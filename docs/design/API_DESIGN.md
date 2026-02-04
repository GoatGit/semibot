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

### 2.3 多语言支持

通过 `Accept-Language` 请求头指定响应语言：

```http
Accept-Language: zh-CN
```

**支持的语言**：

| 语言代码 | 语言 |
| -------- | ---- |
| zh-CN | 简体中文（默认） |
| en-US | English |
| ja-JP | 日本語 |
| ko-KR | 한국어 |

**响应示例**：

```json
// Accept-Language: zh-CN
{
    "error": {
        "code": "AUTH_INVALID_TOKEN",
        "message": "提供的 Token 无效或已过期",
        "status": 401
    }
}

// Accept-Language: en-US
{
    "error": {
        "code": "AUTH_INVALID_TOKEN",
        "message": "The provided token is invalid or expired",
        "status": 401
    }
}
```

### 2.4 错误响应

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

### 8.1 Agent2UI 消息规范

Chat API 遵循 **Agent2UI** 设计规范：后端只输出结构化 JSON 数据，前端组件负责渲染。

**消息类型定义**：

```typescript
interface Agent2UIMessage {
  id: string                    // 消息唯一标识
  type: Agent2UIType            // 消息类型，决定前端渲染组件
  data: Agent2UIData            // 类型对应的数据结构
  timestamp: string             // ISO 8601 时间戳
  metadata?: {
    model?: string              // 使用的模型
    tokens_used?: number        // Token 消耗
    latency_ms?: number         // 延迟毫秒数
    [key: string]: unknown
  }
}

type Agent2UIType =
  | 'text'           // 纯文本 → TextBlock
  | 'markdown'       // Markdown → MarkdownBlock
  | 'code'           // 代码块 → CodeBlock
  | 'table'          // 数据表格 → DataTable
  | 'chart'          // 图表 → Chart
  | 'image'          // 图片 → ImageView
  | 'file'           // 文件 → FileDownload
  | 'plan'           // 执行计划 → PlanView
  | 'progress'       // 进度 → ProgressView
  | 'tool_call'      // 工具调用 → ToolCallView
  | 'tool_result'    // 工具结果 → ToolResultView
  | 'thinking'       // 思考过程 → ThinkingView
  | 'report'         // 结构化报告 → ReportView
  | 'error'          // 错误信息 → ErrorView
```

### 8.2 发送消息

```http
POST /chat
Content-Type: application/json

{
    "session_id": "session_def456",
    "message": "帮我分析这份销售数据并生成报告",
    "stream": false,
    "attachments": [
        {
            "type": "file",
            "url": "https://example.com/sales.csv",
            "name": "sales.csv"
        }
    ]
}
```

**Response** (非流式):

```json
{
    "success": true,
    "data": {
        "session_id": "session_def456",
        "messages": [
            {
                "id": "msg_001",
                "type": "thinking",
                "data": {
                    "content": "正在分析销售数据...",
                    "steps": ["读取 CSV 文件", "解析数据结构", "计算统计指标"]
                },
                "timestamp": "2024-01-01T00:00:01Z"
            },
            {
                "id": "msg_002",
                "type": "table",
                "data": {
                    "columns": [
                        {"key": "product", "title": "产品", "type": "string"},
                        {"key": "q1", "title": "Q1销量", "type": "number"},
                        {"key": "q2", "title": "Q2销量", "type": "number"},
                        {"key": "q3", "title": "Q3销量", "type": "number"},
                        {"key": "growth", "title": "增长率", "type": "string"}
                    ],
                    "rows": [
                        {"product": "产品A", "q1": 1200, "q2": 1450, "q3": 1680, "growth": "+40%"},
                        {"product": "产品B", "q1": 800, "q2": 920, "q3": 1100, "growth": "+38%"},
                        {"product": "产品C", "q1": 650, "q2": 580, "q3": 520, "growth": "-20%"}
                    ],
                    "pagination": {"page": 1, "pageSize": 10, "total": 3}
                },
                "timestamp": "2024-01-01T00:00:02Z"
            },
            {
                "id": "msg_003",
                "type": "chart",
                "data": {
                    "chartType": "line",
                    "title": "季度销量趋势",
                    "xAxis": {"data": ["Q1", "Q2", "Q3"]},
                    "yAxis": {"name": "销量"},
                    "series": [
                        {"name": "产品A", "data": [1200, 1450, 1680]},
                        {"name": "产品B", "data": [800, 920, 1100]},
                        {"name": "产品C", "data": [650, 580, 520]}
                    ]
                },
                "timestamp": "2024-01-01T00:00:03Z"
            },
            {
                "id": "msg_004",
                "type": "report",
                "data": {
                    "title": "销售数据分析报告",
                    "sections": [
                        {
                            "heading": "分析结论",
                            "content": [
                                {
                                    "type": "markdown",
                                    "data": {"content": "根据 Q1-Q3 销售数据分析，主要发现如下：\n\n### 1. 增长趋势\n- 产品A 和 产品B 呈现持续增长态势\n- 产品C 需要关注，连续三个季度下滑"}
                                }
                            ]
                        },
                        {
                            "heading": "建议措施",
                            "content": [
                                {
                                    "type": "markdown",
                                    "data": {"content": "1. 加大产品A的市场投入\n2. 分析产品C下滑原因，考虑产品升级或淘汰\n3. 产品B可考虑扩展到新市场"}
                                }
                            ]
                        }
                    ],
                    "summary": "整体销售趋势向好，建议重点关注产品C的改进"
                },
                "timestamp": "2024-01-01T00:00:04Z",
                "metadata": {
                    "model": "gpt-4o",
                    "tokens_used": 1256,
                    "latency_ms": 3456
                }
            }
        ]
    }
}
```

### 8.3 流式响应 (SSE)

```http
POST /chat
Content-Type: application/json

{
    "session_id": "session_def456",
    "message": "请详细解释一下",
    "stream": true
}
```

**Response** (SSE - Agent2UI 格式):

```text
event: session_start
data: {"session_id": "session_def456", "started_at": "2024-01-01T00:00:00Z"}

event: message
data: {"id": "msg_001", "type": "thinking", "data": {"content": "正在分析问题..."}, "timestamp": "2024-01-01T00:00:01Z"}

event: message
data: {"id": "msg_002", "type": "plan", "data": {"steps": [{"id": "1", "title": "理解需求", "status": "completed"}, {"id": "2", "title": "搜索资料", "status": "running"}, {"id": "3", "title": "生成报告", "status": "pending"}], "currentStep": "2"}, "timestamp": "2024-01-01T00:00:02Z"}

event: message
data: {"id": "msg_003", "type": "tool_call", "data": {"toolName": "web_search", "arguments": {"query": "AI agent technology 2024"}, "status": "calling"}, "timestamp": "2024-01-01T00:00:03Z"}

event: message
data: {"id": "msg_003", "type": "tool_call", "data": {"toolName": "web_search", "arguments": {"query": "AI agent technology 2024"}, "status": "success", "result": {"items": [...]}, "duration": 1200}, "timestamp": "2024-01-01T00:00:04Z"}

event: message
data: {"id": "msg_004", "type": "plan", "data": {"steps": [{"id": "1", "title": "理解需求", "status": "completed"}, {"id": "2", "title": "搜索资料", "status": "completed"}, {"id": "3", "title": "生成报告", "status": "running"}], "currentStep": "3"}, "timestamp": "2024-01-01T00:00:05Z"}

event: message
data: {"id": "msg_005", "type": "markdown", "data": {"content": "好的，我来详细解释一下..."}, "timestamp": "2024-01-01T00:00:06Z"}

event: message_delta
data: {"id": "msg_005", "delta": "根据最新研究，AI Agent 技术主要包括..."}

event: message_delta
data: {"id": "msg_005", "delta": "以下几个核心方向："}

event: message
data: {"id": "msg_006", "type": "table", "data": {"columns": [...], "rows": [...]}, "timestamp": "2024-01-01T00:00:10Z"}

event: message
data: {"id": "msg_007", "type": "chart", "data": {"chartType": "bar", "title": "技术对比", "series": [...]}, "timestamp": "2024-01-01T00:00:11Z"}

event: message
data: {"id": "msg_008", "type": "report", "data": {"title": "AI Agent 技术分析报告", "sections": [...]}, "timestamp": "2024-01-01T00:00:12Z"}

event: session_end
data: {"session_id": "session_def456", "tokens_used": 2048, "latency_ms": 12000, "message_count": 8}
```

### 8.4 SSE 事件类型说明

| 事件类型 | 说明 | 前端处理 |
| -------- | ---- | -------- |
| `session_start` | 会话开始 | 初始化状态 |
| `message` | 完整的 Agent2UI 消息 | 根据 `type` 路由到对应组件渲染 |
| `message_delta` | 文本增量更新 | 追加到指定 `id` 消息的 content |
| `session_end` | 会话结束 | 更新统计信息，结束 loading 状态 |
| `error` | 错误信息 | 显示错误提示 |

### 8.5 获取流式响应 (GET 方式 - 重连)

```http
GET /chat/:session_id/stream?last_event_id=msg_005
Accept: text/event-stream
```

用于 SSE 断线重连，从指定 `last_event_id` 后继续接收消息。

### 8.6 Agent2UI 数据结构详解

#### 8.6.1 text / markdown

```json
{
    "type": "markdown",
    "data": {
        "content": "## 标题\n\n这是正文内容，支持 **加粗** 和 *斜体*。"
    }
}
```

#### 8.6.2 code

```json
{
    "type": "code",
    "data": {
        "language": "typescript",
        "content": "function hello() {\n  console.log('Hello, World!');\n}",
        "filename": "example.ts",
        "highlightLines": [2]
    }
}
```

#### 8.6.3 table

```json
{
    "type": "table",
    "data": {
        "columns": [
            {"key": "name", "title": "名称", "type": "string", "sortable": true},
            {"key": "value", "title": "数值", "type": "number", "sortable": true},
            {"key": "date", "title": "日期", "type": "date"}
        ],
        "rows": [
            {"name": "项目A", "value": 100, "date": "2024-01-01"},
            {"name": "项目B", "value": 200, "date": "2024-01-02"}
        ],
        "pagination": {"page": 1, "pageSize": 10, "total": 100},
        "exportable": true
    }
}
```

#### 8.6.4 chart

```json
{
    "type": "chart",
    "data": {
        "chartType": "line",
        "title": "趋势图",
        "xAxis": {"data": ["Jan", "Feb", "Mar", "Apr"]},
        "yAxis": {"name": "数值", "min": 0},
        "series": [
            {"name": "系列1", "data": [120, 200, 150, 80]},
            {"name": "系列2", "data": [80, 100, 140, 200]}
        ],
        "legend": true
    }
}
```

支持的 `chartType`: `line`, `bar`, `pie`, `scatter`, `area`, `radar`

#### 8.6.5 plan

```json
{
    "type": "plan",
    "data": {
        "steps": [
            {"id": "1", "title": "分析需求", "status": "completed", "duration": 1200},
            {"id": "2", "title": "搜索资料", "status": "completed", "duration": 3400},
            {"id": "3", "title": "数据处理", "status": "running"},
            {"id": "4", "title": "生成报告", "status": "pending"}
        ],
        "currentStep": "3",
        "estimatedRemaining": 5000
    }
}
```

`status` 枚举: `pending`, `running`, `completed`, `failed`, `skipped`

#### 8.6.6 tool_call

```json
{
    "type": "tool_call",
    "data": {
        "toolName": "web_search",
        "arguments": {"query": "AI news 2024", "limit": 10},
        "status": "success",
        "result": {
            "items": [
                {"title": "...", "url": "...", "snippet": "..."}
            ]
        },
        "duration": 1500
    }
}
```

`status` 枚举: `calling`, `success`, `error`

#### 8.6.7 thinking

```json
{
    "type": "thinking",
    "data": {
        "content": "正在分析用户请求...",
        "steps": [
            "识别关键信息",
            "确定执行策略",
            "准备调用工具"
        ],
        "collapsed": false
    }
}
```

#### 8.6.8 report

```json
{
    "type": "report",
    "data": {
        "title": "数据分析报告",
        "generatedAt": "2024-01-01T12:00:00Z",
        "sections": [
            {
                "heading": "概述",
                "content": [
                    {"type": "markdown", "data": {"content": "本报告分析了..."}}
                ]
            },
            {
                "heading": "数据展示",
                "content": [
                    {"type": "table", "data": {"columns": [...], "rows": [...]}},
                    {"type": "chart", "data": {"chartType": "bar", ...}}
                ]
            },
            {
                "heading": "结论与建议",
                "content": [
                    {"type": "markdown", "data": {"content": "## 主要发现\n\n1. ..."}}
                ]
            }
        ],
        "summary": "报告摘要内容...",
        "exportFormats": ["pdf", "docx", "html"]
    }
}
```

#### 8.6.9 image

```json
{
    "type": "image",
    "data": {
        "url": "https://example.com/chart.png",
        "alt": "销售趋势图",
        "width": 800,
        "height": 600,
        "caption": "图1: 2024年Q1-Q3销售趋势"
    }
}
```

#### 8.6.10 file

```json
{
    "type": "file",
    "data": {
        "name": "report.pdf",
        "url": "https://example.com/files/report.pdf",
        "size": 1024000,
        "mimeType": "application/pdf",
        "expiresAt": "2024-01-02T00:00:00Z"
    }
}
```

#### 8.6.11 error

```json
{
    "type": "error",
    "data": {
        "code": "TOOL_EXECUTION_FAILED",
        "message": "工具执行失败：无法连接到外部服务",
        "recoverable": true,
        "suggestion": "请稍后重试，或尝试其他方式"
    }
}
```

#### 8.6.12 progress

```json
{
    "type": "progress",
    "data": {
        "current": 75,
        "total": 100,
        "label": "处理数据中...",
        "unit": "%"
    }
}
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

## 12. 速率限制

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

## 13. WebSocket API

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

## 14. Usage API

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

## 15. Execution Logs API

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

## 16. 通用约定

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
