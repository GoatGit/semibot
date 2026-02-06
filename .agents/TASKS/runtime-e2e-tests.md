# 任务：添加 Runtime 端到端测试

## 任务 ID
`runtime-e2e-tests`

## 优先级
P1 - 高优先级

## 关联 PRD
`runtime-comprehensive-review.md` - 问题 5.3

## 问题描述

没有完整的 Agent 执行流程端到端测试，无法验证各模块集成是否正常工作。

## 需要创建的测试

### 1. `tests/e2e/__init__.py`
空文件

### 2. `tests/e2e/test_agent_flow.py`
完整 Agent 执行流程测试:
- 简单问答流程（无工具调用）
- 单步工具调用流程
- 多步顺序执行流程
- 并行工具调用流程
- 错误恢复和重规划流程
- 迭代限制保护
- 内存上下文加载

### 3. `tests/e2e/test_queue_flow.py`
队列处理流程测试:
- 任务入队和出队
- 任务处理和结果发布
- 多消费者并发处理
- 失败重试流程
- 死信队列处理

### 4. `tests/e2e/test_memory_flow.py`
内存系统流程测试:
- 短期内存存取
- 长期内存语义搜索
- 内存过期和清理
- 内存跨会话持久化

### 5. `tests/e2e/conftest.py`
端到端测试 fixtures:
- 完整的 context 配置
- Mock LLM Provider（返回预定义响应）
- 真实 Redis 连接（使用测试容器或 mock）
- 真实 PostgreSQL 连接（使用测试容器或 mock）
- 工具和技能注册

## 测试场景详细设计

### 场景 1：简单问答
```python
async def test_simple_qa_flow():
    """测试简单问答不调用工具."""
    state = create_initial_state(
        session_id="test_session",
        agent_id="test_agent",
        org_id="test_org",
        user_message="What is 2+2?",
    )

    # Mock LLM 返回无步骤计划
    mock_llm.generate_plan.return_value = {
        "goal": "Answer the question",
        "steps": [],
        "direct_response": "2+2 equals 4."
    }

    graph = create_agent_graph(context)
    result = await graph.ainvoke(state)

    assert result["current_step"] == "respond"
    assert len(result["tool_results"]) == 0
    assert "4" in result["messages"][-1]["content"]
```

### 场景 2：工具调用流程
```python
async def test_tool_call_flow():
    """测试单步工具调用."""
    state = create_initial_state(
        session_id="test_session",
        agent_id="test_agent",
        org_id="test_org",
        user_message="Search for AI news",
    )

    # Mock LLM 返回搜索步骤
    mock_llm.generate_plan.return_value = {
        "goal": "Search for AI news",
        "steps": [
            {"id": "step_1", "title": "Search", "tool": "web_search", "params": {"query": "AI news"}}
        ],
    }

    graph = create_agent_graph(context)
    result = await graph.ainvoke(state)

    assert len(result["tool_results"]) == 1
    assert result["tool_results"][0].tool_name == "web_search"
```

## 验收标准

- [ ] 所有 E2E 测试文件已创建
- [ ] 关键流程都有测试覆盖
- [ ] 测试可在 CI 环境运行
- [ ] 使用测试容器或有效 mock
- [ ] `pytest tests/e2e/ -v` 全部通过

## 实现步骤

1. 创建 `tests/e2e/` 目录结构
2. 设置测试容器配置（Docker Compose 或 testcontainers）
3. 创建 conftest.py 共享 fixtures
4. 实现 test_agent_flow.py
5. 实现 test_queue_flow.py
6. 实现 test_memory_flow.py
7. 配置 CI 运行 E2E 测试
8. 验证所有场景通过
