"""Pytest fixtures for evolution tests."""

import pytest
from unittest.mock import Mock, AsyncMock
from src.evolution.engine import EvolutionEngine


@pytest.fixture
def mock_llm():
    llm = Mock()
    llm.chat = AsyncMock()
    llm.embed = AsyncMock(return_value=[0.1] * 1536)
    return llm


@pytest.fixture
def mock_memory():
    memory = Mock()
    memory.search_evolved_skills = AsyncMock(return_value=[])
    memory.embed = AsyncMock(return_value=[0.1] * 1536)
    return memory


@pytest.fixture
def mock_registry():
    registry = Mock()
    registry.refresh_cache = AsyncMock()
    return registry


@pytest.fixture
def mock_db():
    db = Mock()
    db.execute = AsyncMock(return_value="skill-001")
    db.fetch = AsyncMock(return_value=[])
    return db


@pytest.fixture
def engine(mock_llm, mock_memory, mock_registry, mock_db):
    eng = EvolutionEngine(mock_llm, mock_memory, mock_registry, mock_db)
    eng._check_cooldown = AsyncMock(return_value=True)
    eng._check_rate_limit = AsyncMock(return_value=True)
    return eng


def make_state(**overrides):
    """构造测试用 state"""
    base = {
        "reflection": {"success": True},
        "tool_results": [{"r": 1}, {"r": 2}, {"r": 3}],
        "agent_config": {"evolution": {"enabled": True}},
        "agent_id": "agent-001",
        "org_id": "org-001",
        "session_id": "session-001",
        "messages": [{"role": "user", "content": "测试消息"}],
        "plan": {"steps": [{"action": "测试"}]},
    }
    base.update(overrides)
    return base
