"""Tests for orchestrator action executor."""

from unittest.mock import AsyncMock

import pytest

from src.orchestrator.executor import ActionExecutor
from src.orchestrator.state import PlanStep


class MockSkillResult:
    """Simple skill result payload."""

    def __init__(self, success: bool = True, result: str = "", error: str | None = None):
        self.success = success
        self.result = result
        self.error = error
        self.metadata = {}


@pytest.mark.asyncio
async def test_search_uses_skill_registry() -> None:
    """Search action should call registry instead of placeholder text."""
    registry = AsyncMock()
    registry.list_tools = lambda: ["web_search"]
    registry.execute.return_value = MockSkillResult(success=True, result="real search result")

    executor = ActionExecutor(skill_registry=registry)
    action = PlanStep(id="step1", title="search", tool="search", params={"query": "semibot"})

    result = await executor.execute(action)

    assert result.success is True
    assert result.result == "real search result"
    assert registry.execute.await_count == 1


@pytest.mark.asyncio
async def test_llm_call_uses_provider() -> None:
    """LLM action should call provider chat method."""
    llm_provider = AsyncMock()
    llm_provider.chat.return_value = {
        "content": "real llm response",
        "usage": {"total_tokens": 12},
    }

    executor = ActionExecutor(llm_provider=llm_provider)
    action = PlanStep(
        id="step2",
        title="llm",
        tool="llm_call",
        params={"messages": [{"role": "user", "content": "hi"}]},
    )

    result = await executor.execute(action)

    assert result.success is True
    assert result.result == "real llm response"
    assert llm_provider.chat.await_count == 1
