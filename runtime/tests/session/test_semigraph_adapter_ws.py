from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path

import pytest

from src.session.semigraph_adapter import SemiGraphAdapter


class DummyClient:
    def __init__(self) -> None:
        self.sse_events: list[tuple[str, dict]] = []
        self.runtime_events: list[tuple[str, dict]] = []
        self.fire_and_forget_calls: list[tuple[str, str, dict]] = []

    async def send_sse_event(self, session_id: str, payload: dict) -> None:
        self.sse_events.append((session_id, payload))

    async def send_runtime_event(self, session_id: str, event: dict) -> None:
        self.runtime_events.append((session_id, event))

    async def request(self, session_id: str, method: str, **params):
        assert method == "memory_search"
        return {"results": [{"content": "memo"}]}

    async def fire_and_forget(self, session_id: str, method: str, **params):
        self.fire_and_forget_calls.append((session_id, method, params))


class DummyGraph:
    async def ainvoke(self, _state):
        return {
            "messages": [
                {"role": "assistant", "content": "done"}
            ]
        }


@pytest.mark.asyncio
async def test_semigraph_adapter_emits_completion(monkeypatch):
    import src.session.semigraph_adapter as mod

    monkeypatch.setattr(mod, "create_agent_graph", lambda context, runtime_context: DummyGraph())

    client = DummyClient()
    memory_dir = "/tmp/semibot-test-memory"
    adapter = SemiGraphAdapter(
        client=client,
        session_id="sess-1",
        org_id="org-1",
        user_id="user-1",
        init_data={"api_keys": {}, "memory_dir": memory_dir},
        start_payload={
            "agent_id": "agent-1",
            "agent_config": {"model": "gpt-4o"},
            "mcp_servers": [],
        },
    )

    await adapter.start()
    await adapter.handle_user_message({"message": "hello", "history": []})
    assert adapter._task is not None
    await asyncio.wait_for(adapter._task, timeout=3)

    assert any(payload.get("type") == "execution_complete" for _, payload in client.sse_events)
    assert any(method == "snapshot_sync" for _, method, _ in client.fire_and_forget_calls)

    cp_dir = Path(memory_dir) / "sess-1" / "checkpoints"
    files = list(cp_dir.glob("*.json"))
    assert len(files) >= 1


@pytest.mark.asyncio
async def test_semigraph_adapter_cancel(monkeypatch):
    import src.session.semigraph_adapter as mod

    class SlowGraph:
        async def ainvoke(self, _state):
            await asyncio.sleep(1)
            return {"messages": [{"role": "assistant", "content": "slow"}]}

    monkeypatch.setattr(mod, "create_agent_graph", lambda context, runtime_context: SlowGraph())

    client = DummyClient()
    adapter = SemiGraphAdapter(
        client=client,
        session_id="sess-2",
        org_id="org-1",
        user_id="user-1",
        init_data={"api_keys": {}, "memory_dir": "/tmp/semibot-test-memory"},
        start_payload={"agent_id": "agent-1", "agent_config": {}, "mcp_servers": []},
    )

    await adapter.handle_user_message({"message": "hello"})
    await adapter.cancel()

    if adapter._task is not None:
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(adapter._task, timeout=3)

    assert any(payload.get("type") == "execution_complete" and payload.get("cancelled") is True for _, payload in client.sse_events)
    assert any(method == "snapshot_sync" for _, method, _ in client.fire_and_forget_calls)


@pytest.mark.asyncio
async def test_semigraph_adapter_restores_history_from_checkpoint(monkeypatch):
    import src.session.semigraph_adapter as mod

    monkeypatch.setattr(mod, "create_agent_graph", lambda context, runtime_context: DummyGraph())
    captured_histories: list[object] = []

    def fake_create_initial_state(*, history_messages=None, **kwargs):
        del kwargs
        captured_histories.append(history_messages)
        return {}

    monkeypatch.setattr(mod, "create_initial_state", fake_create_initial_state)

    client = DummyClient()
    adapter = SemiGraphAdapter(
        client=client,
        session_id="sess-restore",
        org_id="org-1",
        user_id="user-1",
        init_data={"api_keys": {}, "memory_dir": "/tmp/semibot-test-memory"},
        start_payload={"agent_id": "agent-1", "agent_config": {}, "mcp_servers": []},
    )

    await adapter.handle_user_message({"message": "hello", "history": [{"role": "user", "content": "h1"}]})
    assert adapter._task is not None
    await asyncio.wait_for(adapter._task, timeout=3)

    await adapter.handle_user_message({"message": "next"})
    assert adapter._task is not None
    await asyncio.wait_for(adapter._task, timeout=3)

    assert captured_histories[0] == [{"role": "user", "content": "h1"}]
    assert captured_histories[1] == [{"role": "assistant", "content": "done"}]
