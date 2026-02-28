# Event Engine 与 Orchestrator 边界清单

> 目标：明确职责边界，防止双写逻辑和循环依赖。

## 1. 边界原则

- Event Engine 负责“是否执行”：事件接入、规则判定、治理与审批。
- Orchestrator 负责“如何执行”：任务规划、执行、反思、响应。
- Event Engine 不实现计划编排；Orchestrator 不读取规则存储。

## 2. 职责清单

### Event Engine 负责

- 事件标准化与持久化
- 规则匹配与决策（skip/ask/suggest/auto）
- 去重/冷却/注意力预算/风险分级
- 路由动作到 `ActionExecutor`
- 审批请求生命周期

### Orchestrator 负责

- 执行 `run_agent` 和 `execute_plan`
- 调度 Tools/MCPs/Skills
- 维护执行上下文与状态机流转
- 输出执行结果与执行日志

## 3. 禁止跨边界行为

- Event Engine 不直接调用 Tools/MCP/Skills 实现细节。
- Orchestrator 不直接写 `events/event_rules/event_rule_runs`。
- 两者不共享数据库游标或事务上下文。

## 4. 最小集成步骤（MVP）

1. 定义桥接接口 `OrchestratorBridge`，只暴露：
- `run_agent(agent_id, payload, trace_id)`
- `execute_plan(plan, trace_id)`

2. 在 EventRouter 注入 `ActionExecutor`：
- `run_agent` 动作 -> `OrchestratorBridge.run_agent`
- `execute_plan` 动作 -> `OrchestratorBridge.execute_plan`

3. 在 Orchestrator 关键点发布事件：
- `agent.lifecycle.pre_execute/post_execute`
- `tool.exec.started/completed/failed`

4. 打通审批回调：
- `approval.approved/rejected` 事件回流 Event Engine
- Event Engine 重新路由后决定执行或终止

5. 加入最小回归测试：
- `run_agent` 路由成功
- `high risk` 未审批不执行
- 审批通过后可执行

## 5. 集成验收（MVP）

- 事件触发 `run_agent` 可到达 Orchestrator
- Orchestrator 完成执行后可回写审计与事件
- 无循环依赖（`events` 不 import `orchestrator` 具体实现）

