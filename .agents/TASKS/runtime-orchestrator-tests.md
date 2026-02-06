# 任务：添加 Orchestrator 模块测试

## 任务 ID
`runtime-orchestrator-tests`

## 优先级
P1 - 高优先级

## 关联 PRD
`runtime-comprehensive-review.md` - 问题 1.3

## 问题描述

缺少针对 `orchestrator/graph.py`, `orchestrator/nodes.py`, `orchestrator/edges.py`, `orchestrator/state.py` 的测试文件。

## 需要创建的测试文件

### 1. `tests/orchestrator/__init__.py`
空文件

### 2. `tests/orchestrator/test_state.py`
测试状态定义:
- PlanStep 创建和默认值
- ExecutionPlan 创建
- ToolCallResult 创建
- ReflectionResult 创建
- Message TypedDict
- AgentState TypedDict
- create_initial_state() 工厂函数

### 3. `tests/orchestrator/test_edges.py`
测试路由逻辑:
- route_after_plan() 有错误时返回 respond
- route_after_plan() 需要委托时返回 delegate
- route_after_plan() 有步骤时返回 act
- route_after_plan() 无步骤时返回 respond
- route_after_observe() 根据 current_step 路由
- should_continue() 终止条件检查
- route_from_start/act/delegate/reflect 固定路由

### 4. `tests/orchestrator/test_nodes.py`
测试各节点:
- start_node() 内存加载
- start_node() 无内存系统时
- plan_node() 计划生成
- plan_node() 无 LLM 时
- plan_node() 简单问题（无步骤）
- act_node() 动作执行
- act_node() 并行执行
- act_node() 无 executor 时
- delegate_node() 委托执行
- delegate_node() 无 delegator 时
- observe_node() 结果分析
- observe_node() 迭代限制
- observe_node() 全部失败重规划
- reflect_node() 反思生成
- reflect_node() 记忆存储
- respond_node() 响应生成
- respond_node() 错误响应

### 5. `tests/orchestrator/test_graph.py`
测试图构建:
- create_agent_graph() 基本创建
- create_agent_graph() 注入依赖
- create_agent_graph_with_checkpointer() 检查点支持
- 图结构验证（节点、边）

### 6. `tests/orchestrator/conftest.py`
共享 fixtures:
- sample_agent_state
- mock_llm_provider
- mock_action_executor
- mock_memory_system
- mock_context

## 验收标准

- [ ] 所有测试文件已创建
- [ ] 测试覆盖率 >= 80%
- [ ] `pytest tests/orchestrator/ -v` 全部通过
- [ ] 边界条件测试完整

## 实现步骤

1. 创建 `tests/orchestrator/` 目录结构
2. 创建 conftest.py 共享 fixtures
3. 实现 test_state.py
4. 实现 test_edges.py
5. 实现 test_nodes.py
6. 实现 test_graph.py
7. 运行测试验证覆盖率
