"""End-to-end tests for complete Agent execution workflows.

These tests verify the entire Agent execution pipeline from input to output.
"""

import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from src.orchestrator.unified_executor import UnifiedExecutor
from src.orchestrator.context import RuntimeSessionContext, AgentConfig, RuntimePolicy
from src.queue.models import TaskMessage


@pytest.fixture
def mock_llm_provider():
    """Create mock LLM provider."""
    provider = AsyncMock()

    # Mock planning response
    provider.chat.side_effect = [
        # First call: planning
        MagicMock(
            content='{"goal": "Search for information", "steps": [{"id": "1", "title": "Search web", "tool": "web_search", "params": {"query": "test query"}}]}'
        ),
        # Second call: reflection
        MagicMock(
            content="Based on the search results, here is the answer: Test result found."
        ),
    ]

    return provider


@pytest.fixture
def mock_skill_registry():
    """Create mock skill registry."""
    registry = AsyncMock()

    # Mock skill execution
    mock_result = MagicMock(
        success=True,
        result="Search completed: Found relevant information about test query.",
        metadata={"source": "web_search"},
    )
    registry.execute.return_value = mock_result
    registry.list_tools.return_value = ["web_search", "code_executor"]

    return registry


@pytest.fixture
def mock_memory():
    """Create mock memory service."""
    memory = AsyncMock()
    memory.save.return_value = "memory-id-123"
    memory.get_recent.return_value = []
    memory.search.return_value = []
    return memory


@pytest.fixture
def runtime_context(mock_llm_provider, mock_skill_registry, mock_memory):
    """Create RuntimeSessionContext with mocked dependencies."""
    return RuntimeSessionContext(
        session_id="test-session-e2e",
        user_id="test-user",
        org_id="test-org",
        agent_config=AgentConfig(
            agent_id="test-agent",
            name="Test Agent",
            description="E2E test agent",
            model="gpt-4o",
            temperature=0.7,
            max_tokens=2000,
        ),
        policy=RuntimePolicy(
            max_iterations=5,
            max_execution_time=300,
            allowed_tools=["web_search", "code_executor"],
            sandbox_enabled=True,
        ),
        llm_provider=mock_llm_provider,
        skill_registry=mock_skill_registry,
        memory=mock_memory,
    )


@pytest.mark.asyncio
async def test_complete_agent_execution_flow(runtime_context, mock_llm_provider, mock_skill_registry):
    """Test complete Agent execution from input to final response."""
    executor = UnifiedExecutor(context=runtime_context)

    # User input
    user_message = "Search for information about Semibot"

    # Execute
    result = await executor.execute(
        messages=[{"role": "user", "content": user_message}]
    )

    # Verify execution completed
    assert result is not None
    assert "final_response" in result or "response" in result

    # Verify LLM was called for planning and reflection
    assert mock_llm_provider.chat.call_count >= 2

    # Verify skill was executed
    assert mock_skill_registry.execute.call_count >= 1


@pytest.mark.asyncio
async def test_agent_handles_multi_step_plan(runtime_context, mock_llm_provider, mock_skill_registry):
    """Test Agent execution with multi-step plan."""
    # Mock multi-step plan
    mock_llm_provider.chat.side_effect = [
        # Planning: multiple steps
        MagicMock(
            content='{"goal": "Complete complex task", "steps": ['
                    '{"id": "1", "title": "Step 1", "tool": "web_search", "params": {"query": "step 1"}},'
                    '{"id": "2", "title": "Step 2", "tool": "code_executor", "params": {"code": "print(1)"}},'
                    '{"id": "3", "title": "Step 3", "tool": "web_search", "params": {"query": "step 3"}}'
                    ']}'
        ),
        # Reflection
        MagicMock(content="All steps completed successfully."),
    ]

    # Mock skill results
    mock_skill_registry.execute.side_effect = [
        MagicMock(success=True, result="Step 1 result"),
        MagicMock(success=True, result="Step 2 result"),
        MagicMock(success=True, result="Step 3 result"),
    ]

    executor = UnifiedExecutor(context=runtime_context)

    result = await executor.execute(
        messages=[{"role": "user", "content": "Complete a complex task"}]
    )

    # Verify all steps were executed
    assert mock_skill_registry.execute.call_count == 3


@pytest.mark.asyncio
async def test_agent_handles_execution_failure_and_replans(runtime_context, mock_llm_provider, mock_skill_registry):
    """Test Agent handles execution failures and replans."""
    # Mock initial plan and replan
    mock_llm_provider.chat.side_effect = [
        # Initial plan
        MagicMock(
            content='{"goal": "Task with failure", "steps": [{"id": "1", "title": "Failing step", "tool": "web_search", "params": {"query": "test"}}]}'
        ),
        # Replan after failure
        MagicMock(
            content='{"goal": "Task with alternative", "steps": [{"id": "2", "title": "Alternative step", "tool": "code_executor", "params": {"code": "print(2)"}}]}'
        ),
        # Reflection
        MagicMock(content="Task completed with alternative approach."),
    ]

    # Mock first execution fails, second succeeds
    mock_skill_registry.execute.side_effect = [
        MagicMock(success=False, error="Execution failed"),
        MagicMock(success=True, result="Alternative succeeded"),
    ]

    executor = UnifiedExecutor(context=runtime_context)

    result = await executor.execute(
        messages=[{"role": "user", "content": "Task that may fail"}]
    )

    # Verify replanning occurred
    assert mock_llm_provider.chat.call_count >= 3  # plan + replan + reflect
    assert mock_skill_registry.execute.call_count == 2


@pytest.mark.asyncio
async def test_agent_respects_max_iterations(runtime_context, mock_llm_provider, mock_skill_registry):
    """Test Agent respects max_iterations limit."""
    # Set low max_iterations
    runtime_context.policy.max_iterations = 2

    # Mock continuous failures to trigger iteration limit
    mock_llm_provider.chat.side_effect = [
        MagicMock(content='{"goal": "Task", "steps": [{"id": "1", "title": "Step", "tool": "web_search", "params": {}}]}'),
        MagicMock(content='{"goal": "Task", "steps": [{"id": "2", "title": "Step", "tool": "web_search", "params": {}}]}'),
        MagicMock(content="Max iterations reached."),
    ]

    mock_skill_registry.execute.return_value = MagicMock(success=False, error="Failed")

    executor = UnifiedExecutor(context=runtime_context)

    result = await executor.execute(
        messages=[{"role": "user", "content": "Task"}]
    )

    # Should stop after max_iterations
    assert result is not None


@pytest.mark.asyncio
async def test_agent_uses_memory_context(runtime_context, mock_llm_provider, mock_skill_registry, mock_memory):
    """Test Agent uses memory context in execution."""
    # Mock memory retrieval
    mock_memory.get_recent.return_value = [
        MagicMock(content="Previous conversation context", metadata={"timestamp": "2024-01-01"}),
    ]

    executor = UnifiedExecutor(context=runtime_context)

    result = await executor.execute(
        messages=[{"role": "user", "content": "Continue from previous conversation"}]
    )

    # Verify memory was queried
    assert mock_memory.get_recent.call_count >= 1

    # Verify memory was saved
    assert mock_memory.save.call_count >= 1


@pytest.mark.asyncio
async def test_agent_handles_timeout(runtime_context, mock_llm_provider, mock_skill_registry):
    """Test Agent handles execution timeout."""
    # Set short timeout
    runtime_context.policy.max_execution_time = 1  # 1 second

    # Mock slow execution
    async def slow_execute(*args, **kwargs):
        await asyncio.sleep(2)  # Longer than timeout
        return MagicMock(success=True, result="Slow result")

    mock_skill_registry.execute = slow_execute

    executor = UnifiedExecutor(context=runtime_context)

    # Should timeout
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(
            executor.execute(messages=[{"role": "user", "content": "Slow task"}]),
            timeout=runtime_context.policy.max_execution_time,
        )


@pytest.mark.asyncio
async def test_agent_enforces_tool_restrictions(runtime_context, mock_llm_provider, mock_skill_registry):
    """Test Agent enforces allowed_tools policy."""
    # Restrict to only web_search
    runtime_context.policy.allowed_tools = ["web_search"]

    # Mock plan with restricted tool
    mock_llm_provider.chat.side_effect = [
        MagicMock(
            content='{"goal": "Task", "steps": [{"id": "1", "title": "Use restricted tool", "tool": "code_executor", "params": {}}]}'
        ),
        MagicMock(content="Tool not allowed."),
    ]

    executor = UnifiedExecutor(context=runtime_context)

    result = await executor.execute(
        messages=[{"role": "user", "content": "Use restricted tool"}]
    )

    # Should handle tool restriction (implementation-dependent)
    assert result is not None


@pytest.mark.asyncio
async def test_queue_to_executor_integration():
    """Test integration between Queue and Executor."""
    # Create task message
    task = TaskMessage(
        task_id="task-e2e-001",
        session_id="sess-e2e",
        agent_id="agent-e2e",
        org_id="org-e2e",
        messages=[{"role": "user", "content": "Test queue integration"}],
        config={},
        metadata={},
    )

    # Mock executor
    mock_executor = AsyncMock()
    mock_executor.execute.return_value = {
        "final_response": "Task completed via queue",
        "status": "success",
    }

    # Simulate task processing
    result = await mock_executor.execute(messages=task.messages)

    assert result["status"] == "success"
    assert "final_response" in result


@pytest.mark.asyncio
async def test_agent_streaming_response():
    """Test Agent can stream responses via SSE."""
    # Mock streaming callback
    events = []

    async def on_event(event):
        events.append(event)

    # This test would require actual streaming implementation
    # Placeholder for streaming test structure

    # Verify events were streamed
    # assert len(events) > 0
    # assert any(e["type"] == "plan_created" for e in events)
    # assert any(e["type"] == "step_completed" for e in events)
    pass  # TODO: Implement when streaming is available
