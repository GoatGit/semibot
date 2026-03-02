# 内建工具设计：规则创建工具（Rule Authoring Tool）

## 1. 背景与目标

目标：新增一个内建工具，让 Agent 可以在对话中“安全地创建规则”，而不是只给出文字建议。

本设计解决三个问题：

1. 规则配置门槛高（字段多、JSON 难写）。
2. Agent 无法直接落地规则（只能建议）。
3. 规则改动缺少治理闭环（审批、审计、回滚）。

---

## 2. 范围（V2）

### 2.1 In Scope

- 新增内建工具：`rule_authoring`
- 支持动作：
  - `create_rule`
  - `update_rule`
  - `enable_rule`
  - `disable_rule`
  - `delete_rule`（软删除）
  - `simulate_rule`（给定事件做命中仿真）
- 与 HITL 审批打通（高风险默认审批）。
- 写入统一审计事件：`rule.authored` / `rule.updated` / `rule.deleted` / `rule.simulated`。

### 2.2 Out of Scope（本期不做）

- 让 Agent 自定义全新事件 DSL。
- 可视化拖拽式规则编排器。
- 规则版本多分支合并（仅保留线性版本）。

---

## 3. 定位与命名

- 工具名：`rule_authoring`
- 类型：内建 Tool（与 `search`、`file_io` 同级）
- 风险等级默认：`high`
- 默认策略：`requiresApproval=true`

原因：规则变更会影响后续自动执行行为，属于系统治理面高风险操作。

---

## 4. 架构落点

## 4.1 分层职责

- `runtime/tools/rule_authoring.py`  
  工具入口、参数校验、调用 Rule Service。

- `runtime/services/rule_service.py`（新增）  
  规则领域服务：CRUD、版本、仿真、审计。

- `runtime/src/server/api.py`  
  提供规则管理 API（最终以 runtime SQLite 为准）。

- `~/.semibot/semibot.db`  
  规则存储源；不再依赖 API 层 Postgres 规则表。

## 4.2 与现有链路关系

1. 用户在 Chat/Telegram/Feishu 提出“帮我创建规则”。
2. Agent 调用 `rule_authoring.create_rule`。
3. 工具层触发审批（若高风险）。
4. 审批通过后写入规则存储并热加载。
5. 返回结构化结果（rule_id、生效状态、仿真摘要）。

---

## 5. 工具契约（Tool Contract）

## 5.1 输入（统一 envelope）

```json
{
  "action": "create_rule",
  "payload": {},
  "options": {
    "dry_run": false,
    "idempotency_key": "optional-string"
  }
}
```

## 5.2 `create_rule` payload

```json
{
  "name": "workday_morning_digest",
  "event_type": "cron.job.tick",
  "conditions": {
    "all": [
      { "field": "payload.trigger_name", "op": "==", "value": "workday_digest" }
    ]
  },
  "action_mode": "suggest",
  "actions": [
    { "action_type": "run_agent", "params": { "agent_id": "semibot" } }
  ],
  "risk_level": "low",
  "priority": 80,
  "dedupe_window_seconds": 300,
  "cooldown_seconds": 600,
  "attention_budget_per_day": 20,
  "is_active": true
}
```

## 5.3 输出

```json
{
  "ok": true,
  "action": "create_rule",
  "rule_id": "rule_xxx",
  "version": 1,
  "active": true,
  "dry_run": false,
  "warnings": [],
  "audit_event_id": "evt_xxx"
}
```

## 5.4 通用参数说明（所有 action）

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `action` | string | 是 | - | 动作名，枚举：`create_rule`/`update_rule`/`enable_rule`/`disable_rule`/`delete_rule`/`simulate_rule` |
| `payload` | object | 是 | `{}` | 动作参数体，结构随 action 变化 |
| `options.dry_run` | boolean | 否 | `false` | 仅校验并返回预览，不落库、不改状态 |
| `options.idempotency_key` | string | 否 | `null` | 幂等键；同 key 重试时应返回同一结果，防止重复创建 |
| `options.override_reason` | string | 否 | `null` | 高风险 override 说明；仅在高风险路径使用 |

## 5.5 规则对象字段说明（create/update 的 payload）

| 字段 | 类型 | 必填 | 默认值 | 约束 | 说明 |
|---|---|---|---|---|---|
| `name` | string | create:是/update:否 | - | 1~120 | 规则名，建议语义化且全局唯一 |
| `event_type` | string | create:是/update:否 | - | 1~160 | 事件类型，必须是平台支持事件 |
| `conditions` | object | 否 | `{"all":[]}` | JSON object | 条件表达式（建议模板生成） |
| `action_mode` | enum | create:是/update:否 | - | `ask/suggest/auto/skip` | 规则动作模式 |
| `actions` | array | create:是/update:否 | - | 至少 1 项 | 动作列表（多动作） |
| `risk_level` | enum | create:是/update:否 | - | `low/medium/high` | 规则风险等级 |
| `priority` | int | 否 | `50` | 0~1000 | 优先级（越大越先执行） |
| `dedupe_window_seconds` | int | 否 | `300` | 0~86400 | 去重窗口（同 rule+subject） |
| `cooldown_seconds` | int | 否 | `600` | 0~86400 | 冷却窗口（规则执行后） |
| `attention_budget_per_day` | int | 否 | `10` | 0~10000 | 每日触发预算（rule_id:subject） |
| `is_active` | bool | 否 | `true` | - | 是否启用 |
| `cron` | object | 否 | `null` | - | 仅 `cron.*` 场景使用；联动调度器 |

### `actions[*]` 字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action_type` | string | 是 | 例如 `notify` / `run_agent` / `execute_plan` / `call_webhook` / `log_only` |
| `params` | object | 否 | 与 `action_type` 对应的参数对象 |

## 5.6 action-by-action 契约

### A) `create_rule`

- 必填：`name`、`event_type`、`action_mode`、`actions`、`risk_level`
- 可选：其余规则字段 + `cron`
- 返回：`rule_id`、`version=1`、`active`、`warnings`

### B) `update_rule`

- 必填：`rule_id`
- 可选：任意可更新字段（同规则对象字段）
- 行为：仅 patch 提供字段，不覆盖未提供字段
- 返回：`rule_id`、`version`（+1）

示例：
```json
{
  "action": "update_rule",
  "payload": {
    "rule_id": "rule_123",
    "priority": 90,
    "cooldown_seconds": 1200
  }
}
```

### C) `enable_rule` / `disable_rule`

- 必填：`rule_id`
- 行为：切换 `is_active`
- 返回：`rule_id`、`active`

### D) `delete_rule`（软删除）

- 必填：`rule_id`
- 行为：写 `deleted_at`，并自动 `is_active=false`
- 默认高风险，必须审批

### E) `simulate_rule`

- 必填：`rule`（完整规则对象）或 `rule_id`（二选一），以及 `event`
- `event` 最小结构：`event_type`、`source`、`payload`
- 返回：`matched`、`decision`、`reason`、`would_require_approval`

## 5.7 `cron` 联动参数（create/update）

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `cron.upsert` | bool | 否 | `false` | 是否联动创建/更新调度器 |
| `cron.name` | string | `upsert=true` 时必填 | - | 调度器名称，同时建议作为 `payload.trigger_name` |
| `cron.schedule` | string | `upsert=true` 时必填 | - | 调度表达式（UI 主推 5 段） |
| `cron.event_type` | string | 否 | 规则 `event_type` | 调度器发出的事件类型 |
| `cron.source` | string | 否 | `system.cron` | 事件来源 |
| `cron.subject` | string | 否 | `system` | 事件 subject |
| `cron.payload` | object | 否 | `{}` | 调度事件附加载荷 |

调度表达式支持：
- 推荐：5 段 cron（如 `0 9 * * 1-5`）
- 兼容：`@every:300`

## 5.8 LLM Tool-Use 约束（必须遵循）

1. 不要手写复杂 `conditions`，优先使用模板后再微调。
2. `create_rule` 前必须先给出一句自然语言摘要（便于审批人理解）。
3. 涉及 `auto + high` 或 `delete_rule` 时，必须附带 `options.override_reason`。
4. 同一意图重试必须复用 `options.idempotency_key`。
5. `cron.upsert=true` 时，规则条件需绑定 `payload.trigger_name == cron.name`（工具可自动补齐，但 LLM 仍应显式表达）。

## 5.9 错误码（给 LLM 可恢复指引）

| 错误码 | 含义 | LLM 恢复策略 |
|---|---|---|
| `RULE_NOT_FOUND` | 规则不存在 | 先 `list_rules` 或确认 `rule_id` |
| `RULE_NAME_CONFLICT` | 规则名冲突 | 改名后重试 |
| `INVALID_EVENT_TYPE` | 事件类型非法 | 改用枚举事件类型 |
| `INVALID_CONDITIONS` | 条件表达式非法 | 回退模板生成 |
| `INVALID_ACTION_PARAMS` | 动作参数非法 | 用 action 默认参数重试 |
| `INVALID_CRON_SCHEDULE` | 调度表达式非法 | 改为 5 段 cron 或 `@every` |
| `APPROVAL_REQUIRED` | 需要审批 | 提示用户审批后自动续跑 |
| `IDEMPOTENCY_CONFLICT` | 幂等冲突 | 使用新 key 或复用原 key 查询结果 |

## 5.10 完整示例（LLM 可直接复用）

### 示例 1：创建“工作日 9 点晨报”规则 + 联动 cron

```json
{
  "action": "create_rule",
  "payload": {
    "name": "workday_morning_digest",
    "event_type": "cron.job.tick",
    "conditions": {
      "all": [
        { "field": "payload.trigger_name", "op": "==", "value": "workday_digest" }
      ]
    },
    "action_mode": "suggest",
    "actions": [
      { "action_type": "run_agent", "params": { "agent_id": "semibot" } }
    ],
    "risk_level": "low",
    "priority": 80,
    "dedupe_window_seconds": 300,
    "cooldown_seconds": 600,
    "attention_budget_per_day": 20,
    "is_active": true,
    "cron": {
      "upsert": true,
      "name": "workday_digest",
      "schedule": "0 9 * * 1-5",
      "source": "system.cron",
      "subject": "system"
    }
  },
  "options": {
    "dry_run": false,
    "idempotency_key": "rule:create:workday_morning_digest:v1"
  }
}
```

### 示例 2：仅提高优先级（patch）

```json
{
  "action": "update_rule",
  "payload": {
    "rule_id": "rule_abc123",
    "priority": 95
  },
  "options": {
    "idempotency_key": "rule:update:rule_abc123:priority95"
  }
}
```

---

## 6. 校验与治理

工具执行前必须通过三层校验：

1. 结构校验：字段完整、类型合法、边界值合法。
2. 语义校验：`event_type` 必须在枚举内；`actions` 必须为白名单动作。
3. 治理校验：高风险动作（如 `delete_rule`、`auto + high`）必须审批。

关键约束：

- 禁止创建“无限自触发”规则（例如规则命中后再次发同事件且无冷却）。
- `action_mode=auto` 且 `risk_level=high` 默认拒绝，除非显式 `override_reason` + 审批通过。
- `priority` 建议区间 `[0,1000]`。

---

## 7. 与 Cron 联动

当 `event_type=cron.job.tick` 时，工具支持可选联动参数：

```json
{
  "cron": {
    "upsert": true,
    "name": "workday_digest",
    "schedule": "0 9 * * 1-5",
    "source": "system.cron",
    "subject": "system"
  }
}
```

行为：

1. 先校验并 upsert cron job。
2. 再创建/更新规则（条件自动绑定 `payload.trigger_name == cron.name`）。
3. 任一步失败则整体失败（原子事务语义，或补偿回滚）。

---

## 8. API 设计（runtime）

新增/补齐以下接口（供 Web/CLI/Tool 共用）：

- `GET /v1/rules`
- `POST /v1/rules`
- `PUT /v1/rules/{id}`
- `DELETE /v1/rules/{id}`（软删除）
- `POST /v1/rules/simulate`

说明：`rule_authoring` 工具优先复用这些 API 或同一 Service，避免双实现。

---

## 9. 数据模型（SQLite）

沿用现有 `event_rules`，补充两个字段：

- `version INTEGER NOT NULL DEFAULT 1`
- `deleted_at TEXT NULL`

新增审计表（若尚未覆盖）：

- `rule_audit_logs`
  - `id`
  - `rule_id`
  - `operation`（create/update/enable/disable/delete/simulate）
  - `operator`（agent_id/user_id/gateway_key）
  - `before_json`
  - `after_json`
  - `created_at`

---

## 10. 前端与交互

规则页新增入口（后续实现）：

- “由 Agent 生成规则”按钮（弹出自然语言输入框）。
- 展示 Tool 生成的“规则草案 diff”。
- 一键“审批并创建”。

同时保留手工编辑器，两种方式并行。

---

## 11. 安全策略

- Tool 配置默认：
  - `enabled=true`
  - `riskLevel=high`
  - `requiresApproval=true`
  - `approvalScope=session_action`
- 仅白名单 Agent 可调用（默认 `semibot` + 系统 Agent）。
- 所有写操作都要审计并可追溯到会话与消息。

---

## 12. 测试计划

## 12.1 单元测试

- create/update/delete 输入校验
- 风险门控与审批分支
- cron 联动参数校验

## 12.2 集成测试

- Chat -> Tool -> Approval -> Rule persisted -> Rule hit
- Telegram 文本指令触发规则创建（带审批）
- 失败回滚（cron upsert 成功但 rule create 失败）

## 12.3 E2E 验收

场景：  
“每天工作日 9 点推送晨报”

验收标准：

1. Agent 成功创建 cron + rule。
2. 审批中心可见该操作并可追溯。
3. 重启 runtime 后 cron 与规则仍可用。
4. 定时触发后命中规则并执行预期动作。

## 12.4 E2E 用例清单（补充）

> 目标：覆盖 Tool-Use 主链路、审批链路、cron 联动、失败恢复、幂等与网关入口。

### Case E2E-RA-001：对话创建规则（无 cron）

- 前置：
  - `rule_authoring` 已启用。
  - 审批策略允许中低风险自动通过或手工通过。
- 步骤：
  1. Chat 输入“创建一条 tool.exec.failed 的告警规则”。
  2. Agent 调用 `rule_authoring.create_rule`。
  3. 若有审批，执行通过。
- 断言：
  - 返回 `ok=true` 且有 `rule_id`。
  - `GET /v1/rules` 可查到新规则。
  - 触发 `tool.exec.failed` 事件后命中该规则。

### Case E2E-RA-002：创建规则并联动创建 cron（5 段）

- 前置：
  - runtime 支持 5 段 cron。
- 步骤：
  1. 通过工具创建 `cron.job.tick` 规则，并传 `cron.upsert=true`、`schedule=0 9 * * 1-5`。
  2. 查询 `/v1/scheduler/cron-jobs`。
- 断言：
  - 新增 cron job 存在且字段正确。
  - 新规则 `conditions` 包含 `payload.trigger_name == cron.name`。
  - 重启 runtime 后 cron 与 rule 仍存在。

### Case E2E-RA-003：update_rule patch 语义

- 步骤：
  1. 对已有规则执行 `update_rule`，仅修改 `priority` 与 `cooldown_seconds`。
- 断言：
  - 仅指定字段变化，其他字段保持不变。
  - `version` 递增。
  - 写入 `rule.updated` 审计事件。

### Case E2E-RA-004：高风险路径审批（delete_rule）

- 步骤：
  1. 发起 `delete_rule`。
  2. 不审批，确认状态保持 pending。
  3. 审批通过后继续执行。
- 断言：
  - 未审批前规则仍可用。
  - 审批后规则软删除（`is_active=false` + `deleted_at` 非空）。
  - 审计记录包含审批链路信息。

### Case E2E-RA-005：simulate_rule 结果可解释

- 步骤：
  1. 调用 `simulate_rule`，输入规则草案和测试事件。
- 断言：
  - 返回 `matched/decision/reason/would_require_approval`。
  - 与真实引擎对同事件的判定一致。

### Case E2E-RA-006：幂等重试

- 步骤：
  1. 用固定 `idempotency_key` 执行 `create_rule`。
  2. 网络重试再次提交同请求。
- 断言：
  - 不重复创建规则。
  - 返回同一 `rule_id` 或明确 `idempotent_replay=true`。

### Case E2E-RA-007：非法 cron 表达式

- 步骤：
  1. `cron.upsert=true` 且 `schedule=bad cron`。
- 断言：
  - 返回 `INVALID_CRON_SCHEDULE`。
  - 不写入规则、不写入 cron job（或触发补偿删除）。

### Case E2E-RA-008：网关入口（Telegram）

- 前置：
  - Telegram gateway 已接入并可收发消息。
- 步骤：
  1. 群聊 @bot：创建一条规则。
  2. bot 发起审批卡/审批提示。
  3. 用户回复“同意”。
- 断言：
  - 审批通过后自动续跑成功。
  - Telegram 收到“规则已创建”结果消息。
  - Web 审批中心状态同步变更为 `approved`。

---

## 13. 迭代计划

### Phase 1（最小可用）

- `rule_authoring` 工具 + `create/update/enable/disable`
- 审批与审计接入

### Phase 2

- `delete_rule` + `simulate_rule`
- 前端“Agent 生成规则草案 + diff”

### Phase 3

- 规则模板库（业务场景模板）
- 自动修复建议（lint + rewrite）

---

## 14. 决策摘要

- 规则创建工具按“高风险治理工具”设计，不做无审批直写默认路径。  
- 规则与 cron 联动必须支持，但以 runtime 统一服务为单一真相源。  
- UI 主推 5 段 cron；`@every` 仅作为兼容语法。  
