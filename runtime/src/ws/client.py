from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import uuid4

import websockets

from src.utils.logging import get_logger

logger = get_logger(__name__)

SessionHandler = Callable[[dict[str, Any]], Awaitable[None]]
VMHandler = Callable[[dict[str, Any]], Awaitable[None]]


class ControlPlaneClient:
    def __init__(
        self,
        control_plane_url: str,
        user_id: str,
        ticket: str,
        token: str,
    ) -> None:
        self.base_url = control_plane_url
        self.user_id = user_id
        self.connect_url = f"{control_plane_url}?user_id={user_id}&ticket={ticket}"
        self.reconnect_url = f"{control_plane_url}?user_id={user_id}"
        self.token = token

        self.ws: websockets.WebSocketClientProtocol | None = None
        self.pending_requests: dict[str, asyncio.Future[Any]] = {}
        self.session_handlers: dict[str, dict[str, SessionHandler]] = {}
        self.pending_session_messages: dict[str, list[dict[str, Any]]] = {}
        self.vm_handlers: dict[str, VMHandler] = {}
        self.active_sessions_provider: Callable[[], list[str]] | None = None
        self._listen_task: asyncio.Task[Any] | None = None
        self._heartbeat_task: asyncio.Task[Any] | None = None
        self._resume_future: asyncio.Future[dict[str, Any]] | None = None
        self._reconnect_delays = [1, 2, 4, 8, 16, 30, 30]

    async def connect(self) -> dict[str, Any]:
        self.ws = await websockets.connect(self.connect_url)
        await self._send_raw({"type": "auth", "token": self.token})
        init_msg = json.loads(await self.ws.recv())
        if init_msg.get("type") != "init":
            raise RuntimeError("Expected init message")

        self._listen_task = asyncio.create_task(self._listen_loop())
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        logger.info("connected_to_control_plane", extra={"user_id": self.user_id})
        return init_msg.get("data", {})

    async def close(self) -> None:
        if self._listen_task:
            self._listen_task.cancel()
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
        if self.ws:
            await self.ws.close()

    def register_vm_handlers(
        self,
        start_session: VMHandler,
        stop_session: VMHandler,
        config_update: VMHandler | None = None,
    ) -> None:
        self.vm_handlers["start_session"] = start_session
        self.vm_handlers["stop_session"] = stop_session
        if config_update:
            self.vm_handlers["config_update"] = config_update

    def register_session_handlers(self, session_id: str, user_message: SessionHandler, cancel: SessionHandler) -> None:
        self.session_handlers[session_id] = {
            "user_message": user_message,
            "cancel": cancel,
        }
        pending = self.pending_session_messages.pop(session_id, [])
        for payload in pending:
            asyncio.create_task(user_message(payload))

    def unregister_session_handlers(self, session_id: str) -> None:
        self.session_handlers.pop(session_id, None)
        self.pending_session_messages.pop(session_id, None)

    def set_active_sessions_provider(self, provider: Callable[[], list[str]]) -> None:
        self.active_sessions_provider = provider

    async def request(self, session_id: str, method: str, **params: Any) -> Any:
        msg_id = str(uuid4())
        loop = asyncio.get_event_loop()
        future = loop.create_future()
        self.pending_requests[msg_id] = future

        await self._send_raw(
            {
                "type": "request",
                "id": msg_id,
                "session_id": session_id,
                "method": method,
                "params": params,
            }
        )

        try:
            return await asyncio.wait_for(future, timeout=60)
        except asyncio.TimeoutError:
            self.pending_requests.pop(msg_id, None)
            raise

    async def send_sse_event(self, session_id: str, payload: dict[str, Any]) -> None:
        await self._send_raw(
            {
                "type": "sse_event",
                "session_id": session_id,
                "data": json.dumps(payload, ensure_ascii=False),
            }
        )

    async def send_runtime_event(self, session_id: str, event: dict[str, Any]) -> None:
        event_type = event.get("event")
        data = event.get("data") or {}
        flattened = {"type": event_type, **data}
        await self.send_sse_event(session_id, flattened)

    async def fire_and_forget(self, session_id: str, method: str, **params: Any) -> None:
        await self._send_raw(
            {
                "type": "fire_and_forget",
                "session_id": session_id,
                "method": method,
                "params": params,
            }
        )

    async def _send_raw(self, payload: dict[str, Any]) -> None:
        if not self.ws:
            raise RuntimeError("WS not connected")
        await self.ws.send(json.dumps(payload, ensure_ascii=False))

    async def _listen_loop(self) -> None:
        while self.ws:
            try:
                raw = await self.ws.recv()
            except websockets.ConnectionClosed:
                await self._reconnect()
                return

            msg = json.loads(raw)
            msg_type = msg.get("type")

            if msg_type == "response":
                request_id = msg.get("id")
                future = self.pending_requests.pop(request_id, None)
                if future and not future.done():
                    error = msg.get("error")
                    if error:
                        future.set_exception(RuntimeError(str(error)))
                    else:
                        future.set_result(msg.get("result"))
                continue

            if msg_type == "resume_response":
                if self._resume_future and not self._resume_future.done():
                    results = msg.get("results")
                    self._resume_future.set_result(results if isinstance(results, dict) else {})
                continue

            if msg_type in ("start_session", "stop_session", "config_update"):
                handler = self.vm_handlers.get(msg_type)
                if handler:
                    asyncio.create_task(handler(msg.get("data", {})))
                continue

            session_id = msg.get("session_id")
            if not session_id:
                continue

            if msg_type == "user_message":
                handler = self.session_handlers.get(session_id, {}).get("user_message")
                if handler:
                    asyncio.create_task(handler(msg.get("data", {})))
                else:
                    queued = self.pending_session_messages.setdefault(session_id, [])
                    queued.append(msg.get("data", {}))
                    if len(queued) > 20:
                        del queued[:-20]
                continue

            if msg_type == "cancel":
                handler = self.session_handlers.get(session_id, {}).get("cancel")
                if handler:
                    asyncio.create_task(handler(msg.get("data", {})))

    async def _heartbeat_loop(self) -> None:
        while True:
            await asyncio.sleep(10)
            sessions = self.active_sessions_provider() if self.active_sessions_provider else []
            try:
                await self._send_raw({"type": "heartbeat", "active_sessions": sessions})
            except Exception as exc:
                logger.warning("heartbeat_send_failed", extra={"error": str(exc), "user_id": self.user_id})
                if self.ws:
                    try:
                        await self.ws.close()
                    except Exception:
                        pass
                return

    async def _reconnect(self) -> None:
        logger.warning("control_plane_disconnected", extra={"user_id": self.user_id})

        for delay in self._reconnect_delays:
            try:
                await asyncio.sleep(delay)
                self.ws = await websockets.connect(self.reconnect_url)
                await self._send_raw({"type": "auth", "token": self.token})
                init_msg = json.loads(await self.ws.recv())
                if init_msg.get("type") != "init":
                    raise RuntimeError("init not received on reconnect")

                self._listen_task = asyncio.create_task(self._listen_loop())
                pending_ids = list(self.pending_requests.keys())
                loop = asyncio.get_event_loop()
                self._resume_future = loop.create_future()
                await self._send_raw({"type": "resume", "pending_ids": pending_ids})
                results = await asyncio.wait_for(self._resume_future, timeout=10)
                for msg_id, result in results.items():
                    future = self.pending_requests.pop(msg_id, None)
                    if not future or future.done():
                        continue
                    if result.get("status") == "completed":
                        future.set_result(result.get("data"))
                    elif result.get("status") == "failed":
                        future.set_exception(RuntimeError(str(result.get("error"))))
                    else:
                        future.set_exception(RuntimeError("Request lost during reconnect"))

                self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
                logger.info("control_plane_reconnected", extra={"user_id": self.user_id})
                return
            except Exception as exc:
                logger.warning("reconnect_attempt_failed", extra={"error": str(exc), "delay": delay})
            finally:
                self._resume_future = None

        for future in self.pending_requests.values():
            if not future.done():
                future.set_exception(ConnectionError("control plane unreachable"))
        self.pending_requests.clear()
