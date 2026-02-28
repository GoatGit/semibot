# 事件模型与规则引擎（Reflex Engine 详细设计）

> 版本：2.0 | 日期：2026-02-26
>
> 本文档是事件系统的完整设计参考，合并了事件类型、规则表达式、动作路由、审批流程、风险策略、默认规则、规则配置、可观测性、API 接口等内容。

## 1. 设计原则

- 复用现有 Orchestrator、UnifiedActionExecutor、AuditLogger、evolved_skills 流程
- 事件模型兼容现有日志与 webhooks 思路
- 默认 SQLite 单文件持久化
- 规则先行、Agent 兜底，避免过度依赖 LLM

## 2. 事件模型（Event Envelope）

```yaml
event:
  event_id: "evt_20260226_0001"
  type: "task.completed"
  source: "agent|tool|scheduler|webhook|system|chat"
  subject: "task:abcd-1234"
  timestamp: "2026-02-26T10:30:00Z"
  payload: { summary: "..." }
  idempotency_key: "task.completed:task:abcd-1234"
  risk_hint: "low|medium|high"
```

## 2.1 执行上下文（推荐字段）

为支持审计与群聊协作，事件建议携带以下上下文字段：

- `actor_id`：触发者（用户/系统/机器人）
- `channel`：来源渠道（cli/http/chat/webhook）
- `session_id`：关联会话
- `trace_id`：执行链路追踪

## 3. 事件类型清单

### P0 基础事件（必须）

| 事件类型 | 说明 |
|---------|------|
| `task.created` | 任务创建 |
| `task.started` | 任务开始执行 |
| `task.completed` | 任务完成 |
| `task.failed` | 任务失败 |
| `agent.lifecycle.pre_execute` | Agent 执行前 |
| `agent.lifecycle.post_execute` | Agent 执行后 |
| `tool.exec.started` | 工具执行开始 |
| `tool.exec.completed` | 工具执行完成 |
| `tool.exec.failed` | 工具执行失败 |
| `approval.requested` | 审批请求 |
| `approval.approved` | 审批通过 |
| `approval.rejected` | 审批拒绝 |
| `system.health.heartbeat` | 系统心跳 |
| `system.health.unreachable` | 系统不可达 |
| `scheduler.cron.fired` | 定时任务触发 |

### P1 协作与主动（增强）

| 事件类型 | 说明 |
|---------|------|
| `chat.message.received` | 群聊消息 |
| `chat.mention.received` | @提醒 |
| `chat.card.action` | 卡片按钮操作 |
| `user.feedback.positive` | 正向反馈 |
| `user.feedback.negative` | 负向反馈 |
| `resource.usage.spike` | 资源消耗突增 |
| `memory.write.important` | 关键记忆沉淀 |

### P2 业务扩展（自定义）

通过 Webhook/SDK 注入：`webhook.*`、`domain.*`、`custom.*`

## 4. SQLite 数据模型

```sql
-- 事件日志
CREATE TABLE IF NOT EXISTS events (
    id              TEXT PRIMARY KEY,
    event_type      TEXT NOT NULL,
    source          TEXT NOT NULL,
    subject         TEXT,
    idempotency_key TEXT UNIQUE,
    payload         TEXT NOT NULL,       -- JSON
    risk_hint       TEXT,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_subject ON events(subject);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);

-- 事件规则
CREATE TABLE IF NOT EXISTS event_rules (
    id                       TEXT PRIMARY KEY,
    name                     TEXT NOT NULL,
    event_type               TEXT NOT NULL,
    conditions               TEXT NOT NULL,       -- JSON（结构化条件）
    action_mode              TEXT NOT NULL,       -- ask|suggest|auto
    actions                  TEXT,                -- JSON（动作配置数组）
    risk_level               TEXT NOT NULL,       -- low|medium|high
    priority                 INTEGER NOT NULL DEFAULT 0,
    dedupe_window_seconds    INTEGER NOT NULL DEFAULT 0,
    cooldown_seconds         INTEGER NOT NULL DEFAULT 0,
    attention_budget_per_day INTEGER NOT NULL DEFAULT 0,
    is_active                INTEGER NOT NULL DEFAULT 1,
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_rules_type ON event_rules(event_type);
CREATE INDEX IF NOT EXISTS idx_event_rules_active ON event_rules(is_active);

-- 规则执行记录
CREATE TABLE IF NOT EXISTS event_rule_runs (
    id              TEXT PRIMARY KEY,
    rule_id         TEXT NOT NULL,
    event_id        TEXT NOT NULL,
    decision        TEXT NOT NULL,       -- skip|ask|suggest|auto
    reason          TEXT,
    status          TEXT NOT NULL,       -- queued|running|success|failed
    action_trace_id TEXT,
    duration_ms     INTEGER,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rule_runs_rule ON event_rule_runs(rule_id);
CREATE INDEX IF NOT EXISTS idx_rule_runs_event ON event_rule_runs(event_id);

-- 审批请求
CREATE TABLE IF NOT EXISTS approval_requests (
    id          TEXT PRIMARY KEY,
    rule_id     TEXT NOT NULL,
    event_id    TEXT NOT NULL,
    risk_level  TEXT NOT NULL,
    status      TEXT NOT NULL,           -- pending|approved|rejected
    created_at  TEXT NOT NULL,
    resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_status ON approval_requests(status);
```

## 5. 事件处理流程

```
事件进入（事件源 → normalize）
    │
    ▼
幂等校验（idempotency_key 是否已存在）
    │ 重复 → skip
    ▼
持久化（写入 events 表）
    │
    ▼
规则匹配（按 event_type 匹配，priority 降序）
    │ 无匹配 → 结束
    ▼
治理判断（去重/冷却/注意力预算/风险分级）
    │ 不通过 → skip（记录 reason）
    ▼
执行路由
    ├── ask → 生成审批请求
    ├── suggest → 生成建议卡片
    └── auto → 进入执行层
```

## 5.1 并发与顺序

- 同一事件内规则按 `priority` 顺序评估  
- 默认串行执行，避免并发导致的重复动作  
- 后续可选并行执行低风险动作（需显式开关）  

## 6. 规则条件表达式

采用结构化 JSON 条件，避免任意字符串执行风险。

```json
{
  "all": [
    { "field": "payload.days_stale", "op": ">=", "value": 14 },
    { "field": "payload.owner", "op": "exists", "value": true }
  ]
}
```

### 支持的字段

`event_type`、`source`、`subject`、`payload.*`、`risk_hint`

### 支持的操作符

| 操作符 | 说明 |
|--------|------|
| `==`, `!=` | 等于/不等于 |
| `>`, `>=`, `<`, `<=` | 数值比较 |
| `in`, `not_in` | 集合包含 |
| `contains`, `not_contains` | 字符串包含 |
| `exists` | 字段存在性 |

### 组合操作

- `all`：全部满足
- `any`：任一满足
- `not`：取反

### 判定结果

| decision | 含义 |
|----------|------|
| `skip` | 不处理 |
| `ask` | 生成审批请求 |
| `suggest` | 生成建议卡片 |
| `auto` | 进入执行层 |

## 7. 治理机制

### 7.1 去重

基于 `idempotency_key`，窗口内已处理则 skip。

### 7.1.1 幂等与去重的区别

- 幂等：同一个事件只处理一次（以 `idempotency_key` 为准）  
- 去重：相似事件在时间窗口内合并处理（以规则窗口为准）

### 7.2 冷却窗口

同规则在 `cooldown_seconds` 内触发过则 skip。

### 7.3 注意力预算

每人/每天最大主动提醒次数（`attention_budget_per_day`），达上限则 skip。

### 7.3.1 预算作用域（MVP）

- 单机默认按“全局每日预算”
- 后续可扩展为“按人/按群聊”预算

### 7.4 风险分级与 HITL 策略

| 风险等级 | 默认策略 | 说明 |
|---------|---------|------|
| `low` | 允许 `auto` | 可自动执行 |
| `medium` | 优先 `ask` 或 `suggest` | 建议或询问 |
| `high` | 强制 `ask` | 必须审批 |

高风险动作范围（建议）：文件删除/覆盖、外部系统写操作、付费 API 调用、批量数据修改。

规则可覆盖默认策略，但必须记录审计理由。

## 8. 动作路由

### 8.1 动作类型

| 动作类型 | 路由目标 | 说明 |
|---------|---------|------|
| `notify` | EventRouter → 群聊/CLI/日志 | 发送通知或卡片 |
| `run_agent` | Orchestrator.run(agent_id, payload) | 触发 Agent 执行 |
| `execute_plan` | Orchestrator.execute_plan(plan) | 多步编排 |
| `call_webhook` | HTTP 客户端 | 向外部系统推送 |
| `log_only` | AuditLogger | 仅记录 |

### 8.2 动作参数示例

```json
{ "action_type": "notify", "params": { "channel": "chat", "title": "心跳异常" } }
{ "action_type": "run_agent", "target": "risk_agent", "params": { "topic": "风险分析" } }
{ "action_type": "execute_plan", "params": { "plan_id": "plan_001" } }
{ "action_type": "call_webhook", "params": { "url": "https://example.com" } }
```

### 8.3 执行选择策略（Tools / MCPs / Skills）

优先级：Tools → MCPs → Skills

1. 规则定义了明确的 `tool_name` → 直接触发 Tools
2. 规则指定 `mcp_server` 或 `mcp_tool` → 调用 MCP
3. 需要推理/生成内容 → 交给 Skills/LLM 编排

### 8.4 幂等与去重

- 动作执行前检查 `idempotency_key`
- `event_rule_runs` 内同一 `event_id + rule_id` 不重复执行

### 8.5 错误处理

- 单个动作失败不影响其他动作
- 所有失败均写入审计与日志

## 9. HITL 审批流程

### 9.1 核心原则

- 高风险默认必须审批
- 审批可在群聊或 CLI 进行
- 审批结果必须写入审计链路

### 9.2 审批状态机

```
审批请求：pending → approved | rejected
动作执行：queued → running → success | failed
```

超时可标记为 `rejected`，原因写入审计。

### 9.3 触发路径

1. 规则判定为 `ask`，或 `auto` 且风险为 `high`
2. 生成 `approval_requests` 记录
3. 通知群聊或 CLI 等审批入口
4. 用户同意或拒绝
5. 产生 `approval.*` 事件
6. 进入执行层或终止

### 9.4 审批载荷示例

```json
{
  "approval_id": "appr_001",
  "event_id": "evt_001",
  "rule_id": "rule_001",
  "risk_level": "high",
  "summary": "将删除 12 个文件",
  "proposed_action": "file.delete",
  "params": { "paths": ["..."] }
}
```

### 9.5 双层审批

规则层审批与工具层审批互补：
- 规则层：决定是否进入执行
- 工具层：高风险工具再走 `approval_hook`

两层审批互不替代，形成"双保险"。

### 9.6 审批与群聊时序

```
事件进入 → 规则匹配 → ask
  └→ 生成审批请求 → 群聊卡片
       └→ 用户审批 → approval.* 事件
            └→ 规则引擎二次路由 → 执行/拒绝
```

## 10. 规则配置与加载

### 10.1 配置路径

- 默认规则：`~/.semibot/rules/default.json`
- 自定义规则：`~/.semibot/rules/*.json`

### 10.2 加载与覆盖

- 启动时加载默认规则
- 再加载自定义规则
- 若规则 `name` 重名，则自定义规则覆盖默认规则
- `is_active=false` 可用于禁用规则

### 10.3 规则文件格式

```json
[
  {
    "name": "system_health_alert",
    "event_type": "system.health.unreachable",
    "conditions": { "all": [] },
    "action_mode": "ask",
    "actions": [{ "action_type": "notify", "params": { "channel": "chat" } }],
    "risk_level": "medium",
    "priority": 50,
    "dedupe_window_seconds": 600,
    "cooldown_seconds": 1800,
    "attention_budget_per_day": 3,
    "is_active": true
  }
]
```

### 10.4 热更新

- 规则文件变更后触发重新加载
- 若解析失败，则保留上一版规则
- 规则变更写入审计日志

## 11. 默认规则模板（MVP）

### P0 规则

| 规则名 | 事件类型 | action_mode | risk_level |
|--------|---------|-------------|------------|
| 系统心跳异常提醒 | `system.health.unreachable` | ask | medium |
| 工具执行失败告警 | `tool.exec.failed` | suggest | low |
| 审批请求处理 | `approval.requested` | ask | high |
| 任务失败重试建议 | `task.failed` (retriable) | suggest | low |

### P1 规则

| 规则名 | 事件类型 | action_mode | risk_level |
|--------|---------|-------------|------------|
| 群聊@提醒转任务 | `chat.mention.received` | auto | low |
| 用户负向反馈处理 | `user.feedback.negative` | ask | medium |
| 资源消耗突增提醒 | `resource.usage.spike` | ask | medium |

默认 actions 以 `notify` 和 `run_agent` 为主，具体以 `default.json` 为准。

## 12. 可观测性

### 12.1 指标（MVP）

- 每分钟事件吞吐量
- 规则命中率
- 审批通过率
- 规则执行成功率
- 平均执行耗时

### 12.2 日志与审计

- 每条事件必须写入事件日志
- 每次规则评估必须写入 `event_rule_runs`（包括 skip）
- 审批必须记录审批人、时间与结果
- 失败和重试必须记录原因与时间

### 12.3 回放

- 支持按 `event_id` 回放
- 支持按 `event_type` + 时间窗口批量回放
- 回放时强制走幂等校验

## 12.4 事件保留与清理

- 默认保留最近 30 天事件日志  
- 达到阈值时按时间窗口清理  
- 清理动作写入审计日志  

## 13. API 接口

### HTTP API（FastAPI）

```
GET    /v1/events?type=&since=       # 事件列表
GET    /v1/events/:id                # 事件详情
POST   /v1/events/replay             # 事件回放
GET    /v1/rules                     # 规则列表
POST   /v1/rules                     # 创建规则
PATCH  /v1/rules/:id                 # 更新规则
POST   /v1/rules/:id/enable          # 启用规则
POST   /v1/rules/:id/disable         # 禁用规则
GET    /v1/approvals                 # 审批列表
POST   /v1/approvals/:id/approve     # 批准
POST   /v1/approvals/:id/reject      # 拒绝
```

### CLI

```bash
semibot events list
semibot events replay <event_id>
semibot rules list
semibot rules enable <rule_id>
semibot rules disable <rule_id>
semibot approvals list
```

## 14. 错误处理与回放策略

- 错误分类：规则匹配错误 / 执行错误 / 外部依赖错误
- 重试策略：仅针对执行错误，且受冷却窗口约束
- 回放：允许按 `event_id` 重放，重放时强制走幂等校验
- 审计：所有失败和重试必须记录原因与时间

## 15. 与现有 runtime 的对接映射

### 事件源（复用）

| 现有模块 | 事件类型 |
|---------|---------|
| `BaseAgent.run()` | `agent.lifecycle.*` |
| `UnifiedActionExecutor.execute()` | `tool.exec.*` |
| `AuditLogger` | `audit.*`（补充事件日志） |
| `scheduler` | `scheduler.cron.*` |

### 执行层（复用）

- Orchestrator：负责 `run_agent` / `execute_plan`
- UnifiedActionExecutor：负责 `tool` 与 `mcp` 执行
- Sandbox：作为 `tool.exec` 的执行后端（可选）

### 输出层（复用）

- Execution logs 作为事件链路记录的统一载体
- evolved_skills 作为进化输出入口
