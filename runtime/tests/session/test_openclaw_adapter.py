from __future__ import annotations

import asyncio
import json

import pytest

from src.session.openclaw_adapter import OpenClawBridgeAdapter


class DummyClient:
    def __init__(self) -> None:
        self.sse_events: list[tuple[str, dict]] = []
        self.runtime_events: list[tuple[str, dict]] = []
        self.request_calls: list[tuple[str, str, dict]] = []
        self.request_result: dict = {"results": [{"content": "memo from cp"}]}
        self.fire_and_forget_calls: list[tuple[str, str, dict]] = []

    async def send_sse_event(self, session_id: str, payload: dict) -> None:
        self.sse_events.append((session_id, payload))

    async def send_runtime_event(self, session_id: str, event: dict) -> None:
        self.runtime_events.append((session_id, event))

    async def request(self, session_id: str, method: str, **params):
        self.request_calls.append((session_id, method, params))
        return self.request_result

    async def fire_and_forget(self, session_id: str, method: str, **params):
        self.fire_and_forget_calls.append((session_id, method, params))


class FakeStdin:
    def __init__(self) -> None:
        self.writes: list[str] = []

    def write(self, data: bytes) -> None:
        self.writes.append(data.decode("utf-8"))

    async def drain(self) -> None:
        return


class FakeStdout:
    def __init__(self) -> None:
        self._queue: asyncio.Queue[bytes] = asyncio.Queue()

    async def readline(self) -> bytes:
        return await self._queue.get()

    def push_json(self, payload: dict) -> None:
        self._queue.put_nowait((json.dumps(payload) + "\n").encode("utf-8"))

    def push_eof(self) -> None:
        self._queue.put_nowait(b"")


class FakeProcess:
    def __init__(self) -> None:
        self.stdin = FakeStdin()
        self.stdout = FakeStdout()
        self.stderr = FakeStdout()
        self.returncode: int | None = None

    def terminate(self) -> None:
        self.returncode = 0

    def kill(self) -> None:
        self.returncode = 0

    async def wait(self) -> int:
        self.returncode = 0
        return 0


@pytest.mark.asyncio
async def test_openclaw_adapter_bridge_ipc(monkeypatch):
    fake_proc = FakeProcess()

    async def fake_spawn(*_args, **_kwargs):
        return fake_proc

    monkeypatch.setattr("src.session.openclaw_adapter.asyncio.create_subprocess_exec", fake_spawn)
    monkeypatch.setenv("OPENCLAW_BRIDGE_CMD", "node /tmp/fake-openclaw-bridge.js")

    client = DummyClient()
    adapter = OpenClawBridgeAdapter(client, "sess-oc-1", {"runtime_type": "openclaw"})

    await adapter.start()
    fake_proc.stdout.push_json({"type": "sse_event", "data": {"type": "text", "content": "hello"}})
    await asyncio.sleep(0.05)

    await adapter.handle_user_message({"message": "ping"})
    await adapter.cancel()
    await adapter.stop()

    sent_cmds = [json.loads(chunk.strip()) for chunk in fake_proc.stdin.writes]
    sent_types = [cmd["type"] for cmd in sent_cmds]
    assert "start" in sent_types
    assert "user_message" in sent_types
    assert "cancel" in sent_types
    assert "stop" in sent_types
    start_cmd = next(cmd for cmd in sent_cmds if cmd["type"] == "start")
    assert "runtime_type" in start_cmd["payload"]

    assert any(payload.get("type") == "text" for _, payload in client.sse_events)


@pytest.mark.asyncio
async def test_openclaw_adapter_handles_cp_request(monkeypatch):
    fake_proc = FakeProcess()

    async def fake_spawn(*_args, **_kwargs):
        return fake_proc

    monkeypatch.setattr("src.session.openclaw_adapter.asyncio.create_subprocess_exec", fake_spawn)
    monkeypatch.setenv("OPENCLAW_BRIDGE_CMD", "node /tmp/fake-openclaw-bridge.js")

    client = DummyClient()
    adapter = OpenClawBridgeAdapter(client, "sess-oc-3", {"runtime_type": "openclaw"})

    await adapter.start()
    fake_proc.stdout.push_json(
        {
            "type": "cp_request",
            "id": "req-1",
            "session_id": "sess-oc-3",
            "method": "memory_search",
            "params": {"query": "hello", "top_k": 3},
        }
    )
    await asyncio.sleep(0.1)

    assert client.request_calls == [("sess-oc-3", "memory_search", {"query": "hello", "top_k": 3})]
    assert any('"type": "cp_response"' in chunk and '"id": "req-1"' in chunk for chunk in fake_proc.stdin.writes)

    await adapter.stop()


@pytest.mark.asyncio
async def test_openclaw_adapter_handles_cp_fire_and_forget(monkeypatch):
    fake_proc = FakeProcess()

    async def fake_spawn(*_args, **_kwargs):
        return fake_proc

    monkeypatch.setattr("src.session.openclaw_adapter.asyncio.create_subprocess_exec", fake_spawn)
    monkeypatch.setenv("OPENCLAW_BRIDGE_CMD", "node /tmp/fake-openclaw-bridge.js")

    client = DummyClient()
    adapter = OpenClawBridgeAdapter(client, "sess-oc-4", {"runtime_type": "openclaw"})

    await adapter.start()
    fake_proc.stdout.push_json(
        {
            "type": "cp_fire_and_forget",
            "session_id": "sess-oc-4",
            "method": "usage_report",
            "params": {"model": "gpt-4o", "tokens_in": 10, "tokens_out": 20},
        }
    )
    await asyncio.sleep(0.05)

    assert client.fire_and_forget_calls == [
        ("sess-oc-4", "usage_report", {"model": "gpt-4o", "tokens_in": 10, "tokens_out": 20})
    ]

    await adapter.stop()


@pytest.mark.asyncio
async def test_openclaw_adapter_bridge_exit_reports_error(monkeypatch):
    fake_proc = FakeProcess()

    async def fake_spawn(*_args, **_kwargs):
        return fake_proc

    monkeypatch.setattr("src.session.openclaw_adapter.asyncio.create_subprocess_exec", fake_spawn)
    monkeypatch.setenv("OPENCLAW_BRIDGE_CMD", "node /tmp/fake-openclaw-bridge.js")

    client = DummyClient()
    adapter = OpenClawBridgeAdapter(client, "sess-oc-2", {"runtime_type": "openclaw"})

    await adapter.start()
    fake_proc.stdout.push_eof()
    await asyncio.sleep(0.05)

    assert any(payload.get("code") == "OPENCLAW_BRIDGE_EXITED" for _, payload in client.sse_events)

    await adapter.stop()
