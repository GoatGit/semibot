# Gateway Context Service 重构详细方案

> 版本：2.0 | 日期：2026-02-28 | 状态：设计中（下一阶段实现）

## 1. 结论与目标

本次 Gateway 重构采用以下固定结论：

1. `runtime` 保持单层 session 架构，不引入 runtime 内部父/子 session。
2. 在入口层新增统一 `Gateway Context Service`（GCS），集中处理各 Gateway 会话上下文。
3. 策略采用：`主会话固定 + 子任务运行时隔离 + 最小结果回写`，不做全量 merge。
4. 不让每个 Gateway（Telegram/飞书）各自实现 fork/merge 逻辑，统一由 GCS 实现。

目标：

1. 让 Telegram / 飞书 / Web 等入口共享同一套会话治理逻辑。
2. 保证并发安全（单会话单写者），避免上下文污染。
3. 降低复杂度：不在 runtime 引入会话分叉树。

---

## 2. 核心语义

### 2.1 会话模型

1. `Gateway 主会话(main_context)`：每个外部聊天会话一个固定主上下文。
2. `Runtime 执行会话(runtime_session)`：每个任务创建一个新的 runtime session（隔离执行）。
3. `最小回写`：任务结束后仅把结构化结果摘要写回主会话，不回写完整中间状态。

### 2.2 Telegram 映射

1. 主会话键：`gateway_key = telegram:{bot_id}:{chat_id}`
2. 同一 `chat_id + bot_id` 始终命中同一个 `main_context_id`。
3. 每条新任务消息触发一个新的 `runtime_session_id`。

### 2.3 Feishu 映射

1. 主会话键：`gateway_key = feishu:{app_id}:{conversation_id}`  
2. `conversation_id` 统一取“可稳定标识会话”的字段：群聊优先 `chat_id`，单聊可用 `open_id/union_id`（按实际回调字段归一化）。  
3. 同一飞书会话固定命中一个 `main_context_id`，每条任务消息创建独立 `runtime_session_id`。  

### 2.4 单写者规则

1. 主会话由 GCS 串行写入（append-only），避免并发覆盖。
2. Runtime 不直接修改 Gateway 主会话。
3. Runtime 只产出结果，GCS 负责最小回写和对外发送。

---

## 3. 分层与边界

```text
Gateway Adapter (Telegram/Feishu)
        │ 入站消息标准化
        ▼
Gateway Context Service (统一)
        │ 会话映射/并发治理/审批聚合/最小回写
        ▼
Runtime API (单层 session 执行)
        │ 执行任务
        ▼
Event Engine / Orchestrator / Tools
```

边界清单：

1. Gateway Adapter：仅协议适配、签名校验、消息反序列化。
2. GCS：上下文管理、任务分发、审批聚合、结果回写、幂等去重。
3. Runtime：任务执行与能力编排，不感知 Gateway 父子关系。

---

## 4. 数据模型（SQLite）

> 说明：以下是新增表；`gateway_configs` 继续保留。

### 4.1 `gateway_conversations`

```sql
CREATE TABLE IF NOT EXISTS gateway_conversations (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,                   -- telegram | feishu
  gateway_key TEXT NOT NULL UNIQUE,         -- telegram:{bot_id}:{chat_id}
  bot_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  main_context_id TEXT NOT NULL,            -- 固定主上下文ID
  latest_context_version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',    -- active | archived
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 4.2 `gateway_context_messages`

```sql
CREATE TABLE IF NOT EXISTS gateway_context_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  context_version INTEGER NOT NULL,
  role TEXT NOT NULL,                       -- user | assistant | system | approval
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(conversation_id, context_version)
);
```

### 4.3 `gateway_task_runs`

```sql
CREATE TABLE IF NOT EXISTS gateway_task_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  runtime_session_id TEXT NOT NULL,
  source_message_id TEXT,
  snapshot_version INTEGER NOT NULL,        -- 启动时主上下文版本
  status TEXT NOT NULL,                     -- queued|running|done|failed|cancelled
  result_summary TEXT,
  result_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gateway_task_runs_conv ON gateway_task_runs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_gateway_task_runs_runtime_session ON gateway_task_runs(runtime_session_id);
```

### 4.4 `gateway_write_locks`（可选）

```sql
CREATE TABLE IF NOT EXISTS gateway_write_locks (
  conversation_id TEXT PRIMARY KEY,
  owner_run_id TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  fencing_token INTEGER NOT NULL
);
```

---

## 5. 执行流程

## 5.1 入站新任务（Telegram 示例）

1. Adapter 收到 webhook，校验签名与 `allowedChatIds`。
2. GCS 用 `telegram:{bot_id}:{chat_id}` 定位/创建 `gateway_conversation`。
3. GCS 写入用户消息到 `gateway_context_messages`（version +1）。
4. GCS 先执行“是否在问我”识别（Addressing Gate）：
   - 命中：进入任务执行流程；
   - 未命中：仅保留上下文，不创建任务，不对外回复。
5. 命中后，GCS 基于当前 `latest_context_version` 生成任务快照，创建 `gateway_task_runs`。
6. GCS 为该任务创建新的 `runtime_session_id`，调用 runtime 执行。
7. Runtime 完成后返回结果。
8. GCS 将“最小结果摘要 + 产物链接 + 审批结论”回写主会话（version +1）。
9. GCS 调用 Adapter 向 Telegram 发回消息。

## 5.3 Addressing Gate（是否在问 bot）

目标：在“可接收全部群消息”的模式下，避免无关消息触发执行与刷屏。

判定顺序（建议）：

1. 显式命中：`@bot`、回复 bot 消息、命令前缀（如 `/ask`、`/run`）。
2. 会话命中：最近 N 分钟内 bot 与该用户有连续对话且意图延续。
3. 规则命中：用户自定义关键词/正则（例如“请 semibot …”）。
4. 未命中：只写入主会话上下文，标记 `addressed=false`，不触发 runtime。

审计要求：

1. 所有入站消息都要落库（包括未命中消息）。
2. `metadata_json` 记录 `addressed`, `address_reason`, `should_execute`。

## 5.2 审批流（通用）

1. 审批请求在 GCS 聚合（按 `conversation_id` + 风险级别 + 时间窗口）。
2. 对话中用户回复“同意/拒绝/approve/reject/全部同意/全部拒绝”。
3. Adapter 标准化为审批动作，GCS 解析并路由到对应运行任务。
4. 审批动作和结果同步写入 `gateway_context_messages`。

---

## 6. 并发策略

## 6.1 默认策略

1. 入站消息可并发建任务（多 `runtime_session_id`）。
2. 主会话写入由 GCS 串行提交（单写者）。
3. 若同一会话高并发，优先保证顺序与审计一致性，不做“最后写覆盖”。

## 6.2 为什么不用“指针切到最新子会话”

1. 会导致并发任务互相争夺“当前指针”。
2. 完成顺序与发起顺序不一致时，链路回放会混乱。
3. 主上下文失去稳定锚点，不利于审批/审计/重放。

---

## 7. 与 runtime 的接口约束

GCS -> Runtime 最小调用约束：

1. 输入：`agent_id`、`runtime_session_id`、`prompt`、`context_snapshot`。
2. 输出：`final_response`、`artifacts[]`、`risk_decisions[]`、`status`。
3. 约束：Runtime 不反向写 Gateway 主上下文；回写统一由 GCS 完成。

---

## 8. API 影响

外部 API 基本保持不变：

1. 保留现有 webhook 入口：`/v1/integrations/telegram/webhook`、`/v1/integrations/feishu/*`。
2. 新增内部服务接口（可先不对外公开）：
   - `GatewayContextService.create_task_run(...)`
   - `GatewayContextService.append_main_context(...)`
   - `GatewayContextService.resolve_approval_action(...)`

可选新增运维 API（后续）：

1. `GET /v1/gateway/conversations`
2. `GET /v1/gateway/conversations/{id}/runs`
3. `GET /v1/gateway/conversations/{id}/context`

---

## 9. 落地步骤（建议）

1. 引入 GCS 模块与 SQLite 表（不改外部接口）。
2. 将 Telegram 入站链路从“直接 runtime 调用”切换为“先过 GCS”。
3. 将飞书链路接入同一 GCS。
4. 接入审批聚合与批量审批语义。
5. 增加会话/任务运维查询接口与 E2E 测试。

---

## 10. 验收标准（DoD）

1. Runtime 仍是单层 session，不存在 runtime 父子 session 逻辑。
2. Telegram/飞书都通过同一 GCS 进行上下文管理。
3. 每个 `chat_id + bot_id` 对应固定主会话，且能持续积累上下文。
4. 每条任务都有独立 `runtime_session_id`，并可并发执行。
5. 任务结束后仅最小回写，不做全量 merge，且可审计回放。

---

## 11. 设计权衡（全量接收 + Addressing Gate）

## 11.1 好处

1. 上下文完整：bot 能理解群聊背景，减少“断上下文”回复。  
2. 主动能力增强：可基于群内事件做提醒、预警、跟进建议。  
3. 审计完整：所有入站消息可回放，可追踪决策来源。  
4. 架构统一：飞书/Telegram 共享一套治理逻辑，减少重复实现。  

## 11.2 风险与坏处

1. 成本上升：全量消息入库和检索会增加存储/计算/token 消耗。  
2. 误触发风险：Addressing Gate 判定不准会导致漏回或误回。  
3. 隐私压力：采集了更多“非指令消息”，需明确数据边界和保留策略。  
4. 并发复杂：消息量大时更依赖单写者和队列治理，避免乱序。  

## 11.3 默认治理建议

1. 默认“全量接收 + 默认静默”：未命中 Addressing Gate 只注入上下文，不执行不回复。  
2. 主动触发分级：`info` 只记录，`warning/high` 才提醒，`critical` 走审批。  
3. 成本护栏：设置上下文窗口、定期摘要压缩、TTL（如 30/90 天分层保留）。  
4. 群级开关：支持 `仅@触发` / `全量接收` / `全量接收+主动提醒`。  

---

## 12. 代码落位（模块边界）

为保证“Gateway 在入口层、runtime 保持纯执行层”，Gateway 代码应集中到独立模块：

1. 推荐根模块：`runtime/src/gateway`
2. 子模块：
   - `gateway/adapters/*`：飞书/Telegram 入站适配
   - `gateway/context_service.py`：主会话、task run、最小回写
   - `gateway/notifiers/*`：出站发送
   - `gateway/parsers/*`：审批文本解析
   - `gateway/store/*`：Gateway SQLite 读写
   - `gateway/policies/*`：Addressing/Proactive/TTL 策略
3. `runtime/src/server/api.py` 仅保留 HTTP 路由，不承载 Gateway 业务逻辑。
