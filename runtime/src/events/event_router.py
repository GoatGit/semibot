"""Route rule actions to execution adapters."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol
from uuid import uuid4

from src.events.models import Event, EventRule, RuleAction, RuleDecision


class ActionExecutor(Protocol):
    """Adapter interface used by EventRouter."""

    async def notify(self, payload: dict[str, Any]) -> None: ...

    async def run_agent(self, payload: dict[str, Any]) -> None: ...

    async def execute_plan(self, payload: dict[str, Any]) -> None: ...

    async def call_webhook(self, payload: dict[str, Any]) -> None: ...

    async def log_only(self, payload: dict[str, Any]) -> None: ...


class NoopActionExecutor:
    """Default action executor used during bootstrap."""

    async def notify(self, payload: dict[str, Any]) -> None:
        return None

    async def run_agent(self, payload: dict[str, Any]) -> None:
        return None

    async def execute_plan(self, payload: dict[str, Any]) -> None:
        return None

    async def call_webhook(self, payload: dict[str, Any]) -> None:
        return None

    async def log_only(self, payload: dict[str, Any]) -> None:
        return None


@dataclass
class RouteReport:
    """Execution result summary for a routed rule."""

    trace_id: str
    total: int
    executed: int = 0
    failed: int = 0
    errors: list[str] = field(default_factory=list)


class EventRouter:
    """Dispatch event-rule actions based on rule decision."""

    def __init__(self, executor: ActionExecutor):
        self.executor = executor

    async def route(self, decision: RuleDecision, event: Event, rule: EventRule) -> RouteReport:
        trace_id = f"trace_{uuid4().hex}"
        if decision.decision == "skip":
            return RouteReport(trace_id=trace_id, total=0)

        if decision.decision in {"ask", "suggest"}:
            # Ask/suggest only materialize informational actions at this layer.
            actions = [a for a in rule.actions if a.action_type in {"notify", "log_only"}]
            return await self._execute(actions, event, trace_id)
        return await self._execute(rule.actions, event, trace_id)

    async def _execute(
        self,
        actions: Sequence[RuleAction],
        event: Event,
        trace_id: str,
    ) -> RouteReport:
        report = RouteReport(trace_id=trace_id, total=len(actions))
        for action in actions:
            payload = {"event_id": event.event_id, "event_type": event.event_type, **action.params}
            if action.target:
                payload["target"] = action.target
            payload["trace_id"] = trace_id

            try:
                if action.action_type == "notify":
                    await self.executor.notify(payload)
                elif action.action_type == "run_agent":
                    await self.executor.run_agent(payload)
                elif action.action_type == "execute_plan":
                    await self.executor.execute_plan(payload)
                elif action.action_type == "call_webhook":
                    await self.executor.call_webhook(payload)
                elif action.action_type == "log_only":
                    await self.executor.log_only(payload)
                else:
                    raise ValueError(f"Unsupported action_type: {action.action_type}")
                report.executed += 1
            except Exception as exc:
                report.failed += 1
                report.errors.append(f"{action.action_type}:{exc}")
        return report
