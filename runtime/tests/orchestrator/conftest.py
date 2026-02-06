"""Shared fixtures for orchestrator tests."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from src.orchestrator.state import (
    AgentState,
    ExecutionPlan,
    PlanStep,
    ReflectionResult,
    ToolCallResult,
)


@pytest.fixture
def sample_plan_step():
    """Sample plan step."""
    return PlanStep(
        id="step_1",
        title="Search for information",
        description="Search the web for relevant information",
        tool="web_search",
        params={"query": "test query"},
        parallel=False,
    )


@pytest.fixture
def sample_execution_plan(sample_plan_step):
    """Sample execution plan."""
    return ExecutionPlan(
        goal="Find information about the topic",
        analysis="User wants to search for information",
        steps=[sample_plan_step],
        current_step_index=0,
    )


@pytest.fixture
def sample_tool_result():
    """Sample tool call result."""
    return ToolCallResult(
        tool_name="web_search",
        success=True,
        result={"data": "search results"},
        error=None,
        duration_ms=150,
    )


@pytest.fixture
def sample_reflection():
    """Sample reflection result."""
    return ReflectionResult(
        summary="Task completed successfully",
        lessons_learned=["Search was effective"],
        worth_remembering=True,
        importance=0.7,
    )


@pytest.fixture
def sample_agent_state(sample_execution_plan, sample_tool_result):
    """Sample agent state for testing."""
    return {
        "session_id": "test_session",
        "agent_id": "test_agent",
        "org_id": "test_org",
        "messages": [
            {"role": "user", "content": "Search for test information"},
        ],
        "plan": sample_execution_plan,
        "tool_results": [sample_tool_result],
        "reflection": None,
        "error": None,
        "current_step": "observe",
        "iteration": 1,
        "memory_context": "",
        "metadata": {},
    }


@pytest.fixture
def mock_llm_provider():
    """Mock LLM provider."""
    provider = AsyncMock()
    provider.generate_plan = AsyncMock(
        return_value={
            "goal": "Test goal",
            "steps": [
                {
                    "id": "step_1",
                    "title": "Test step",
                    "tool": "test_tool",
                    "params": {},
                }
            ],
        }
    )
    provider.generate_response = AsyncMock(return_value="Test response")
    provider.reflect = AsyncMock(
        return_value={
            "summary": "Test summary",
            "lessons_learned": [],
            "worth_remembering": False,
            "importance": 0.5,
        }
    )
    return provider


@pytest.fixture
def mock_action_executor():
    """Mock action executor."""
    executor = AsyncMock()
    executor.execute = AsyncMock(return_value={"result": "success"})
    return executor


@pytest.fixture
def mock_memory_system():
    """Mock memory system."""
    memory = AsyncMock()
    memory.get_short_term = AsyncMock(return_value="")
    memory.search_long_term = AsyncMock(return_value="")
    memory.save_long_term = AsyncMock(return_value="entry_123")
    return memory


@pytest.fixture
def mock_context(mock_llm_provider, mock_action_executor, mock_memory_system):
    """Mock context with all dependencies."""
    return {
        "llm_provider": mock_llm_provider,
        "action_executor": mock_action_executor,
        "memory_system": mock_memory_system,
        "skill_registry": MagicMock(),
    }
