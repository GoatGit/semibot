# 飞书群聊接入（详细设计）

> 目标：把飞书群聊作为协作前台，与事件框架和审批机制联动。  
> 约束：群聊只做协作前台，执行逻辑在 Orchestrator。

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

## 5. 与事件框架对接

- 群消息直接进入 `EventBus.emit`  
- 审批结果生成 `approval.*` 事件  
- 事件引擎驱动 Orchestrator 执行
