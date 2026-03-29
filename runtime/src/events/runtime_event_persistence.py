"""Persist selected runtime events into EventStore for audit and UI inspection."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from src.events.models import Event
from src.utils.logging import get_logger

logger = get_logger(__name__)

PERSISTED_RUNTIME_EVENT_TYPES = {
    "llm.usage",
    "runtime.signal",
    "runtime.failure",
    "act.heartbeat",
    "route.started",
    "route.mode_selected",
    "route.completed",
    "dr.started",
    "dr.completed",
    "dr.failed",
    "observe_dr.started",
    "observe_dr.respond_success",
    "observe_dr.respond_partial",
    "observe_dr.upgrade_to_plan_act",
}


def persist_runtime_event_to_store(event_engine: Any | None, runtime_event: dict[str, Any]) -> None:
    if event_engine is None:
        return
    event_type = str(runtime_event.get("event") or "").strip()
    if event_type not in PERSISTED_RUNTIME_EVENT_TYPES:
        return
    data = runtime_event.get("data") or {}
    if not isinstance(data, dict):
        data = {"value": data}
    try:
        event_engine.store.append_event(
            Event(
                event_id=uuid4().hex,
                event_type=event_type,
                source="orchestrator",
                subject=data.get("session_id"),
                payload=data,
            )
        )
    except Exception:
        logger.debug("runtime_event_persist_failed", extra={"event_type": event_type}, exc_info=True)
