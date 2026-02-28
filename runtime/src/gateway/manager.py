"""Gateway manager wiring adapters, policies, and notifier lifecycle."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class GatewayManager:
    """Placeholder manager for incremental migration.

    In this phase, routing still lives in API layer while business logic is moved
    to `gateway.context_service`.
    """

    ready: bool = True
