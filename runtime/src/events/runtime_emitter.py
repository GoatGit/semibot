"""Helpers for emitting runtime lifecycle events safely."""

from __future__ import annotations

from typing import Any, Protocol
from uuid import uuid4

from src.events.models import Event


class RuntimeEventEmitter(Protocol):
    """Protocol shared by EventEngine and compatible emitters."""

    async def emit(self, event: Event) -> Any: ...


async def emit_runtime_event(
    emitter: RuntimeEventEmitter | None,
    *,
    event_type: str,
    source: str,
    payload: dict[str, Any],
    subject: str | None = None,
    idempotency_key: str | None = None,
    risk_hint: str | None = None,
) -> None:
    """Best-effort runtime event emission."""
    if emitter is None:
        return
    event = Event(
        event_id=f"evt_{uuid4().hex}",
        event_type=event_type,
        source=source,
        subject=subject,
        payload=payload,
        idempotency_key=idempotency_key,
        risk_hint=risk_hint,
    )
    try:
        await emitter.emit(event)
    except Exception:
        # Emission is side-channel and must not break main execution path.
        return
