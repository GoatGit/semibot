"""EventEmitter — async queue-based bridge between graph nodes and SSE stream.

Nodes call ``await emitter.emit(...)`` to push events into an asyncio.Queue.
The SSE endpoint consumes the queue via ``async for event in emitter``.
A ``None`` sentinel signals the end of the stream.
"""

import asyncio
from datetime import datetime, timezone
from typing import Any

from src.utils.logging import get_logger

logger = get_logger(__name__)


class EventEmitter:
    """Thread-safe async event emitter backed by asyncio.Queue."""

    def __init__(self, maxsize: int = 0) -> None:
        self._queue: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=maxsize)
        self._closed = False

    # ------------------------------------------------------------------
    # Core emit / close
    # ------------------------------------------------------------------

    async def emit(self, event_type: str, data: dict[str, Any]) -> None:
        """Push an event into the queue."""
        if self._closed:
            logger.warning("EventEmitter already closed, dropping event", extra={"event": event_type})
            return
        payload = {
            "event": event_type,
            "data": data,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        await self._queue.put(payload)

    async def close(self) -> None:
        """Signal end-of-stream by pushing the sentinel."""
        if not self._closed:
            self._closed = True
            await self._queue.put(None)

    # ------------------------------------------------------------------
    # Async iterator protocol
    # ------------------------------------------------------------------

    def __aiter__(self):
        return self

    async def __anext__(self) -> dict:
        item = await self._queue.get()
        if item is None:
            raise StopAsyncIteration
        return item

    # ------------------------------------------------------------------
    # Convenience helpers — one per event type
    # ------------------------------------------------------------------

    async def emit_thinking(self, content: str, stage: str) -> None:
        await self.emit("thinking", {"content": content, "stage": stage})

    async def emit_plan_created(self, steps: list[dict[str, Any]]) -> None:
        await self.emit("plan_created", {"steps": steps})

    async def emit_plan_step_start(
        self, step_id: str, title: str, tool: str | None = None, params: dict | None = None
    ) -> None:
        await self.emit("plan_step_start", {
            "step_id": step_id,
            "title": title,
            "tool": tool,
            "params": params or {},
        })

    async def emit_plan_step_complete(
        self, step_id: str, title: str, result: Any = None, duration_ms: int = 0
    ) -> None:
        await self.emit("plan_step_complete", {
            "step_id": step_id,
            "title": title,
            "result": result,
            "duration_ms": duration_ms,
        })

    async def emit_plan_step_failed(self, step_id: str, title: str, error: str) -> None:
        await self.emit("plan_step_failed", {
            "step_id": step_id,
            "title": title,
            "error": error,
        })

    async def emit_tool_call_start(self, tool_name: str, arguments: dict | None = None) -> None:
        await self.emit("tool_call_start", {
            "tool_name": tool_name,
            "arguments": arguments or {},
        })

    async def emit_tool_call_complete(
        self,
        tool_name: str,
        result: Any = None,
        success: bool = True,
        *,
        error: str | None = None,
        duration: int = 0,
    ) -> None:
        await self.emit("tool_call_complete", {
            "tool_name": tool_name,
            "result": result,
            "success": success,
            "error": error,
            "duration": duration,
        })

    async def emit_skill_call_start(
        self, skill_id: str, skill_name: str, arguments: dict | None = None
    ) -> None:
        await self.emit("skill_call_start", {
            "skill_id": skill_id,
            "skill_name": skill_name,
            "arguments": arguments or {},
        })

    async def emit_skill_call_complete(
        self,
        skill_id: str,
        skill_name: str,
        result: Any = None,
        success: bool = True,
        *,
        error: str | None = None,
        duration: int = 0,
    ) -> None:
        await self.emit("skill_call_complete", {
            "skill_id": skill_id,
            "skill_name": skill_name,
            "result": result,
            "success": success,
            "error": error,
            "duration": duration,
        })

    async def emit_mcp_call_start(
        self, server_id: str, tool_name: str, arguments: dict | None = None
    ) -> None:
        await self.emit("mcp_call_start", {
            "server_id": server_id,
            "tool_name": tool_name,
            "arguments": arguments or {},
        })

    async def emit_mcp_call_complete(
        self,
        server_id: str,
        tool_name: str,
        result: Any = None,
        success: bool = True,
        *,
        error: str | None = None,
        duration: int = 0,
    ) -> None:
        await self.emit("mcp_call_complete", {
            "server_id": server_id,
            "tool_name": tool_name,
            "result": result,
            "success": success,
            "error": error,
            "duration": duration,
        })

    async def emit_text_chunk(self, content: str) -> None:
        await self.emit("text_chunk", {"content": content})

    async def emit_execution_complete(self, final_response: str) -> None:
        await self.emit("execution_complete", {"final_response": final_response})

    async def emit_execution_error(
        self,
        error: str,
        *,
        code: str | None = None,
        http_status: int | None = None,
        details: dict | list | None = None,
        trace_id: str | None = None,
    ) -> None:
        data: dict[str, Any] = {"error": error}
        if code is not None:
            data["code"] = code
        if http_status is not None:
            data["httpStatus"] = http_status
        if details is not None:
            data["details"] = details
        if trace_id is not None:
            data["traceId"] = trace_id
        await self.emit("execution_error", data)

    async def emit_file_created(
        self,
        file_id: str,
        filename: str,
        mime_type: str,
        size: int,
        url: str,
    ) -> None:
        """Emit a file_created event for generated files."""
        await self.emit("file_created", {
            "file_id": file_id,
            "filename": filename,
            "mime_type": mime_type,
            "size": size,
            "url": url,
        })

    async def emit_ping(self) -> None:
        """Send a keepalive ping event to prevent stall timeouts."""
        await self.emit("ping", {})
