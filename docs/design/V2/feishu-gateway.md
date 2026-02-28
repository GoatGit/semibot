# 飞书群聊接入（详细设计）

> 目标：把飞书群聊作为协作前台，与事件框架和审批机制联动。  
> 约束：群聊只做协作前台，执行逻辑在 Orchestrator。
> 说明：V2 已引入统一 Gateway 设计（飞书 + Telegram），本文件聚焦飞书 provider 细节；通用配置与接口见 [gateway-design.md](./gateway-design.md)。
> 会话治理：与 Telegram 共用 `Gateway Context Service`（主会话固定 + 任务隔离 + 最小回写）。

## 1. 事件映射

- 群消息 → `chat.message.received`
- @提醒 → `chat.mention.received`
- 审批操作 → `approval.action`
- 卡片按钮 → `chat.card.action`

## 2. 角色与协作流

角色示例：Supervisor / Worker‑Research / Worker‑Ops / Worker‑QA  
群内只展示分工、进度、审批和结果。

## 3. 卡片模板（MVP）

**任务卡片**  
标题：任务摘要  
字段：负责人、状态、截止时间  
按钮：查看详情、提交结果  

**审批卡片**  
标题：需要审批  
字段：风险说明、拟执行动作  
按钮：批准、拒绝  

**结果卡片**  
标题：执行结果  
字段：摘要、耗时、下一步建议  

## 3.1 卡片字段示例（结构化）

**任务卡片字段**  
id, title, assignee, status, due_at, summary

**审批卡片字段**  
approval_id, event_id, risk_level, action, summary

**结果卡片字段**  
trace_id, outcome, duration_ms, next_step

## 4. 最小功能清单

- 接入群消息事件  
- 发送任务卡片  
- 审批卡片回传  
- 结果卡片回写  

## 5. 网关 HTTP 入口（MVP）

- `POST /v1/integrations/feishu/events`
  - URL 验证：`type=url_verification` 返回 `{"challenge":"..."}`  
  - 消息回调：`header.event_type=im.message.receive_v1` 映射为 `chat.message.received`
- `POST /v1/integrations/feishu/card-actions`
  - 卡片动作统一映射为 `chat.card.action`
  - 若包含 `approval_id + decision(approve/reject)`，直接调用审批流，并额外写入 `approval.action` 事件
- `POST /v1/integrations/feishu/outbound/test`
  - 发送测试卡片到配置的飞书 webhook（连通性验证）

## 6. 安全与幂等

- 使用 `SEMIBOT_FEISHU_VERIFY_TOKEN` 做回调 token 校验
- `message_id` / `event_id` 生成 `idempotency_key`，避免重复消费
- 审批动作落地 `approval.approved|approval.rejected` 事件，便于回放与审计

## 7. 与事件框架对接

- 群消息直接进入 `EventBus.emit`  
- 审批结果生成 `approval.*` 事件  
- 事件引擎驱动 Orchestrator 执行

## 8. 出站通知（MVP）

- 使用 `SEMIBOT_FEISHU_WEBHOOK_URL` 启用出站卡片通知
- 或使用 `SEMIBOT_FEISHU_WEBHOOKS_JSON` 配置多通道 webhook（如 default/ops/risk）
- 默认订阅事件：
- `approval.requested` -> 审批卡片
- `task.completed` / `rule.run_agent.executed` -> 结果卡片
- 卡片回调可携带 `trace_id`，并在 `chat.card.action` 事件中保留，便于全链路定位

可选增强：
- `SEMIBOT_FEISHU_NOTIFY_EVENT_TYPES`：逗号分隔，覆盖默认订阅事件
- `SEMIBOT_FEISHU_TEMPLATES_JSON`：按 `event_type` 配置卡片标题/内容模板（`{trace_id}` 等占位符）
- 规则动作 `notify` 可通过 `params.channel` 路由到指定 webhook 通道
