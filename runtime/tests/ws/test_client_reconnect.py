from __future__ import annotations

import asyncio
import json

import pytest

from src.ws.client import ControlPlaneClient


class FakeWS:
    def __init__(self, recv_messages: list[dict]):
        self._recv = asyncio.Queue()
        for msg in recv_messages:
            self._recv.put_nowait(json.dumps(msg))
        self.sent: list[dict] = []

    async def send(self, payload: str) -> None:
        self.sent.append(json.loads(payload))

    async def recv(self) -> str:
        return await self._recv.get()


@pytest.mark.asyncio
async def test_reconnect_restores_completed_pending_request(monkeypatch):
    ws = FakeWS(
        [
            {"type": "init", "data": {}},
            {"type": "resume_response", "results": {"req-1": {"status": "completed", "data": {"ok": 1}}}},
        ]
    )

    async def fake_connect(_url: str):
        return ws

    monkeypatch.setattr("src.ws.client.websockets.connect", fake_connect)

    client = ControlPlaneClient("ws://localhost/ws/vm", "u1", "t1", "jwt")
    fut = asyncio.get_running_loop().create_future()
    client.pending_requests["req-1"] = fut

    await client._reconnect()

    assert fut.done()
    assert fut.result() == {"ok": 1}
    assert ws.sent[0]["type"] == "auth"
    assert ws.sent[1] == {"type": "resume", "pending_ids": ["req-1"]}

    if client._listen_task:
        client._listen_task.cancel()
    if client._heartbeat_task:
        client._heartbeat_task.cancel()


@pytest.mark.asyncio
async def test_reconnect_marks_lost_pending_request(monkeypatch):
    ws = FakeWS(
        [
            {"type": "init", "data": {}},
            {"type": "resume_response", "results": {"req-2": {"status": "lost"}}},
        ]
    )

    async def fake_connect(_url: str):
        return ws

    monkeypatch.setattr("src.ws.client.websockets.connect", fake_connect)

    client = ControlPlaneClient("ws://localhost/ws/vm", "u1", "t1", "jwt")
    fut = asyncio.get_running_loop().create_future()
    client.pending_requests["req-2"] = fut

    await client._reconnect()

    assert fut.done()
    with pytest.raises(RuntimeError):
        fut.result()

    if client._listen_task:
        client._listen_task.cancel()
    if client._heartbeat_task:
        client._heartbeat_task.cancel()
