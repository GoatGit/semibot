# 事件引擎实现级规范（Implementation Spec）

> 目标：给开发者可直接落地的模块划分、接口签名与最小实现清单。  
> 约束：本地单机、SQLite、复用现有 runtime 机制。

## 1. 模块划分

```
semibot/
  events/
    event_bus.py
    event_store.py
    rules_engine.py
    rule_evaluator.py
    event_router.py
    approval_manager.py
    attention_budget.py
    replay_manager.py
    trigger_scheduler.py
  gateway/
    manager.py
    context_service.py
    policies/
      addressing.py
      proactive.py
      context_retention.py
    adapters/
      base.py
      feishu_adapter.py
      telegram_adapter.py
    notifiers/
      feishu_notifier.py
      telegram_notifier.py
    parsers/
      approval_text.py
    store/
      gateway_store.py
  server/
    api.py                    # 仅 HTTP 路由与请求/响应编解码
```

职责说明：

- `event_bus.py`：进程内发布/订阅与异步分发  
- `event_store.py`：SQLite 写入与查询  
- `rules_engine.py`：规则匹配与治理决策  
- `rule_evaluator.py`：条件表达式解析  
- `event_router.py`：动作路由与执行  
- `approval_manager.py`：审批请求与状态变更  
- `attention_budget.py`：预算与冷却窗口  
- `replay_manager.py`：事件回放  
- `trigger_scheduler.py`：heartbeat/cron 周期事件触发  
- `gateway/manager.py`：统一加载 Gateway 配置并分发到 adapter  
- `gateway/context_service.py`：统一维护 Gateway 主会话、任务运行、最小回写  
- `gateway/adapters/feishu_adapter.py`：飞书入站归一化  
- `gateway/adapters/telegram_adapter.py`：Telegram 入站归一化  
- `gateway/notifiers/*`：provider-specific 出站发送  
- `gateway/parsers/approval_text.py`：跨 Gateway 文本审批解析（同意/拒绝/approve/reject）  
- `gateway/store/gateway_store.py`：Gateway 相关 SQLite 读写  
- `server/api.py`：只保留路由转发到 `gateway/*` 服务层  

## 2. 核心接口（签名）

```python
# event_store.py
class EventStore:
    def append(self, event: Event) -> None: ...
    def get(self, event_id: str) -> Event | None: ...
    def exists_idempotency(self, key: str) -> bool: ...
```

```python
# event_bus.py
class EventBus:
    def emit(self, event: Event) -> None: ...
    def subscribe(self, handler: Callable[[Event], Awaitable[None]]) -> None: ...
```

```python
# rules_engine.py
class RulesEngine:
    def __init__(self, store: EventStore, evaluator: RuleEvaluator, router: EventRouter): ...
    async def handle_event(self, event: Event) -> None: ...
```

```python
# event_router.py
class EventRouter:
    async def route(self, event: Event, rule: EventRule) -> None: ...
```

```python
# approval_manager.py
class ApprovalManager:
    async def request(self, approval: ApprovalRequest) -> None: ...
    async def resolve(self, approval_id: str, decision: str) -> None: ...
```

```python
# gateway/context_service.py
class GatewayContextService:
    async def ingest_message(self, provider: str, normalized: dict) -> dict: ...
    async def should_execute(self, provider: str, normalized: dict) -> tuple[bool, str]: ...
    async def create_task_run(self, conversation_id: str, prompt: str, agent_id: str | None = None) -> dict: ...
    async def append_minimal_result(self, run_id: str, final_response: str, metadata: dict) -> None: ...
    async def resolve_text_approval(self, provider: str, normalized: dict) -> dict | None: ...
```

```python
# gateway policy schema (stored in gateway_configs.config_json common area)
class AddressingPolicy(TypedDict):
    mode: Literal["mention_only", "all_messages"]
    allowReplyToBot: bool
    commandPrefixes: list[str]
    sessionContinuationWindowSec: int

class ProactivePolicy(TypedDict):
    mode: Literal["silent", "risk_based", "always"]
    minRiskToNotify: Literal["low", "medium", "high", "critical"]

class ContextPolicy(TypedDict):
    ttlDays: int
    maxRecentMessages: int
    summarizeEveryNMessages: int
```

## 3. 关键伪代码

**RulesEngine.handle_event**

```python
async def handle_event(self, event):
    if event.idempotency_key and self.store.exists_idempotency(event.idempotency_key):
        return

    self.store.append(event)
    rules = self.match_rules(event)
    for rule in rules:
        decision = self.decide(rule, event)
        record_rule_run(...)
        if decision in ("ask", "suggest", "auto"):
            await self.router.route(event, rule)
```

**GatewayContextService.ingest_message（简化）**

```python
async def ingest_message(self, provider, normalized):
    conv = self.get_or_create_conversation(provider=provider, key=normalized["gateway_key"])
    self.append_context_message(conv.id, role="user", content=normalized["text"], metadata=normalized)
    should_execute, reason = await self.should_execute(provider, normalized)
    if not should_execute:
        self.mark_context_metadata(conv.id, addressed=False, address_reason=reason, should_execute=False)
        return {"conversation_id": conv.id, "skipped": True, "reason": reason}
    run = self.create_task_run(conv.id, prompt=normalized["text"], agent_id=normalized.get("agent_id"))
    result = await self.runtime.run_task(
        session_id=run["runtime_session_id"],
        agent_id=run.get("agent_id"),
        task=run["prompt"],
    )
    self.append_minimal_result(run["id"], result["final_response"], {"artifacts": result.get("artifacts", [])})
    return {"conversation_id": conv.id, "run_id": run["id"], "runtime_session_id": run["runtime_session_id"]}
```

**GatewayContextService.should_execute（判定优先级）**

```python
async def should_execute(self, provider, normalized):
    policy = self.get_addressing_policy(provider)
    if normalized.get("is_approval_text"):
        return True, "approval_text"
    if normalized.get("is_mention"):
        return True, "mention"
    if policy.get("allowReplyToBot") and normalized.get("is_reply_to_bot"):
        return True, "reply_to_bot"
    if self.has_command_prefix(normalized.get("text", ""), policy.get("commandPrefixes", [])):
        return True, "command_prefix"
    if policy.get("mode") == "all_messages" and self.in_continuation_window(normalized, policy):
        return True, "continuation_window"
    return False, "not_addressed"
```

## 4. 最小实现清单（MVP）

- EventStore + SQLite 表结构  
- EventBus（进程内订阅）  
- RulesEngine（匹配 + 决策）  
- RuleEvaluator（JSON 条件）  
- EventRouter（notify/run_agent）  
- ApprovalManager（pending/approved/rejected）  
- GatewayContextService（主会话固定 + 任务隔离 + 最小回写）  

## 5. 最小测试清单（MVP）

- 事件写入与幂等  
- 规则匹配与条件判断  
- 冷却窗口与注意力预算  
- ask/suggest/auto 决策路径  
- 审批通过/拒绝  
- Addressing Gate 命中/未命中路径（未命中只注入上下文）  
- `all_messages` 模式下的默认静默行为  

## 6. 与现有 runtime 的对接点

- `BaseAgent.run()` 触发 `agent.lifecycle.*`  
- `UnifiedActionExecutor.execute()` 触发 `tool.exec.*`  
- `AuditLogger` 写入 event_rule_runs 与 approval_requests  
- `Gateway Manager` 统一接入 `/v1/integrations/feishu/*` 与 `/v1/integrations/telegram/*`  
- `GET/PUT /v1/config/gateways/{provider}` 由 runtime SQLite 驱动（非 Postgres）  
- 文本审批解析复用 `gateway/parsers/approval_text.py`，在飞书/Telegram/Webhook 三条入口行为一致  
- Telegram 与飞书都走同一 GatewayContextService，不在 provider adapter 内实现 fork/merge  

## 6.1 现有代码迁移映射（建议）

- `server/feishu.py` -> `gateway/adapters/feishu_adapter.py`
- `server/telegram.py` -> `gateway/adapters/telegram_adapter.py`
- `server/feishu_notifier.py` -> `gateway/notifiers/feishu_notifier.py`
- `server/telegram_notifier.py` -> `gateway/notifiers/telegram_notifier.py`
- `server/approval_text.py` -> `gateway/parsers/approval_text.py`

## 7. 关键配置（环境变量）

- `SEMIBOT_FEISHU_VERIFY_TOKEN`：飞书回调 token 校验（fallback）
- `SEMIBOT_FEISHU_WEBHOOK_URL`：飞书默认出站 webhook（fallback）
- `SEMIBOT_TELEGRAM_BOT_TOKEN`：Telegram bot token（fallback）
- `SEMIBOT_TELEGRAM_DEFAULT_CHAT_ID`：Telegram 默认 chat（fallback）
- 说明：以上环境变量在迁移期仅作为 fallback；长期配置源为 `~/.semibot/semibot.db` 的 `gateway_configs`
