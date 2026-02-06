# 任务：消除 Agent 和 Node 代码重复

## 任务 ID
`runtime-code-deduplication`

## 优先级
P2 - 中优先级

## 关联 PRD
`runtime-comprehensive-review.md` - 问题 2.3, 2.4

## 问题描述

`PlannerAgent`/`ExecutorAgent` 类和 `plan_node`/`act_node` 函数实现了几乎相同的逻辑，造成代码冗余。需要明确架构设计。

## 当前状态

### PlannerAgent vs plan_node
- `PlannerAgent.execute()` (~120 行) 实现规划逻辑
- `plan_node()` (~60 行) 实现几乎相同的规划逻辑
- 两者都调用 LLM 生成计划，解析响应

### ExecutorAgent vs act_node
- `ExecutorAgent.execute()` (~150 行) 实现执行逻辑
- `act_node()` (~60 行) + `_execute_parallel()` + `_execute_single()` (~50 行) 实现几乎相同的执行逻辑

## 推荐架构方案

### 方案 A：Node 调用 Agent（推荐）

让 Node 函数作为薄层包装，调用 Agent 类执行核心逻辑：

```python
# nodes.py
async def plan_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    """PLAN node: 使用 PlannerAgent 生成执行计划."""
    planner = PlannerAgent(
        llm_provider=context.get("llm_provider"),
        skill_registry=context.get("skill_registry"),
        memory_system=context.get("memory_system"),
    )
    return await planner.execute(state)

async def act_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    """ACT node: 使用 ExecutorAgent 执行动作."""
    executor = ExecutorAgent(
        llm_provider=context.get("llm_provider"),
        skill_registry=context.get("skill_registry"),
        action_executor=context.get("action_executor"),
    )
    return await executor.execute(state)
```

### 方案 B：删除 Agent 类，保留 Node 函数

如果 Agent 类不需要独立复用，可以删除并只保留 Node 函数。

### 方案 C：将 Node 函数逻辑移入 Agent 类

Node 函数只做状态转换，所有业务逻辑在 Agent 类中。

## 推荐方案 A 的理由

1. **职责分离**: Node 负责状态机集成，Agent 负责业务逻辑
2. **可测试性**: Agent 类更容易单元测试
3. **可复用性**: Agent 类可以在非 LangGraph 场景复用
4. **一致性**: 与 BaseAgent 抽象设计一致

## 需要清理的代码

1. 删除 `nodes.py` 中的 `_build_planning_prompt()` 函数（未使用）
2. 删除 `nodes.py` 中的 `_parse_plan_response()` 函数（与 PlannerAgent 重复）
3. 删除 `nodes.py` 中的 `_parse_reflection_response()` 函数
4. 删除 `nodes.py` 中的 `_execute_parallel()` 和 `_execute_single()` 函数

## 验收标准

- [ ] 选定并实现一种架构方案
- [ ] 删除重复代码
- [ ] 删除未使用的函数
- [ ] 测试覆盖更新
- [ ] 文档更新说明架构设计

## 实现步骤

1. 确认架构方案选择
2. 重构 `plan_node` 调用 `PlannerAgent`
3. 重构 `act_node` 调用 `ExecutorAgent`
4. 删除 `nodes.py` 中的重复辅助函数
5. 更新相关测试
6. 验证 LangGraph 集成正常工作
