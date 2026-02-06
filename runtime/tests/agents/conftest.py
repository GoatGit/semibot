"""Shared fixtures for agents tests."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from src.agents.base import AgentConfig


@pytest.fixture
def sample_agent_config():
    """Sample agent configuration."""
    return AgentConfig(
        name="test_agent",
        description="A test agent",
        system_prompt="You are a test agent.",
    )


@pytest.fixture
def mock_llm_provider():
    """Mock LLM provider for agents."""
    provider = AsyncMock()
    provider.chat = AsyncMock(
        return_value=MagicMock(
            content='{"goal": "Test", "steps": []}',
            model="gpt-4o",
            usage={"prompt_tokens": 10, "completion_tokens": 5},
        )
    )
    provider.generate_plan = AsyncMock(
        return_value={
            "goal": "Test goal",
            "steps": [],
        }
    )
    return provider


@pytest.fixture
def mock_skill_registry():
    """Mock skill registry."""
    registry = MagicMock()
    registry.get_tool_schemas = MagicMock(return_value=[])
    registry.get_skill_schemas = MagicMock(return_value=[])
    registry.execute = AsyncMock(
        return_value=MagicMock(success=True, result="test result")
    )
    return registry


@pytest.fixture
def mock_memory_system():
    """Mock memory system."""
    memory = AsyncMock()
    memory.get_short_term = AsyncMock(return_value="")
    memory.search_long_term = AsyncMock(return_value="")
    return memory


@pytest.fixture
def sample_agent_state():
    """Sample agent state for testing."""
    return {
        "session_id": "test_session",
        "agent_id": "test_agent",
        "org_id": "test_org",
        "messages": [
            {"role": "user", "content": "Hello, please help me."},
        ],
        "plan": None,
        "tool_results": [],
        "reflection": None,
        "error": None,
        "current_step": "start",
        "iteration": 0,
        "memory_context": "",
        "metadata": {},
    }
