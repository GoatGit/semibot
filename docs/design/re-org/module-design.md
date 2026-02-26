# 模块级设计（Class/Dependency）

> 目标：固定模块职责与依赖方向，避免实现阶段循环依赖。

## 1. 依赖方向

`entry(cli/api/gateway)` -> `events` -> `orchestrator` -> `tools|mcp|skills` -> `memory|llm|sandbox|storage`

约束：
- `events` 不依赖具体工具实现，只依赖路由抽象
- `tools|mcp|skills` 不直接写 `events` 表，通过审计/事件发布接口回写
- `orchestrator` 不直接访问规则存储

## 2. 关键类

```python
@dataclass
class Event:
    event_id: str
    event_type: str
    source: str
    subject: str | None
    payload: dict
    timestamp: datetime
    idempotency_key: str | None
    risk_hint: str | None
```

```python
class EventEngine:
    def __init__(self, bus, store, rules, router, approvals): ...
    async def publish(self, event: Event) -> None: ...
```

```python
class RulesEngine:
    async def handle_event(self, event: Event) -> None: ...
    def match_rules(self, event: Event) -> list[EventRule]: ...
    def decide(self, rule: EventRule, event: Event) -> RuleDecision: ...
```

```python
class EventRouter:
    async def route(self, event: Event, rule: EventRule, decision: RuleDecision) -> None: ...
```

## 2.1 类结构草案（组合关系）

```text
EventEngine
  |- EventBus
  |- EventStore
  |- RulesEngine
  |    |- RuleEvaluator
  |    |- AttentionBudget
  |- EventRouter
  |    |- ActionExecutor (Protocol)
  |- ApprovalManager
  `- ReplayManager
```

说明：
- `EventEngine` 只做编排，不直接执行业务动作。
- `RulesEngine` 只产出决策，不直接调用 Orchestrator。
- `EventRouter` 是动作执行唯一入口，通过 `ActionExecutor` 解耦具体实现。

## 3. 接口抽象

```python
class ActionExecutor(Protocol):
    async def notify(self, payload: dict) -> None: ...
    async def run_agent(self, payload: dict) -> None: ...
    async def execute_plan(self, payload: dict) -> None: ...
    async def call_webhook(self, payload: dict) -> None: ...
```

```python
class OrchestratorBridge(Protocol):
    async def run_agent(self, agent_id: str, payload: dict, trace_id: str) -> dict: ...
    async def execute_plan(self, plan: dict, trace_id: str) -> dict: ...
```

`ActionExecutor` 可由 `OrchestratorBridge` + 通知/Webhook 适配器组合实现。

`EventRouter` 仅依赖 `ActionExecutor`，不依赖具体 Orchestrator。

## 4. 状态存储边界

- `EventStore`：事件与规则运行记录
- `ApprovalStore`：审批请求状态
- `RuleStore`：规则定义与热更新版本

不允许：
- 路由层直接拼 SQL
- 规则引擎直接调用 SQLite 游标

## 5. 生命周期钩子接入点

- `BaseAgent.run()` 前后发布 `agent.lifecycle.pre_execute` / `agent.lifecycle.post_execute`
- `UnifiedActionExecutor.execute()` 发布 `tool.exec.started/completed/failed`
- `MemoryConsolidator` 发布 `memory.write.important`
