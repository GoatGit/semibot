from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from src.skills.memory import MemoryTool


@pytest.mark.asyncio
async def test_memory_tool_search_long_term_uses_runtime_memory_service() -> None:
    tool = MemoryTool()
    memory_service = AsyncMock()
    memory_service.search_long_term_results.return_value = [{"content": "用户偏好中文", "score": 0.9, "metadata": {}}]
    runtime_context = SimpleNamespace(
        session_id="sess_1",
        agent_id="agent_1",
        metadata={"memory_service": memory_service, "org_id": "org_1"},
    )

    result = await tool.execute(
        operation="search_long_term",
        query="中文",
        limit=3,
        _runtime_context=runtime_context,
    )

    assert result.success is True
    assert result.result["results"][0]["content"] == "用户偏好中文"
    memory_service.search_long_term_results.assert_awaited_once()


@pytest.mark.asyncio
async def test_memory_tool_budget_and_compaction_delegate_to_service() -> None:
    tool = MemoryTool()
    memory_service = AsyncMock()
    memory_service.get_short_term_budget.return_value = SimpleNamespace(
        to_dict=lambda: {
            "used_chars": 100,
            "budget_chars": 200,
            "remaining_chars": 100,
            "remaining_ratio": 0.5,
            "remaining_percent": 50,
        }
    )
    memory_service.compact_short_term.return_value = {
        "content": "[memory_summary] ...",
        "compacted": True,
        "used_chars_before": 1000,
        "used_chars_after": 300,
    }
    runtime_context = SimpleNamespace(
        session_id="sess_1",
        agent_id="agent_1",
        metadata={"memory_service": memory_service, "org_id": "org_1"},
    )

    budget = await tool.execute(operation="get_short_term_budget", _runtime_context=runtime_context)
    compact = await tool.execute(operation="compact_short_term", target_chars=300, _runtime_context=runtime_context)

    assert budget.success is True
    assert budget.result["remaining_percent"] == 50
    assert compact.success is True
    assert compact.result["compacted"] is True


@pytest.mark.asyncio
async def test_memory_tool_snapshot_uses_current_session_only() -> None:
    tool = MemoryTool()
    memory_service = AsyncMock()
    memory_service.snapshot_short_term.return_value = {
        "content": "[memory_summary] hi",
        "budget": {
            "used_chars": 20,
            "budget_chars": 100,
            "remaining_chars": 80,
            "remaining_ratio": 0.8,
            "remaining_percent": 80,
        },
    }
    runtime_context = SimpleNamespace(
        session_id="sess_runtime",
        agent_id="agent_1",
        metadata={"memory_service": memory_service, "org_id": "org_1"},
    )

    result = await tool.execute(
        operation="get_short_term_snapshot",
        _runtime_context=runtime_context,
    )

    assert result.success is True
    assert result.result["content"] == "[memory_summary] hi"
    memory_service.snapshot_short_term.assert_awaited_once_with("sess_runtime")


@pytest.mark.asyncio
async def test_memory_tool_uses_current_session_for_writes() -> None:
    tool = MemoryTool()
    memory_service = AsyncMock()
    runtime_context = SimpleNamespace(
        session_id="sess_runtime",
        agent_id="agent_1",
        metadata={"memory_service": memory_service, "org_id": "org_1"},
    )

    result = await tool.execute(
        operation="save_long_term",
        content="用户偏好中文回复",
        _runtime_context=runtime_context,
    )

    assert result.success is True
    memory_service.save_long_term.assert_awaited_once()
    assert memory_service.save_long_term.await_args.kwargs["session_id"] == "sess_runtime"
