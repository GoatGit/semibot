# Gateway 入口层与 Telegram 交互设计（V2）

> 目标：收敛 Gateway 边界，明确 Telegram 与 Semibot 的消息机制，并统一 `agent_id + session_id` 处理规范。  
> 状态：设计稿（用于指导下一轮代码重构）

## 1. 问题与结论

## 1.1 为什么 runtime 里会有 `telegram_notifier.py`

当前是 **MVP 过渡实现**：
- 入口、事件、编排暂时都挂在 `runtime/src/server/api.py` 这一层，便于快速打通链路。
- 所以出现了 provider 特殊逻辑（Telegram/Feishu）落在 `server` 目录的情况。

这不违背“Gateway 在入口层”的逻辑定义，但**实现边界不够清晰**。

## 1.2 目标结论

- Gateway 仍然是入口层能力（逻辑分层不变）。
- 代码层面应从 `server` 拆出独立 `gateway` 模块，`api.py` 只做路由转发。
- 所有进入 Orchestrator 的消息，必须有 `agent_id + session_id`。

---

## 2. 目标模块边界

建议目录：

```text
runtime/src/
  gateway/
    base.py                  # 通用接口：verify/normalize/send
    manager.py               # provider 装配、入站路由、出站分发
    models.py                # GatewayMessage, GatewayContext, GatewayAction
    providers/
      telegram.py            # Telegram adapter
      feishu.py              # Feishu adapter
```

`runtime/src/server/api.py` 仅保留：
- HTTP endpoint 定义
- 把请求交给 `gateway.manager` 处理
- 返回标准响应

---

## 3. Telegram ↔ Semibot 交互机制

## 3.1 入站（Telegram -> Semibot）

1. Telegram 调用 webhook：`POST /v1/integrations/telegram/webhook`  
2. Gateway 层校验：`secret_token`、`allowedChatIds`、去重（`update_id`）  
3. 归一化为标准消息 `GatewayMessage`  
4. 路由解析 `agent_id`（显式 mention / 路由表 / 默认 agent）  
5. 生成或复用 `session_id`  
6. 投递 `chat.message.received` 事件到 Event Engine  
7. 进入规则+编排执行  
8. 执行结果经 Gateway 出站回发 Telegram

## 3.2 出站（Semibot -> Telegram）

- 普通回复：任务最终回复文本
- 系统通知：`approval.requested`、`task.completed`、`task.failed`
- 审批交互：按钮回调 + 文本命令（`同意/拒绝`、`/approve id`、`/reject id`、`全部同意/全部拒绝`）

---

## 4. 消息主键机制（核心约束）

用户问题的答案：**是的，处理链路必须遵循每条消息都带 `agent_id + session_id`。**

## 4.1 统一规范

- `agent_id`：该消息要交给哪个智能体处理
- `session_id`：该消息归属哪个上下文会话（记忆、历史、审批都依赖它）

## 4.2 Telegram 推荐生成规则

- `agent_id` 解析优先级：
1. 消息显式指定（如 `@research_bot` -> 路由到绑定 agent）
2. Chat 级路由配置（`chat_id -> agent_id`）
3. 系统默认 `semibot`

- `session_id` 规则：
1. 群聊默认：`tg:<chat_id>:<agent_id>`
2. 群话题线程（topic/thread）可细分：`tg:<chat_id>:<thread_id>:<agent_id>`
3. 私聊：`tg:dm:<user_id>:<agent_id>`

这样能保证：
- 同一群里不同 agent 会话隔离
- 同一 agent 在同一群连续对话可复用上下文

## 4.3 归一化消息模型（建议）

```json
{
  "gateway": "telegram",
  "gateway_message_id": "688728641",
  "gateway_chat_id": "-5223952677",
  "gateway_user_id": "8697035918",
  "text": "@semibot1_bot 搜索今天的新闻",
  "agent_id": "semibot",
  "session_id": "tg:-5223952677:semibot",
  "timestamp": "2026-02-28T03:20:56Z"
}
```

---

## 5. 与 Event Engine / Orchestrator 的边界

- Gateway：负责“接入协议与消息归一化”，不做业务决策。
- Event Engine：负责“规则判定、风险治理、审批决策”。
- Orchestrator：负责“复杂任务执行与工具编排”。

硬约束：
- Event Engine 之后不再依赖 Telegram/Feishu 原始字段做业务决策。
- 业务逻辑只使用标准化字段（`agent_id/session_id/text/context`）。

---

## 6. 落地步骤（最小改造）

1. 新建 `gateway/` 模块与 `GatewayManager`。  
2. 将 `runtime/src/server/telegram.py`、`runtime/src/server/telegram_notifier.py` 迁入 `gateway/providers/telegram.py`。  
3. `api.py` 改为调用 `gateway_manager.ingest(provider, request)` / `gateway_manager.send(...)`。  
4. 增加会话路由配置（`chat_id -> agent_id`）与默认规则。  
5. 补充集成测试：  
   - 入站消息必须产出 `agent_id + session_id`  
   - 同群不同 agent 会话隔离  
   - 审批文本命令在 Telegram/Feishu 一致生效

---

## 7. 验收标准

- Telegram 入站消息 100% 带 `agent_id + session_id` 后才允许进入编排层。  
- `api.py` 中不再直接包含 Telegram/Feishu provider 细节逻辑。  
- 群聊消息、审批消息、任务结果消息均可稳定双向收发。  
