from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
import asyncio

import pytest

from src.memory.service import RuntimeMemoryService


@pytest.mark.asyncio
async def test_runtime_memory_service_budget_and_short_term_snapshot(tmp_path: Path) -> None:
    service = RuntimeMemoryService(client=None, base_dir=str(tmp_path / "memory"), short_term_budget_chars=100)
    await service.append_short_term("sess_1", "[user] hello")
    await service.append_short_term("sess_1", "[assistant] world")

    budget = await service.get_short_term_budget("sess_1")
    snapshot = await service.snapshot_short_term("sess_1")

    assert budget.budget_chars == 100
    assert budget.used_chars > 0
    assert snapshot["budget"]["budget_chars"] == 100
    assert "world" in snapshot["content"]


@pytest.mark.asyncio
async def test_runtime_memory_service_search_long_term_results_passes_agent_and_session(tmp_path: Path) -> None:
    client = AsyncMock()
    client.request.return_value = {
        "results": [
            {"content": "用户偏好中文回复", "score": 0.91, "metadata": {"memory_type": "semantic"}}
        ]
    }
    service = RuntimeMemoryService(client=client, base_dir=str(tmp_path / "memory"))

    rows = await service.search_long_term_results(
        agent_id="agent_1",
        query="中文偏好",
        limit=3,
        org_id="org_1",
        session_id="sess_1",
        memory_type="semantic",
    )

    assert rows[0]["content"] == "用户偏好中文回复"
    client.request.assert_awaited_once()
    _, kwargs = client.request.await_args
    assert kwargs["agent_id"] == "agent_1"
    assert kwargs["target_session_id"] == "sess_1"
    assert kwargs["memory_type"] == "semantic"


@pytest.mark.asyncio
async def test_runtime_memory_service_compact_short_term_without_llm_falls_back(tmp_path: Path) -> None:
    event_emitter = AsyncMock()
    service = RuntimeMemoryService(client=None, base_dir=str(tmp_path / "memory"), short_term_budget_chars=80)
    long_text = "[user] " + ("A" * 120) + "\n\n[assistant] " + ("B" * 120)
    service.event_emitter = event_emitter
    await service.replace_short_term("sess_1", long_text)

    result = await service.compact_short_term(session_id="sess_1", target_chars=100)
    compacted = await service.read_short_term("sess_1")

    assert result["compacted"] is True
    assert result["used_chars_after"] <= 100
    assert compacted.endswith("B" * min(100, 120))
    event_emitter.emit_memory_short_term_compacted.assert_awaited_once()


@pytest.mark.asyncio
async def test_runtime_memory_service_compaction_fallback_preserves_recent_tail(tmp_path: Path) -> None:
    service = RuntimeMemoryService(client=None, base_dir=str(tmp_path / "memory"), short_term_budget_chars=80)
    tail = "[assistant] recent-facts-" + ("Z" * 60)
    long_text = ("[user] " + ("A" * 180) + "\n\n" + tail)
    await service.replace_short_term("sess_1", long_text)

    result = await service.compact_short_term(session_id="sess_1", target_chars=len(tail) + 10)

    assert result["compacted"] is True
    assert tail.endswith(result["content"][-len(tail):])


@pytest.mark.asyncio
async def test_runtime_memory_service_maybe_auto_consolidate_writes_long_term_candidate(tmp_path: Path) -> None:
    llm_provider = AsyncMock()
    llm_provider.chat.return_value = SimpleNamespace(
        content='{"candidates":[{"should_write":true,"content":"用户偏好中文回复","memory_type":"semantic","importance":0.8,"metadata":{"topic":"language"}},{"should_write":true,"content":"项目约定使用中文产出","memory_type":"procedural","importance":0.7,"metadata":{"topic":"workflow"}}]}'
    )
    client = AsyncMock()
    event_emitter = AsyncMock()
    service = RuntimeMemoryService(
        client=client,
        base_dir=str(tmp_path / "memory"),
        llm_provider=llm_provider,
        short_term_budget_chars=100,
        event_emitter=event_emitter,
    )
    await service.replace_short_term("sess_1", "[user] " + ("x" * 180))

    result = await service.maybe_auto_consolidate(
        session_id="sess_1",
        agent_id="agent_1",
        org_id="org_1",
        latest_user_message="请以后用中文回复",
        latest_assistant_message="好的",
    )

    assert result["consolidated"] is True
    assert result["long_term_written"] == 2
    assert client.fire_and_forget.await_count == 2
    assert event_emitter.emit_memory_long_term_written.await_count == 2


@pytest.mark.asyncio
async def test_runtime_memory_service_formats_budget_prompt(tmp_path: Path) -> None:
    service = RuntimeMemoryService(client=None, base_dir=str(tmp_path / "memory"), short_term_budget_chars=50)
    await service.replace_short_term("sess_1", "[user] hello world")

    text = await service.format_short_term_budget_prompt("sess_1")

    assert text.startswith("Current short-term memory budget:")
    assert "used_chars=" in text
    assert "budget_chars=50" in text
    assert "remaining_percent=" in text


@pytest.mark.asyncio
async def test_runtime_memory_service_rejects_cross_session_when_bound(tmp_path: Path) -> None:
    event_emitter = AsyncMock()
    service = RuntimeMemoryService(
        client=None,
        base_dir=str(tmp_path / "memory"),
        short_term_budget_chars=50,
        bound_session_id="sess_bound",
        event_emitter=event_emitter,
    )

    with pytest.raises(ValueError, match="bound to the current session"):
        await service.get_short_term_budget("sess_other")
    await asyncio.sleep(0)
    event_emitter.emit_memory_session_guard_blocked.assert_awaited_once_with(
        requested_session_id="sess_other",
        bound_session_id="sess_bound",
    )


@pytest.mark.asyncio
async def test_runtime_memory_service_rejects_empty_session_when_bound(tmp_path: Path) -> None:
    event_emitter = AsyncMock()
    service = RuntimeMemoryService(
        client=None,
        base_dir=str(tmp_path / "memory"),
        short_term_budget_chars=50,
        bound_session_id="sess_bound",
        event_emitter=event_emitter,
    )

    with pytest.raises(ValueError, match="bound to the current session"):
        await service.get_short_term_budget("")
    await asyncio.sleep(0)
    event_emitter.emit_memory_session_guard_blocked.assert_awaited_once_with(
        requested_session_id="",
        bound_session_id="sess_bound",
    )
