# 事件引擎接口设计（Reflex Engine API 草案）

> 目的：为后续实现提供清晰接口与模块边界，同时复用现有 runtime 机制。  
> 范围：本地单机优先，不引入外部队列或数据库服务。

## 1. 模块边界（建议）

- `semibot/events/event_bus.py`  
  进程内事件队列与分发。

- `semibot/events/event_store.py`  
  SQLite 持久化，提供 append 与查询能力。

- `semibot/events/rules_engine.py`  
  规则匹配、治理判断、路由执行。

- `semibot/events/rule_evaluator.py`  
  条件表达式解析与安全执行。

- `semibot/events/approval_manager.py`  
  HITL 审批请求与状态更新。

- `semibot/events/attention_budget.py`  
  注意力预算、冷却窗口、去重逻辑。

- `semibot/events/event_router.py`  
  执行动作类型路由到 Orchestrator / UnifiedActionExecutor。

## 2. 核心数据结构（Python 草案）

```python
@dataclass
class Event:
    event_id: str
    event_type: str
    source: str
    subject: str | None
    timestamp: datetime
    payload: dict
    idempotency_key: str | None
    risk_hint: str | None
```

```python
@dataclass
class EventRule:
    id: str
    name: str
    event_type: str
    conditions: dict
    action_mode: str  # ask|suggest|auto
    actions: list[RuleAction]
    risk_level: str   # low|medium|high
    priority: int
    dedupe_window_seconds: int
    cooldown_seconds: int
    attention_budget_per_day: int
    is_active: bool
```

```python
@dataclass
class RuleDecision:
    decision: str   # skip|ask|suggest|auto
    reason: str
    rule_id: str
```

```python
@dataclass
class RuleAction:
    action_type: str   # notify|run_agent|execute_plan|call_webhook|log_only
    target: str | None
    params: dict
```

## 3. 关键接口（调用顺序）

```python
class EventBus:
    def emit(self, event: Event) -> None: ...
    def subscribe(self, handler: Callable[[Event], Awaitable[None]]) -> None: ...
```

```python
class EventStore:
    def append(self, event: Event) -> None: ...
    def exists_idempotency(self, key: str) -> bool: ...
```

```python
class RulesEngine:
    async def handle_event(self, event: Event) -> None: ...
    def match_rules(self, event: Event) -> list[EventRule]: ...
    def decide(self, rule: EventRule, event: Event) -> RuleDecision: ...
```

```python
class EventRouter:
    async def route(self, decision: RuleDecision, event: Event) -> None: ...
```

## 3.1 接口约束（更细）

### EventBus

- `emit(event)` 约束：
- `event.event_id` 必填且唯一。
- 不允许阻塞调用线程，必须异步分发。
- 分发失败必须写审计，不得吞异常。

- `subscribe(handler)` 约束：
- handler 必须是 `async` 可等待函数。
- 同一 handler 重复注册应去重。

### EventStore

- `append(event)` 约束：
- `idempotency_key` 冲突时返回可识别错误码。
- 写入必须原子化，失败不应产生半写入。

- `exists_idempotency(key)` 约束：
- 仅做查询判断，不改变状态。
- 查询延迟应满足规则链路 P95 目标。

### RulesEngine

- `match_rules(event)` 约束：
- 仅返回 `is_active=true` 规则。
- 必须按 `priority` 降序。

- `decide(rule, event)` 约束：
- 输出必须属于 `skip|ask|suggest|auto`。
- 高风险规则不能输出 `auto`（除非显式 override 并审计）。

- `handle_event(event)` 约束：
- 必须先写 `events` 再写 `event_rule_runs`。
- 每条命中规则必须写一条 `event_rule_runs` 记录。

### EventRouter

- `route(decision, event)` 约束：
- `skip` 不触发动作执行。
- `ask/suggest` 不执行高风险动作。
- 多动作执行时，单动作失败不应中断后续动作。
- 所有动作结果都要落审计并关联 `trace_id`。

## 4. 与现有 runtime 的对接点（建议）

- `BaseAgent.run()` 前后触发 `agent.lifecycle.pre/post`  
- `UnifiedActionExecutor.execute()` 结束触发 `tool.exec.*`  
- `AuditLogger` 作为事件结果落地的默认记录器  

## 5. 规则执行策略（细化）

- 规则匹配按 `priority` 降序  
- 同一事件可触发多个规则，但必须通过冷却窗口与注意力预算  
- `ask` 与 `suggest` 不直接执行动作，仅产出审批或建议卡片  

## 6. 执行选择策略（Tools / MCPs / Skills）

优先级：Tools → MCPs → Skills  

1. 如果规则定义了明确的 `tool_name`，直接触发 Tools  
2. 如果规则指定 `mcp_server` 或 `mcp_tool`，调用 MCP  
3. 若需要推理/生成内容，交给 Skills/LLM 编排  

## 7. 与群聊（飞书）的协作接口

- 群聊消息进入 `EventBus.emit`  
- 审批请求通过群聊卡片回传  
- 审批结果触发 `approval.*` 事件，进入规则引擎二次路由

## 8. 错误处理策略

- `EventStore.append` 失败直接抛错，阻断执行  
- `RulesEngine` 失败记录 `event_rule_runs` 并返回 `skip`  
- `EventRouter` 失败写入审计与 `event_rule_runs.status=failed`  

补充错误码建议：
- `EVENT_DUPLICATE`
- `RULE_DECISION_INVALID`
- `APPROVAL_REQUIRED`
- `ACTION_EXECUTION_FAILED`

## 9. 回放接口（草案）

```python
class ReplayManager:
    async def replay_event(self, event_id: str) -> None: ...
    async def replay_by_type(self, event_type: str, since: datetime) -> int: ...
```

## 10. 最小实现顺序

1. EventStore + EventBus  
2. RulesEngine + 简单条件匹配  
3. EventRouter 只支持 `notify` 与 `run_agent`  
4. 再接入 `ask/suggest` 与 HITL
