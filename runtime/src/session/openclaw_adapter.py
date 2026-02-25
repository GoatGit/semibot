from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shlex
from pathlib import Path
from typing import Any
from uuid import uuid4

from src.session.runtime_adapter import RuntimeAdapter
from src.utils.logging import get_logger
from src.ws.client import ControlPlaneClient

logger = get_logger(__name__)


class OpenClawBridgeAdapter(RuntimeAdapter):
    def __init__(self, client: ControlPlaneClient, session_id: str, start_payload: dict[str, Any]) -> None:
        self.client = client
        self.session_id = session_id
        self.start_payload = start_payload
        self.process: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[Any] | None = None
        self._stderr_task: asyncio.Task[Any] | None = None
        self._stopping = False
        self._snapshot_futures: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._io_lock = asyncio.Lock()

    async def start(self) -> None:
        await self._spawn_bridge()
        await self._send_command(
            {
                "type": "start",
                "session_id": self.session_id,
                "payload": self._start_payload_for_bridge(),
            }
        )

    async def handle_user_message(self, payload: dict[str, Any]) -> None:
        await self._send_command(
            {
                "type": "user_message",
                "session_id": self.session_id,
                "payload": payload,
            }
        )

    async def cancel(self) -> None:
        await self._send_command(
            {
                "type": "cancel",
                "session_id": self.session_id,
            }
        )

    async def stop(self) -> None:
        self._stopping = True
        await self._send_command(
            {
                "type": "stop",
                "session_id": self.session_id,
            }
        )

        if self._reader_task:
            self._reader_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._reader_task
        if self._stderr_task:
            self._stderr_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._stderr_task

        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), timeout=2)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()
        self.process = None
        for fut in self._snapshot_futures.values():
            if not fut.done():
                fut.set_exception(RuntimeError("bridge stopped"))
        self._snapshot_futures.clear()
        self._reader_task = None
        self._stderr_task = None

    def _bridge_command(self) -> list[str]:
        override = os.getenv("OPENCLAW_BRIDGE_CMD", "").strip()
        if override:
            return shlex.split(override)

        runtime_root = Path(__file__).resolve().parents[2]
        bridge_entry = runtime_root / "openclaw-bridge" / "dist" / "main.js"
        return ["node", str(bridge_entry)]

    async def _send_command(self, payload: dict[str, Any]) -> None:
        async with self._io_lock:
            recovered = await self._ensure_bridge_for_command(payload)
            if not self.process or not self.process.stdin:
                await self.client.send_sse_event(
                    self.session_id,
                    {
                        "type": "execution_error",
                        "code": "OPENCLAW_BRIDGE_NOT_RUNNING",
                        "error": "OpenClaw bridge process is not running",
                    },
                )
                return

            if recovered and payload.get("type") != "start":
                await self._write_command(
                    {
                        "type": "start",
                        "session_id": self.session_id,
                        "payload": self._start_payload_for_bridge(),
                    }
                )

            await self._write_command(payload)

    async def _write_command(self, payload: dict[str, Any]) -> None:
        if not self.process or not self.process.stdin:
            return
        data = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        self.process.stdin.write(data)
        await self.process.stdin.drain()

    async def _spawn_bridge(self) -> None:
        if self.process and self.process.returncode is None and self.process.stdin and self.process.stdout:
            return

        cmd = self._bridge_command()
        self.process = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._reader_task = asyncio.create_task(self._read_bridge_events())
        self._stderr_task = asyncio.create_task(self._read_bridge_stderr())

    async def _ensure_bridge_for_command(self, payload: dict[str, Any]) -> bool:
        if self._stopping:
            return False

        is_running = bool(self.process and self.process.returncode is None and self.process.stdin and self.process.stdout)
        if is_running:
            return False

        try:
            await self._spawn_bridge()
            return True
        except Exception as exc:
            await self.client.send_sse_event(
                self.session_id,
                {
                    "type": "execution_error",
                    "code": "OPENCLAW_BRIDGE_START_FAILED",
                    "error": str(exc),
                    "command_type": str(payload.get("type", "")),
                },
            )
            return False

    async def _read_bridge_events(self) -> None:
        if not self.process or not self.process.stdout:
            return
        try:
            while True:
                line = await self.process.stdout.readline()
                if not line:
                    break
                raw = line.decode("utf-8").strip()
                if not raw:
                    continue
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                try:
                    await self._dispatch_bridge_message(msg)
                except Exception as exc:
                    logger.warning(
                        "openclaw_bridge_dispatch_failed",
                        extra={"session_id": self.session_id, "error": str(exc)},
                    )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self.client.send_sse_event(
                self.session_id,
                {
                    "type": "execution_error",
                    "code": "OPENCLAW_BRIDGE_READ_ERROR",
                    "error": str(exc),
                },
            )
        finally:
            if not self._stopping:
                await self.client.send_sse_event(
                    self.session_id,
                    {
                        "type": "execution_error",
                        "code": "OPENCLAW_BRIDGE_EXITED",
                        "error": "OpenClaw bridge exited unexpectedly",
                    },
                )

    async def _read_bridge_stderr(self) -> None:
        if not self.process or not self.process.stderr:
            return
        try:
            while True:
                line = await self.process.stderr.readline()
                if not line:
                    break
                raw = line.decode("utf-8", errors="replace").strip()
                if not raw:
                    continue
                logger.warning("openclaw_bridge_stderr", extra={"session_id": self.session_id, "line": raw})
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("openclaw_bridge_stderr_reader_error", extra={"session_id": self.session_id, "error": str(exc)})

    async def _dispatch_bridge_message(self, msg: dict[str, Any]) -> None:
        msg_type = str(msg.get("type", ""))
        if msg_type == "snapshot_response":
            request_id = str(msg.get("id", ""))
            fut = self._snapshot_futures.pop(request_id, None)
            if fut and not fut.done():
                snapshot = msg.get("snapshot")
                fut.set_result(snapshot if isinstance(snapshot, dict) else {})
            return
        if msg_type == "cp_request":
            asyncio.create_task(self._handle_control_plane_request(msg))
            return
        if msg_type == "cp_fire_and_forget":
            asyncio.create_task(self._handle_control_plane_fire_and_forget(msg))
            return

        if msg_type == "sse_event":
            payload = msg.get("data")
            if isinstance(payload, dict):
                await self.client.send_sse_event(self.session_id, payload)
            return

        if msg_type == "runtime_event":
            event = msg.get("event")
            if isinstance(event, dict):
                await self.client.send_runtime_event(self.session_id, event)
            return

        if msg_type in {
            "thinking",
            "text",
            "tool_call",
            "tool_result",
            "file_created",
            "execution_complete",
            "execution_error",
        }:
            await self.client.send_sse_event(self.session_id, msg)

    def _start_payload_for_bridge(self) -> dict[str, Any]:
        allowed_keys = {
            "runtime_type",
            "agent_id",
            "agent_config",
            "openclaw_config",
            "mcp_servers",
            "skill_index",
            "sub_agents",
            "session_config",
        }
        payload: dict[str, Any] = {}
        for key in allowed_keys:
            value = self.start_payload.get(key)
            if value is not None:
                payload[key] = value
        return payload

    async def _handle_control_plane_request(self, msg: dict[str, Any]) -> None:
        request_id = str(msg.get("id", ""))
        method = str(msg.get("method", ""))
        params = msg.get("params")
        session_id = str(msg.get("session_id") or self.session_id)
        if not request_id or not method:
            return

        try:
            result = await self.client.request(
                session_id,
                method,
                **(params if isinstance(params, dict) else {}),
            )
            await self._send_command(
                {
                    "type": "cp_response",
                    "id": request_id,
                    "result": result,
                    "error": None,
                }
            )
        except Exception as exc:
            await self._send_command(
                {
                    "type": "cp_response",
                    "id": request_id,
                    "result": None,
                    "error": {"code": "CP_REQUEST_FAILED", "message": str(exc)},
                }
            )

    async def _handle_control_plane_fire_and_forget(self, msg: dict[str, Any]) -> None:
        method = str(msg.get("method", ""))
        params = msg.get("params")
        session_id = str(msg.get("session_id") or self.session_id)
        if not method:
            return
        try:
            await self.client.fire_and_forget(
                session_id,
                method,
                **(params if isinstance(params, dict) else {}),
            )
        except Exception as exc:
            await self.client.send_sse_event(
                self.session_id,
                {
                    "type": "execution_error",
                    "code": "CP_FIRE_AND_FORGET_FAILED",
                    "error": str(exc),
                },
            )

    async def update_config(self, payload: dict[str, Any]) -> None:
        if not isinstance(payload, dict):
            return
        self.start_payload = {**self.start_payload, **payload}
        await self._send_command(
            {
                "type": "config_update",
                "session_id": self.session_id,
                "payload": payload,
            }
        )

    async def get_snapshot(self) -> dict[str, Any] | None:
        if not self.process:
            return None
        loop = asyncio.get_event_loop()
        request_id = str(uuid4())
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._snapshot_futures[request_id] = fut
        try:
            await self._send_command(
                {
                    "type": "snapshot",
                    "id": request_id,
                    "session_id": self.session_id,
                }
            )
            return await asyncio.wait_for(fut, timeout=3)
        except Exception:
            self._snapshot_futures.pop(request_id, None)
            return None
