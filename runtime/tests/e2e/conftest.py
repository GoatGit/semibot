"""Shared fixtures for end-to-end tests."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from src.orchestrator.state import AgentState


@pytest.fixture
def mock_llm_provider():
    """Mock LLM provider for e2e tests."""
    provider = AsyncMock()
    provider.chat = AsyncMock(
        return_value=MagicMock(
            content='{"goal": "Help user", "steps": [{"action": "respond", "params": {}}]}',
            model="gpt-4o",
            usage={"prompt_tokens": 100, "completion_tokens": 50},
        )
    )
    provider.generate_plan = AsyncMock(
        return_value={
            "goal": "Help the user with their request",
            "steps": [
                {"action": "respond", "params": {"message": "I can help you with that."}}
            ],
        }
    )
    return provider


@pytest.fixture
def mock_skill_registry():
    """Mock skill registry for e2e tests."""
    registry = MagicMock()
    registry.get_tool_schemas = MagicMock(return_value=[])
    registry.get_skill_schemas = MagicMock(return_value=[])
    registry.execute = AsyncMock(
        return_value=MagicMock(success=True, result="Tool executed successfully")
    )
    registry.execute_parallel = AsyncMock(
        return_value=[MagicMock(success=True, result="Parallel result")]
    )
    return registry


@pytest.fixture
def mock_memory_system():
    """Mock memory system for e2e tests."""
    memory = AsyncMock()
    memory.get_short_term = AsyncMock(return_value="")
    memory.search_long_term = AsyncMock(return_value="")
    memory.save_short_term = AsyncMock()
    memory.save_long_term = AsyncMock()
    return memory


@pytest.fixture
def e2e_context(mock_llm_provider, mock_skill_registry, mock_memory_system):
    """Complete context for e2e tests."""
    return {
        "llm_provider": mock_llm_provider,
        "skill_registry": mock_skill_registry,
        "memory_system": mock_memory_system,
    }


@pytest.fixture
def initial_state() -> AgentState:
    """Create initial agent state for e2e tests."""
    return AgentState(
        session_id="e2e_test_session",
        agent_id="e2e_test_agent",
        org_id="e2e_test_org",
        messages=[
            {"role": "user", "content": "Hello, can you help me?"},
        ],
        plan=None,
        tool_results=[],
        reflection=None,
        error=None,
        current_step="start",
        iteration=0,
        memory_context="",
        metadata={},
    )


@pytest.fixture
def state_with_plan() -> AgentState:
    """Create state with an existing plan."""
    return AgentState(
        session_id="e2e_test_session",
        agent_id="e2e_test_agent",
        org_id="e2e_test_org",
        messages=[
            {"role": "user", "content": "Search for Python tutorials"},
        ],
        plan={
            "goal": "Find Python tutorials",
            "steps": [
                {"action": "search", "params": {"query": "Python tutorials"}},
                {"action": "respond", "params": {}},
            ],
            "current_step_index": 0,
        },
        tool_results=[],
        reflection=None,
        error=None,
        current_step="act",
        iteration=1,
        memory_context="",
        metadata={},
    )


@pytest.fixture
def state_with_error() -> AgentState:
    """Create state with an error condition."""
    return AgentState(
        session_id="e2e_test_session",
        agent_id="e2e_test_agent",
        org_id="e2e_test_org",
        messages=[
            {"role": "user", "content": "Do something that fails"},
        ],
        plan=None,
        tool_results=[],
        reflection=None,
        error="Something went wrong",
        current_step="start",
        iteration=0,
        memory_context="",
        metadata={},
    )
