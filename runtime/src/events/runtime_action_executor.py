"""Runtime bridge action executor for event-router actions."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

import httpx

from src.events.orchestrator_bridge import OrchestratorBridge

RuntimeEventSink = Callable[[dict[str, Any]], Awaitable[None]]
RunAgentHook = Callable[[dict[str, Any]], Awaitable[None]]


class RuntimeActionExecutor:
    """
    Bridge EventRouter actions to runtime-level callbacks.

    This implementation is intentionally thin:
    - `notify` emits runtime events.
    - `run_agent` delegates to a hook if provided, otherwise emits an intent event.
    - `call_webhook` performs direct HTTP POST for local automation use-cases.
    """

    def __init__(
        self,
        *,
        runtime_event_sink: RuntimeEventSink | None = None,
        run_agent_hook: RunAgentHook | None = None,
        orchestrator_bridge: OrchestratorBridge | None = None,
    ):
        self.runtime_event_sink = runtime_event_sink
        self.run_agent_hook = run_agent_hook
        self.orchestrator_bridge = orchestrator_bridge

    async def _emit(self, event: str, payload: dict[str, Any]) -> None:
        if self.runtime_event_sink:
            await self.runtime_event_sink({"event": event, "data": payload})

    async def notify(self, payload: dict[str, Any]) -> None:
        await self._emit("rule.notify", payload)

    async def run_agent(self, payload: dict[str, Any]) -> None:
        trace_id = str(payload.get("trace_id") or "")
        agent_id = str(payload.get("target") or payload.get("agent_id") or "").strip()
        if self.orchestrator_bridge and agent_id:
            result = await self.orchestrator_bridge.run_agent(agent_id, payload, trace_id)
            await self._emit("rule.run_agent.executed", {**payload, "result": result})
            return
        if self.run_agent_hook:
            await self.run_agent_hook(payload)
            await self._emit("rule.run_agent.executed", payload)
            return
        await self._emit("rule.run_agent.requested", payload)

    async def execute_plan(self, payload: dict[str, Any]) -> None:
        trace_id = str(payload.get("trace_id") or "")
        plan = payload.get("plan")
        if self.orchestrator_bridge and isinstance(plan, dict):
            result = await self.orchestrator_bridge.execute_plan(plan, trace_id)
            await self._emit("rule.execute_plan.executed", {**payload, "result": result})
            return
        await self._emit("rule.execute_plan.requested", payload)

    async def call_webhook(self, payload: dict[str, Any]) -> None:
        target = payload.get("target") or payload.get("url")
        if not isinstance(target, str) or not target.strip():
            raise ValueError("call_webhook requires target/url")
        timeout = float(payload.get("timeout", 10))
        async with httpx.AsyncClient(timeout=timeout) as client:
            await client.post(target, json=payload)
        await self._emit("rule.webhook.called", payload)

    async def log_only(self, payload: dict[str, Any]) -> None:
        await self._emit("rule.log", payload)
