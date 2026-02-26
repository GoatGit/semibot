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

## 4. 最小实现清单（MVP）

- EventStore + SQLite 表结构  
- EventBus（进程内订阅）  
- RulesEngine（匹配 + 决策）  
- RuleEvaluator（JSON 条件）  
- EventRouter（notify/run_agent）  
- ApprovalManager（pending/approved/rejected）  

## 5. 最小测试清单（MVP）

- 事件写入与幂等  
- 规则匹配与条件判断  
- 冷却窗口与注意力预算  
- ask/suggest/auto 决策路径  
- 审批通过/拒绝  

## 6. 与现有 runtime 的对接点

- `BaseAgent.run()` 触发 `agent.lifecycle.*`  
- `UnifiedActionExecutor.execute()` 触发 `tool.exec.*`  
- `AuditLogger` 写入 event_rule_runs 与 approval_requests  
