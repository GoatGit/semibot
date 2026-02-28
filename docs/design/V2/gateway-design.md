# Gateway 统一设计（飞书 + Telegram）

> 版本：2.0 | 日期：2026-02-28 | 状态：设计中（持续更新）
>
> 会话治理与 fork 策略详细方案见 [`gateway-context-service.md`](./gateway-context-service.md)。

## 1. 目标与边界

### 1.1 目标

- 在配置管理中新增统一 `Gateway` 配置域，集中管理飞书与 Telegram
- 新增 Telegram Gateway（入站消息、出站通知、审批回执）
- 让审批机制在 Web UI / CLI / 第三方聊天工具中保持一致（通用，不绑某个工具）
- 引入统一 `Gateway Context Service`，实现“主会话固定 + 任务隔离 + 最小回写”

### 1.2 非目标（本阶段不做）

- 不做多租户隔离，不引入 org/user 维度鉴权
- 不做企业级 SSO，不做独立 IAM
- 不做复杂会话迁移（不同平台间自动合并历史）

### 1.3 设计约束

- 本地单机优先，配置落地到 `~/.semibot/semibot.db`
- 保持现有 Feishu 入站/出站能力兼容
- runtime 保持单层 session，不引入 runtime 父/子 session 树

---

## 2. 总体架构

```text
Feishu / Telegram
        │
        ▼
Gateway Adapter（provider-specific）
        │ normalize / verify / idempotency
        ▼
Gateway Context Service（统一会话治理）
        │ main_context 固定 + task_run 隔离 + 最小回写
        ▼
Event Engine（chat.message.received / approval.action / ...）
        │
        ├─ RulesEngine → direct actions
        └─ Orchestrator → tool/skill/mcp execution
        │
        ▼
Gateway Notifier（provider-specific outbound）
```

### 2.1 模块拆分（runtime）

- `server/gateway_manager.py`
  - （已迁移到 `gateway/manager.py`）负责读取网关配置、构建适配器、管理启停状态
- `server/gateways/base.py`
  - 统一接口：`verify` / `normalize_inbound` / `send_outbound`
- `server/gateway_context_service.py`（新增）
  - 统一维护 Gateway 主会话、任务运行映射、最小回写、审批聚合
- `server/gateways/feishu_adapter.py`
  - 复用现有 `feishu.py` + `feishu_notifier.py`，逐步收敛到统一接口
- `server/gateways/telegram_adapter.py`（新增）
  - 处理 Telegram webhook、消息解析、出站发送
- `server/approval_text.py`（已存在，继续复用）
  - 解析“同意/拒绝/approve/reject”等文本审批命令

实现进度（2026-02-28）：

- `runtime/src/gateway/manager.py` 已承接 Gateway 配置、webhook 入站、审批文本解析、出站通知与 GCS 查询聚合。
- `runtime/src/server/routes/gateway.py` 已承接 Gateway 路由定义；`runtime/src/server/api.py` 仅做应用装配与路由注册。

### 2.2 与 Event Engine 的关系

- Gateway 不做业务决策，只做消息标准化与来源鉴别
- Gateway Context Service 负责会话治理，不由 provider 适配器各自实现 fork/merge
- 标准事件统一写入 `events`，并触发规则匹配
- 审批动作统一写入 `approval.action` 事件，便于审计回放

### 2.3 会话治理策略（定稿）

1. `chat_id + bot_id`（或飞书等价键）映射固定 `main_context`。  
2. 每条新任务创建独立 `runtime_session_id`，执行隔离。  
3. 任务结束只做“最小结果回写”，不做全量 merge。  
4. 会话血缘关系保存在 Gateway Context Service，不下沉到 runtime。  
5. 该策略同时适用于 Telegram 与飞书，不为单一 Gateway 定制不同会话模型。  
6. 群聊支持“全量接收”时，必须先过 `Addressing Gate`：未命中仅注入上下文，不触发执行、不回消息。  

---

## 3. 配置模型（SQLite）

## 3.1 新表：`gateway_instances`

```sql
CREATE TABLE IF NOT EXISTS gateway_instances (
  id TEXT PRIMARY KEY,
  instance_key TEXT NOT NULL UNIQUE,      -- 业务可读实例键（如 tg-ops-a）
  provider TEXT NOT NULL,                 -- feishu | telegram
  display_name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,  -- 每 provider 至少一个 default
  is_active INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'webhook',   -- webhook | polling(预留)
  risk_level TEXT NOT NULL DEFAULT 'high',
  requires_approval INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_gateway_instances_provider ON gateway_instances(provider);
CREATE INDEX IF NOT EXISTS idx_gateway_instances_active ON gateway_instances(is_active);
CREATE INDEX IF NOT EXISTS idx_gateway_instances_default ON gateway_instances(provider, is_default);
```

说明：

- `provider` 固定枚举：`feishu`、`telegram`，同一 provider 支持多实例（多 bot）
- `instance_key` 用于 webhook 路由和运维识别
- `is_default` 为兼容旧 `/v1/config/gateways/{provider}` 接口保留
- `config_json` 存 provider 特有字段（见下文）
- `is_active=false` 时，入站请求返回 `accepted=false, reason=gateway_disabled`
- 兼容层：旧表 `gateway_configs` 仅用于历史迁移，不再作为主数据源

## 3.2 provider 配置字段（`config_json`）

### 通用会话策略（跨 provider）

- `addressingPolicy.mode`: `mention_only` | `all_messages`
- `addressingPolicy.allowReplyToBot`: 是否把“回复 bot 消息”视为命中
- `addressingPolicy.executeOnUnaddressed`: 在 `all_messages` 模式下，未命中是否仍执行（默认 `false`）
- `addressingPolicy.commandPrefixes`: 命令前缀（如 `/ask`, `/run`）
- `addressingPolicy.sessionContinuationWindowSec`: 会话延续窗口（秒）
- `proactivePolicy.mode`: `silent` | `risk_based` | `always`
- `proactivePolicy.minRiskToNotify`: `low|medium|high|critical`
- `contextPolicy.ttlDays`: 主会话上下文保留天数
- `contextPolicy.maxRecentMessages`: 主会话保留最近消息条数
- `contextPolicy.summarizeEveryNMessages`: 每 N 条消息触发一次摘要压缩

### Feishu

- `verifyToken`: 回调 token
- `encryptKey`: 可选，开启事件加密校验时使用
- `appId` / `appSecret`: 可选，用于后续 bot API
- `webhookUrl`: 默认出站 webhook
- `webhookChannels`: 多通道 webhook 映射（如 `default`, `risk`, `ops`）
- `chatBindings`: 按会话（`chat_id`）绑定 agent（可选，命中后覆盖 `agentId`）
- `notifyEventTypes`: 订阅出站事件类型
- `templates`: 出站模板映射

### Telegram（新增）

- `agentId`: 该实例绑定的 runtime Agent（默认 `semibot`）
- `botToken`: Telegram Bot Token（敏感字段）
- `webhookSecret`: 可选，自定义 header secret
- `webhookPath`: 默认 `/v1/integrations/telegram/webhook`
- `defaultChatId`: 默认通知 chat id（群或私聊）
- `allowedChatIds`: 入站白名单（空表示不限制）
- `chatBindings`: 按 chat_id 绑定 agent（可选，命中后覆盖 `agentId`）
- `notifyEventTypes`: 订阅出站事件类型
- `parseMode`: `Markdown` / `HTML`（默认 `Markdown`）
- `disableLinkPreview`: 是否禁用预览

### 敏感字段处理

- API 返回时仅返回 `***` 预览，不返回明文
- 更新时支持 `clearXxx=true` 清空敏感字段
- DB 内存明文（本地单机），文档需提示建议配合磁盘加密

---

## 4. 配置管理 UI 设计（`/config`）

## 4.1 Tab 结构调整

- 现有：`LLM` / `Tools` / `API Keys` / `Webhooks`
- 新增：`Gateways`
- `Gateways` 负责飞书、Telegram
- `Webhooks` 保留为“通用事件回调”能力，不替代聊天网关

## 4.2 Gateway 卡片交互

每个网关实例一张卡（同 provider 可多实例）：

- 状态：`已启用 / 未启用 / 配置不完整`
- 基础开关：`启用`、`停用`
- 配置入口：`编辑`
- 实例操作：`新建实例`、`删除实例`、`设为默认`
- 连通性：`发送测试消息`
- 最近状态：最近一次入站时间、最近一次出站结果

## 4.3 字段表单（MVP）

- Feishu：`verifyToken`、`webhookUrl`、`notifyEventTypes`
- Telegram：`agentId`、`botToken`、`defaultChatId`、`allowedChatIds`、`chatBindings`、`notifyEventTypes`
- 通用策略：
  - Addressing：`mention_only/all_messages`、命令前缀、会话延续窗口
  - Proactive：`silent/risk_based/always`、最小提醒风险级别
  - Context：TTL、最近消息上限、摘要频率

约束：

- `botToken` 未配置时，Telegram 卡片提示“不可用”
- `defaultChatId` 为空时允许保存，但禁用“发送测试消息”
- `addressingPolicy.mode=all_messages` 时默认仍为“未命中不执行不回复”（默认静默）

---

## 5. API 契约（新增/调整）

## 5.1 配置管理 API（runtime）

实例级（V2 主接口）：

- `GET /v1/config/gateway-instances`
- `POST /v1/config/gateway-instances`
- `GET /v1/config/gateway-instances/{instance_id}`
- `PUT /v1/config/gateway-instances/{instance_id}`
- `DELETE /v1/config/gateway-instances/{instance_id}`
- `POST /v1/config/gateway-instances/{instance_id}/test`

兼容级（provider 视图，基于 default instance）：

- `GET /v1/config/gateways`
- `GET /v1/config/gateways/{provider}`
- `PUT /v1/config/gateways/{provider}`
- `POST /v1/config/gateways/{provider}/test`

响应示例（`GET /v1/config/gateways`）：

```json
{
  "data": [
    {
      "provider": "feishu",
      "instanceKey": "feishu-default",
      "isActive": true,
      "config": {
        "verifyToken": "***",
        "webhookUrl": "https://open.feishu.cn/..."
      },
      "status": "ready"
    },
    {
      "provider": "telegram",
      "instanceKey": "telegram-default",
      "isActive": false,
      "config": {
        "botToken": null,
        "defaultChatId": null
      },
      "status": "not_configured"
    }
  ]
}
```

## 5.2 入站集成 API

- 保留：`POST /v1/integrations/feishu/events`
- 保留：`POST /v1/integrations/feishu/card-actions`
- 新增：`POST /v1/integrations/telegram/webhook`
  - 接收 Telegram update（message / edited_message / callback_query）
  - 产出标准事件：`chat.message.received`、`approval.action`
  - 路由定位实例优先级：
    1. `instanceId` 查询参数
    2. `x-telegram-bot-api-secret-token` 匹配实例 `webhookSecret`
    3. 单活跃实例自动匹配

## 5.3 出站 API（测试/运维）

- 保留：`POST /v1/integrations/feishu/outbound/test`
- 新增：`POST /v1/integrations/telegram/outbound/test`

---

## 6. 事件映射与审批交互

## 6.1 Telegram 入站映射

- 普通消息：`message.text` → `chat.message.received`
- 回复消息（含审批文本）：优先走 `approval_text` 解析，命中则触发审批
- 按钮回调：`callback_query.data` → `approval.action` / `chat.card.action`

## 6.1.1 Feishu 入站映射（同一会话策略）

- 群/单聊消息：`im.message.receive_v1` → `chat.message.received`
- 卡片操作：`card-actions` → `chat.card.action` / `approval.action`
- 会话键归一化：`feishu:{app_id}:{conversation_id}`（见 `gateway-context-service.md`）

## 6.2 文本审批（通用）

支持以下形式（在飞书/Telegram/通用 webhook 一致）：

- `同意`、`批准`、`确认`
- `拒绝`、`驳回`
- `/approve appr_xxx`
- `/reject appr_xxx`
- `全部同意`、`全部拒绝`

策略：

- 优先根据显式 `approval_id` 解析
- 无 `approval_id` 时，按会话上下文匹配最近待审批项
- 始终回写审批结果消息，且写入 `approval.action` 事件

## 6.3 审批频率治理

- 默认按 `approvalScope=session` 聚合（减少刷屏）
- 相同工具/相同 action 在窗口期内可合并展示
- 支持“全部通过/全部拒绝”批量操作

---

## 7. 安全、风控与幂等

## 7.1 鉴别与防伪

- Feishu：`verifyToken` 校验（保留）
- Telegram：
  - 校验 webhook secret（若开启）
  - 可选 `allowedChatIds` 白名单

## 7.2 幂等与去重

- Feishu：`message_id` / `event_id`
- Telegram：`update_id`
- 统一落地 `idempotency_key`，重复请求直接返回 `accepted=true, deduped=true`

## 7.3 风险控制

- Gateway 配置可设置默认 `riskLevel` 与 `requiresApproval`
- 对外部网关的“批量审批”可配置二次确认文案

---

## 8. 迁移与兼容

## 8.1 配置迁移策略

- 启动时读取旧环境变量（Feishu）作为 fallback
- 若 DB 中有对应 provider 配置，DB 优先级高于环境变量
- 提供一次性迁移命令（后续实现）：
  - `semibot gateway migrate-env`

## 8.2 向后兼容

- 现有 Feishu API 路径不变
- 现有审批文本解析机制继续有效
- 不影响 CLI 与 Web Chat 主链路

---

## 9. 实施计划（建议）

1. 数据层：`gateway_configs` 表 + ConfigStore 读写接口
2. API 层：`/v1/config/gateways/*` + Telegram 入站/出站端点
3. Gateway 适配层：抽象统一接口，接 Feishu/Telegram 适配器
4. 前端层：Config 页新增 `Gateways` Tab 与编辑弹窗
5. E2E：Feishu/Telegram 入站消息、审批、批量审批、测试通知

---

## 10. 验收标准（DoD）

- 配置页可分别配置飞书与 Telegram，并保存到 SQLite
- Telegram webhook 入站可触发 `chat.message.received`
- Telegram 中可通过“同意/拒绝/approve/reject”完成审批
- Feishu 现有回调与通知能力不回归
- 审批展示支持聚合与批量处理，且可审计回放
