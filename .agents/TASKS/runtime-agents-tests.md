# 任务：添加 Agents 模块测试

## 任务 ID
`runtime-agents-tests`

## 优先级
P1 - 高优先级

## 关联 PRD
`runtime-comprehensive-review.md` - 问题 1.2

## 问题描述

缺少针对 `agents/base.py`, `agents/executor.py`, `agents/planner.py` 的测试文件。

## 需要创建的测试文件

### 1. `tests/agents/__init__.py`
空文件

### 2. `tests/agents/test_base.py`
测试 `BaseAgent` 和 `AgentConfig`:
- AgentConfig 创建和默认值
- BaseAgent 属性访问
- BaseAgent.run() 执行流程（pre_execute -> execute -> post_execute）
- BaseAgent.get_available_skills()
- BaseAgent.has_skill()
- BaseAgent.to_dict()

### 3. `tests/agents/test_executor.py`
测试 `ExecutorAgent`:
- 默认配置创建
- execute() 无待处理动作
- execute() 无 action_executor 配置
- _execute_parallel() 并行执行
- _execute_single() 单个执行
- _execute_single() 超时处理
- _execute_single() 异常处理
- _is_critical_failure() 判断逻辑
- analyze_failure() LLM 分析

### 4. `tests/agents/test_planner.py`
测试 `PlannerAgent`:
- 默认配置创建
- execute() 无用户消息
- execute() 无 LLM provider
- _get_latest_user_message() 提取逻辑
- _build_planning_context() 上下文构建
- _generate_plan() 计划生成
- _format_skills() 技能格式化
- _parse_plan_response() 响应解析

### 5. `tests/agents/conftest.py`
共享 fixtures:
- mock_llm_provider
- mock_skill_registry
- mock_memory_system
- sample_agent_state

## 验收标准

- [ ] 所有测试文件已创建
- [ ] 测试覆盖率 >= 80%
- [ ] `pytest tests/agents/ -v` 全部通过
- [ ] Mock 正确隔离外部依赖

## 实现步骤

1. 创建 `tests/agents/` 目录结构
2. 创建 conftest.py 共享 fixtures
3. 实现 test_base.py
4. 实现 test_executor.py
5. 实现 test_planner.py
6. 运行测试验证覆盖率
