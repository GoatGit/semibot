# 05 - WebSocket 协议规范

## 1. 协议概述

每个用户的虚拟机（执行平面）与控制平面之间通过**单条 WebSocket 连接**完成所有通信。一条连接承载该用户所有 session 的消息，通过 `session_id` 字段路由。

通信内容包括：

- VM 级管理（start_session / stop_session / heartbeat）
- SSE 事件中继（LLM 输出转发至前端，按 session_id 路由）
- MCP 工具调用
- Skill 文件加载
- 记忆检索
- 审计日志上报

所有消息均为 **JSON 文本帧**，不使用二进制帧。

### 连接地址

```
ws(s)://{host}/ws/vm?user_id={id}&token={jwt}
```

| 参数 | 说明 |
|------|------|
| `user_id` | 用户 ID（UUID） |
| `token` | 虚拟机级 JWT，可访问该用户的所有 session 数据 |

---

## 2. 连接生命周期

```
Execution Plane (User VM)             Control Plane
     │                                      │
     ├── WS Connect ──────────────────→     │
     │   ?user_id=xxx&token=yyy             │
     │                                      │
     │  ←── init ──────────────────────────┤
     │   {user_id, org_id, api_keys}       │
     │                                      │
     ├── heartbeat ──────────────────→      │  (every 10s)
     │                                      │
     │  ←── start_session ─────────────────┤  (new session created)
     │   {session_id, agent_config, ...}   │
     │                                      │
     │  ←── user_message ──────────────────┤  (user sends chat)
     │   {session_id, data: {...}}         │
     │                                      │
     ├── sse_event ──────────────────→      │  (LLM tokens, with session_id)
     ├── request (mcp_call) ─────────→      │  (with session_id)
     │  ←── response ──────────────────────┤
     ├── fire_and_forget (audit) ────→      │  (with session_id)
     │                                      │
     │  ←── cancel ────────────────────────┤  (user cancels, with session_id)
     │                                      │
     │  ←── stop_session ──────────────────┤  (session ended)
     │   {session_id}                      │
     │                                      │
     ├── WS Close ───────────────────→      │  (VM shutdown)
```

---

## 3. 消息格式

所有消息均为 JSON，包含 `type` 字段。除 VM 级消息（heartbeat、init）外，所有消息必须包含 `session_id` 字段用于路由。

```json
{
  "type": "string",
  "session_id": "uuid",
  "timestamp": "ISO8601"
}
```

消息按方向分为两类：

- **上行消息**（Execution Plane → Control Plane）
- **下行消息**（Control Plane → Execution Plane）

---

## 4. 上行消息（Execution Plane → Control Plane）

### 4.1 `heartbeat` — 心跳（VM 级）

每 10 秒发送一次，维持连接活跃。包含当前活跃 session 列表。

```json
{
  "type": "heartbeat",
  "active_sessions": ["session-1", "session-2"]
}
```

### 4.2 `sse_event` — LLM 输出转发

将 LLM 产生的流式输出转发至前端。`data` 字段为序列化后的 Agent2UI 消息，控制平面根据 `session_id` 路由到对应的前端 SSE 流，**直接写入**，无需解析。

```json
{
  "type": "sse_event",
  "session_id": "uuid",
  "data": "{\"type\":\"text\",\"content\":\"Hello\"}"
}
```

### 4.3 `request` — 请求-响应��用

需要控制平面返回结果的调用，通过 `id` 字段匹配请求与响应。

```json
{
  "type": "request",
  "session_id": "uuid",
  "id": "msg-uuid",
  "method": "get_skill_files | memory_search | mcp_call | get_config",
  "params": { ... }
}
```

#### 方法列表

| 方法 | 请求参数 | 返回值 |
|------|----------|--------|
| `get_skill_files` | `{skill_id: string, version?: string}` | `{files: [{name: string, content: string}]}` |
| `memory_search` | `{query: string, top_k?: number}` | `{results: [{content: string, score: number, metadata: object}]}` |
| `mcp_call` | `{server: string, tool: string, arguments: object}` | `{result: any}` |
| `get_config` | `{agent_id: string}` | `{config: object}` |

### 4.4 `fire_and_forget` — 单向通知

不需要响应的消息，用于上报统计和审计数据。

```json
{
  "type": "fire_and_forget",
  "session_id": "uuid",
  "method": "usage_report | audit_log | evolution_submit | snapshot_sync",
  "params": { ... }
}
```

#### 方法列表

| 方法 | 参数 | 说明 |
|------|------|------|
| `usage_report` | `{model: string, tokens_in: number, tokens_out: number, latency_ms?: number}` | Token 用量上报 |
| `audit_log` | `{event: string, details: object}` | 审计日志 |
| `evolution_submit` | `{name: string, description: string, skill_md: string, quality_score: number}` | Skill 进化提交 |
| `snapshot_sync` | `{checkpoint: object, short_term_memory: object, conversation_state?: object, file_manifest?: object}` | 状态快照同步 |

### 4.5 `resume` — 重连恢复

断线重连后发送，携带所有 session 的未完成请求 ID 列表，请求控制平面返回已缓存的结果。

```json
{
  "type": "resume",
  "pending_ids": ["msg-1", "msg-2"]
}
```

---

## 5. 下行消息（Control Plane → Execution Plane）

### 5.1 `init` — 初始化配置（VM 级）

连接建立后立即下发，包含用户级配置。

```json
{
  "type": "init",
  "data": {
    "user_id": "uuid",
    "org_id": "uuid",
    "api_keys": {
      "openai": "sk-...",
      "anthropic": "sk-ant-..."
    }
  }
}
```

### 5.2 `start_session` — 启动 Session

控制平面要求执行平面启动新的 session 进程。

```json
{
  "type": "start_session",
  "data": {
    "session_id": "uuid",
    "agent_config": {
      "system_prompt": "string",
      "model": "string",
      "temperature": 0.7,
      "max_tokens": 4096
    },
    "skill_index": [
      {"id": "uuid", "name": "string", "description": "string", "version": "string"}
    ],
    "mcp_servers": [
      {"name": "github", "type": "remote"},
      {"name": "filesystem", "type": "local", "command": "mcp-server-filesystem", "args": ["/"]}
    ],
    "sub_agents": [
      {"id": "uuid", "name": "string", "description": "string"}
    ],
    "session_config": {
      "max_turns": 50,
      "timeout_seconds": 3600
    }
  }
}
```

### 5.3 `stop_session` — 停止 Session

控制平面要求执行平面停止指定 session。

```json
{
  "type": "stop_session",
  "data": {
    "session_id": "uuid",
    "reason": "user_closed | timeout | admin"
  }
}
```

### 5.4 `response` — 请求响应

对上行 `request` 消息的响应，通过 `id` 匹配。

成功：

```json
{
  "type": "response",
  "id": "msg-uuid",
  "result": { ... },
  "error": null
}
```

失败：

```json
{
  "type": "response",
  "id": "msg-uuid",
  "result": null,
  "error": {"code": "SKILL_NOT_FOUND", "message": "Skill xxx not found"}
}
```

### 5.5 `user_message` — 用户消息

用户发送新的聊天消息时下发，带 `session_id` 路由到对应 session 进程。

```json
{
  "type": "user_message",
  "session_id": "uuid",
  "data": {
    "message": "string",
    "history": [
      {"role": "user", "content": "..."},
      {"role": "assistant", "content": "..."}
    ],
    "metadata": {}
  }
}
```

### 5.6 `cancel` — 取消执行

用户取消指定 session 中正在执行的任务。

```json
{
  "type": "cancel",
  "session_id": "uuid",
  "reason": "user_cancelled"
}
```

### 5.7 `config_update` — 热更新配置

运行时动态更新指定 session 的配置参数，无需重连。

```json
{
  "type": "config_update",
  "session_id": "uuid",
  "data": {
    "temperature": 0.5
  }
}
```

### 5.8 `resume_response` — 重连恢复响应

对上行 `resume` 消息的响应，返回每个 pending 请求的状态。

```json
{
  "type": "resume_response",
  "results": {
    "msg-1": {"status": "completed", "data": {...}},
    "msg-2": {"status": "not_found"}
  }
}
```

---

## 6. 断线重连协议

### 重连流程

1. 执行平面检测到连接断开
2. 指数退避重试：`1s -> 2s -> 4s -> 8s -> 16s -> 30s -> 30s -> 30s ...`
3. 重连成功后收到 `init` 消息
4. 发送 `resume` 消息，携带所有 session 的未完成请求 ID
5. 控制平面返回 `resume_response`，包含已缓存的请求结果
6. 对于 `not_found` 的请求，执行平面重新发送原始请求
7. 若所有重试均失败，pending 请求以 `ConnectionError` 超时
8. LangGraph observe 节点通过 replan 机制处理工具调用失败
9. 重连期间各 session 进程保持运行，本地资源（短期记忆、LLM 直连）不受影响

### 时序图

```
Execution Plane (User VM)             Control Plane
     |                                      |
     |  -- 连接断开 --                       |
     |                                      |
     |  [等待 1s]                            |
     |-- WS Reconnect ──────────────→       |
     |   ?user_id=xxx&token=yyy             |
     |                                      |
     |  <── init ──────────────────────────-|
     |                                      |
     |-- resume ───────────────────→        |
     |   {pending_ids: ["msg-1"]}           |
     |                                      |
     |  <── resume_response ───────────────-|
     |   {msg-1: {status: "completed"}}     |
     |                                      |
```

---

## 7. SSE 中继协议

### 前端连接

```
GET /api/v1/sessions/{session_id}/stream?last_event_id=0
```

前端 SSE 连接仍然是 per-session 的（每个 session 一个 SSE 流）。控制平面根据 WebSocket 消息中的 `session_id` 将事件路由到对应的前端 SSE 流。

### 工作机制

1. 控制平面为每个 session 维护 **SSEBuffer**（环形缓冲区，容量 500 条事件）
2. 每条来自 WebSocket 的 `sse_event` 消息根据 `session_id` 分配到对应缓冲区，递增 event ID
3. 前端断线重连时携带 `last_event_id`，从缓冲区回放后续事件
4. 若缓冲区已溢出（请求的 event ID 已被覆盖），发送 `resync` 事件，前端获取完整状态快照

### SSE 事件格式

```
id: 42
data: {"type":"text","content":"Hello"}

id: 43
data: {"type":"tool_call","name":"search","args":{}}

: heartbeat

event: resync
data: {}
```

---

## 8. 错误处理

### 超时配置

| 场景 | 默认超时 |
|------|----------|
| 通用 request | 60s（可按方法配置） |
| MCP 调用 | 继承 MCP server 配置 |

### 错误处理策略

| 场景 | 处理方式 |
|------|----------|
| 消息格式错误 | 记录 warning 日志，跳过该消息（不断开连接） |
| 认证失败 | 关闭连接，code `4001` |
| 用户不存在 | 关闭连接，code `4004` |
| Session 不存在 | 返回错误消息（不断开连接，因为其他 session 可能正常） |
| 触发限流 | 关闭连接，code `4029` |

### WebSocket 关闭码

| 关闭码 | 含义 |
|--------|------|
| `4001` | 认证失败（Authentication failed） |
| `4004` | 用户不存在（User not found） |
| `4008` | 初始化超时（执行平面未在规定时间内连接） |
| `4029` | 触发限流（Rate limited） |
| `4500` | 服务端内部错误（Internal server error） |

---

## 9. 安全

### 认证

- JWT token 通过 query parameter 传递（WebSocket 不便使用自定义 Header）
- Token 为用户虚拟机级别，可访问该用户的所有 session 数据
- Token 由控制平面在分配虚拟机时签发，包含 user_id 和 org_id

### API Key 注入

- `init` 消息中的 `api_keys` 字段为加密传输
- 执行平面在内存中解密使用，不落盘
- 所有 session 共享同一组 API Key

### 消息限制

| 限制项 | 阈值 |
|--------|------|
| 单帧大小上限 | 10 MB |
| 每连接消息频率上限 | 1000 条/分钟 |

---

## 10. 监控指标

| 指标名 | 类型 | 说明 |
|--------|------|------|
| `ws_connections_active` | Gauge | 当前活跃 WebSocket 连接数（= 活跃用户 VM 数） |
| `ws_sessions_per_connection` | Gauge（按 user_id 分） | 每条连接承载的 session 数 |
| `ws_messages_sent_total` | Counter（按 type 分） | 发送消息总数 |
| `ws_messages_received_total` | Counter（按 type 分） | 接收消息总数 |
| `ws_reconnections_total` | Counter | 重连次数 |
| `ws_request_duration_seconds` | Histogram（按 method 分） | request-response 耗时分布 |
| `sse_buffer_size` | Gauge（按 session_id 分） | SSE 缓冲区当前大小 |
| `sse_events_forwarded_total` | Counter | SSE 事件转发总数 |
