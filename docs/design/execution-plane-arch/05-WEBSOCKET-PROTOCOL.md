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

- 首次连接：`ws(s)://{host}/ws/vm?user_id={id}&ticket={one_time_ticket}`
- 重连：`ws(s)://{host}/ws/vm?user_id={id}`（无 ticket）

| 参数 | 说明 |
|------|------|
| `user_id` | 用户 ID（UUID），必填 |
| `ticket` | 一次性连接票据（短时效，仅用于首次连接，使用后立即失效）。重连时不携带 |

> **安全说明**：WebSocket 连接不通过 URL query 传递长期 JWT，避免 token 泄露到日志和 Referer 头。连接建立后，执行平面通过首帧 `auth` 消息传输完整 JWT（见下方生命周期）。
>
> **ticket 定位**：ticket 仅用于调度层反滥用（防止未经授权的首次连接），不参与最终认证决策。安全边界完全由首帧 `auth` 消息中的 JWT 验证保障（JWT 有效 + user_id 匹配 + 存在活跃 VM 实例）。无 ticket 的连接（重连场景）只要通过 JWT 验证即为合法。

---

## 2. 连接生命周期

```
Execution Plane (User VM)             Control Plane
     │                                      │
     ├── WS Connect ──────────────────→     │
     │   ?user_id=xxx&ticket=yyy           │
     │                                      │
     ├── auth ──────────────────────→      │  (首帧：传输 JWT)
     │   {token: "jwt..."}                 │
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

所有消息均为 JSON，包含 `type` 字段。除以下消息外，所有消息必须包含 `session_id` 字段用于路由：

- VM 级消息：`heartbeat`、`init`、`auth`（无 session 上下文）
- 请求匹配消息：`response`、`resume_response`、`resume`（通过 `id` / `pending_ids` 关联请求，无需 `session_id`）

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

### 4.3 `request` — 请求-响应调用

需要控制平面返回结果的调用，通过 `id` 字段匹配请求与响应。

```json
{
  "type": "request",
  "session_id": "uuid",
  "id": "msg-uuid",
  "method": "get_skill_package | memory_search | mcp_call | get_config",
  "params": { ... }
}
```

#### 方法列表

| 方法 | 请求参数 | 返回值 |
|------|----------|--------|
| `get_skill_package` | `{skill_id: string, version?: string}` | `{package: {skill_id, version, files: [{path, content, encoding}], file_inventory}}` |
| `memory_search` | `{query: string, top_k?: number}` | `{results: [{content: string, score: number, metadata: object}]}` |
| `mcp_call` | `{server: string, tool: string, arguments: object}` | `{result: any}` |
| `get_config` | `{agent_id: string}` | `{config: object}` |
| `get_session` | `{session_id: string}` | `{session: object, agent: object}` |

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
    "runtime_type": "semigraph | openclaw",
    "agent_config": {
      "system_prompt": "string",
      "model": "string",
      "temperature": 0.7,
      "max_tokens": 4096
    },
    "skill_index": [
      {
        "id": "uuid",
        "name": "string",
        "description": "string",
        "version": "string",
        "source": "clawhub | upload | builtin",
        "file_inventory": {
          "has_skill_md": true,
          "has_scripts": true,
          "has_references": false,
          "script_files": ["scripts/main.py"],
          "reference_files": []
        },
        "requires": {
          "binaries": ["python3"],
          "env_vars": []
        }
      }
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
    },
    "openclaw_config": {
      "tool_profile": "coding",
      "skills": ["pdf", "web-search"]
    }
  }
}
```

| 字段 | 必需 | 说明 |
|------|------|------|
| `runtime_type` | 否 | 运行时类型，`semigraph`（默认）或 `openclaw` |
| `openclaw_config` | 否 | 仅 `runtime_type=openclaw` 时有效，OpenClaw 特有配置 |
| `openclaw_config.tool_profile` | 否 | OpenClaw 工具配置集（如 `coding`、`data-analysis`） |
| `openclaw_config.skills` | 否 | OpenClaw 原生 skill 列表 |

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
  "error": {"code": "SKILL_NOT_FOUND", "message": "Skill package xxx not found"}
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

#### cancel 语义定义

| 维度 | 说明 |
|------|------|
| 触发方 | 用户在前端点击"停止生成"按钮，控制平面下发 cancel |
| 作用范围 | 仅影响 `session_id` 对应的 session 进程，不影响同 VM 内其他 session |
| 执行平面行为 | 调用 `RuntimeAdapter.cancel()`，中断当前 LLM 流式输出和工具调用 |
| LLM 调用中断 | 立即关闭与 LLM API 的流式连接，停止产生新 token |
| 工具调用中断 | 正在执行的工具调用尝试取消（best-effort），已完成的工具结果保留 |
| SSE 事件 | 发送 `execution_complete` 事件（附带 `cancelled: true`），通知前端执行已终止。这是唯一的取消完成事件，不单独定义 `cancelled` 事件类型 |
| 状态保存 | cancel 后保存当前 checkpoint 和短期记忆，下次对话可从中断点继续 |
| 幂等性 | 对已完成或已取消的 session 重复发送 cancel 无副作用（静默忽略） |
| reason 字段 | 可选，用于审计日志。预定义值：`user_cancelled`（用户主动取消）、`timeout`（超时取消）、`admin`（管理员取消） |

#### cancel 处理流程

```
控制平面下发 cancel (session_id=X)
        │
        ▼
SessionManager 路由到 session X 的 RuntimeAdapter
        │
        ▼
adapter.cancel()
        │
        ├── SemiGraphAdapter: 取消 LangGraph 当前节点执行
        │   ├── 中断 LLM 流式调用
        │   ├── 尝试取消进行中的工具调用
        │   └── 保存当前 checkpoint
        │
        └── OpenClawBridgeAdapter: 发送 cancel 指令到 Bridge 进程
            ├── Bridge 中断 OpenClaw 执行
            └── Bridge 上报 execution_complete (cancelled: true)
        │
        ▼
通过 WS 发送 sse_event → 控制平面 → SSE → 前端
{type: "execution_complete", cancelled: true}
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
3. 重连 URL 不携带 ticket（已失效），仅携带 `user_id`
4. 连接建立后发送 `auth` 首帧（JWT 认证）
5. 认证通过后收到 `init` 消息
6. 发送 `resume` 消息，携带所有 session 的未完成请求 ID
7. 控制平面返回 `resume_response`，包含已缓存的请求结果
8. 对于 `not_found` 的请求，执行平面重新发送原始请求
9. 若所有重试均失败，pending 请求以 `ConnectionError` 超时
10. LangGraph observe 节点通过 replan 机制处理工具调用失败
11. 重连期间各 session 进程保持运行，本地资源（短期记忆、LLM 直连）不受影响

### 时序图

```
Execution Plane (User VM)             Control Plane
     |                                      |
     |  -- 连接断开 --                       |
     |                                      |
     |  [等待 1s]                            |
     |-- WS Reconnect ──────────────→       |
     |   ?user_id=xxx (无 ticket)          |
     |                                      |
     |-- auth ──────────────────────→       |
     |   {token: "jwt..."}                 |
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

所有 SSE 事件使用统一的类型命名规范（与 OpenClaw 事件翻译后的格式一致）：

```
id: 42
data: {"type":"text_chunk","content":"Hello"}

id: 43
data: {"type":"tool_call_start","tool_name":"search","tool_input":{}}

id: 44
data: {"type":"tool_call_complete","tool_name":"search","result":{}}

id: 45
data: {"type":"execution_complete","content":"Done."}

: heartbeat

event: resync
data: {}
```

#### 标准 SSE 事件类型

| 事件类型 | 说明 |
|---------|------|
| `text_chunk` | LLM 流式 token 输出 |
| `tool_call_start` | 工具调用开始 |
| `tool_call_complete` | 工具调用完成 |
| `skill_call_start` | Skill 调用开始 |
| `skill_call_complete` | Skill 调用完成 |
| `thinking` | 思考过程（stage 区分来源） |
| `execution_complete` | 执行完成 |
| `execution_error` | 执行错误 |

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

认证采用两阶段方案，避免 JWT 泄露到 URL 日志：

1. **连接阶段**：URL query 仅携带一次性 `ticket`（短时效，使用后失效），用于建立 WebSocket 连接
2. **首帧认证**：连接建立后，执行平面发送 `auth` 消息携带完整 JWT
3. 控制平面验证 JWT 后返回 `init` 消息；若验证失败，关闭连接（code `4001`）

```json
// 执行平面 → 控制平面（首帧）
{
  "type": "auth",
  "token": "eyJhbGciOiJSUzI1NiIs..."
}
```

- Token 为用户虚拟机级别，可访问该用户的所有 session 数据
- Token 由控制平面在分配虚拟机时签发，包含 user_id 和 org_id
- Ticket 由控制平面在调度 VM 时生成，有效期 30 秒，仅可使用一次
- 重连时不需要 ticket（已失效），URL 仅携带 `user_id`，认证完全依赖首帧 `auth` 消息中的 JWT

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
