# Gateway 配置与 Telegram 接入详细设计

> 版本：2.0 | 日期：2026-02-28 | 状态：设计中（待实现）

## 1. 目标与边界

### 1.1 目标

- 在配置管理中新增统一 `Gateway` 配置域，集中管理飞书与 Telegram
- 新增 Telegram Gateway（入站消息、出站通知、审批回执）
- 让审批机制在 Web UI / CLI / 第三方聊天工具中保持一致（通用，不绑某个工具）

### 1.2 非目标（本阶段不做）

- 不做多租户隔离，不引入 org/user 维度鉴权
- 不做企业级 SSO，不做独立 IAM
- 不做复杂会话迁移（不同平台间自动合并历史）

### 1.3 设计约束

- 本地单机优先，配置落地到 `~/.semibot/semibot.db`
- 保持现有 Feishu 入站/出站能力兼容
- Gateway 仅作为“消息入口/通知出口”，执行编排仍在 runtime Orchestrator

---

## 2. 总体架构

```text
Feishu / Telegram
        │
        ▼
Gateway Adapter（provider-specific）
        │ normalize / verify / idempotency
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
  - 负责读取网关配置、构建适配器、管理启停状态
- `server/gateways/base.py`
  - 统一接口：`verify` / `normalize_inbound` / `send_outbound`
- `server/gateways/feishu_adapter.py`
  - 复用现有 `feishu.py` + `feishu_notifier.py`，逐步收敛到统一接口
- `server/gateways/telegram_adapter.py`（新增）
  - 处理 Telegram webhook、消息解析、出站发送
- `server/approval_text.py`（已存在，继续复用）
  - 解析“同意/拒绝/approve/reject”等文本审批命令

### 2.2 与 Event Engine 的关系

- Gateway 不做业务决策，只做消息标准化与来源鉴别
- 标准事件统一写入 `events`，并触发规则匹配
- 审批动作统一写入 `approval.action` 事件，便于审计回放

---

## 3. 配置模型（SQLite）

## 3.1 新表：`gateway_configs`

```sql
CREATE TABLE IF NOT EXISTS gateway_configs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL UNIQUE,          -- feishu | telegram
  display_name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'webhook',   -- webhook | polling(预留)
  risk_level TEXT NOT NULL DEFAULT 'high',
  requires_approval INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_gateway_configs_provider ON gateway_configs(provider);
CREATE INDEX IF NOT EXISTS idx_gateway_configs_active ON gateway_configs(is_active);
```

说明：

- `provider` 固定枚举：`feishu`、`telegram`
- `config_json` 存 provider 特有字段（见下文）
- `is_active=false` 时，入站请求返回 `accepted=false, reason=gateway_disabled`

## 3.2 provider 配置字段（`config_json`）

### Feishu

- `verifyToken`: 回调 token
- `encryptKey`: 可选，开启事件加密校验时使用
- `appId` / `appSecret`: 可选，用于后续 bot API
- `webhookUrl`: 默认出站 webhook
- `webhookChannels`: 多通道 webhook 映射（如 `default`, `risk`, `ops`）
- `notifyEventTypes`: 订阅出站事件类型
- `templates`: 出站模板映射

### Telegram（新增）

- `botToken`: Telegram Bot Token（敏感字段）
- `webhookSecret`: 可选，自定义 header secret
- `webhookPath`: 默认 `/v1/integrations/telegram/webhook`
- `defaultChatId`: 默认通知 chat id（群或私聊）
- `allowedChatIds`: 入站白名单（空表示不限制）
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

每个网关一张卡（Feishu / Telegram）：

- 状态：`已启用 / 未启用 / 配置不完整`
- 基础开关：`启用`、`停用`
- 配置入口：`编辑`
- 连通性：`发送测试消息`
- 最近状态：最近一次入站时间、最近一次出站结果

## 4.3 字段表单（MVP）

- Feishu：`verifyToken`、`webhookUrl`、`notifyEventTypes`
- Telegram：`botToken`、`defaultChatId`、`allowedChatIds`、`notifyEventTypes`

约束：

- `botToken` 未配置时，Telegram 卡片提示“不可用”
- `defaultChatId` 为空时允许保存，但禁用“发送测试消息”

---

## 5. API 契约（新增/调整）

## 5.1 配置管理 API（runtime）

- `GET /v1/config/gateways`
  - 返回网关列表（feishu/telegram）及脱敏配置
- `GET /v1/config/gateways/{provider}`
  - 返回单个网关详情
- `PUT /v1/config/gateways/{provider}`
  - 更新网关配置（支持部分字段 patch）
- `POST /v1/config/gateways/{provider}/test`
  - 发送测试消息（provider-specific）

响应示例（`GET /v1/config/gateways`）：

```json
{
  "data": [
    {
      "provider": "feishu",
      "isActive": true,
      "config": {
        "verifyToken": "***",
        "webhookUrl": "https://open.feishu.cn/..."
      },
      "status": "ready"
    },
    {
      "provider": "telegram",
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

## 5.3 出站 API（测试/运维）

- 保留：`POST /v1/integrations/feishu/outbound/test`
- 新增：`POST /v1/integrations/telegram/outbound/test`

---

## 6. 事件映射与审批交互

## 6.1 Telegram 入站映射

- 普通消息：`message.text` → `chat.message.received`
- 回复消息（含审批文本）：优先走 `approval_text` 解析，命中则触发审批
- 按钮回调：`callback_query.data` → `approval.action` / `chat.card.action`

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
