"""Core event-engine data models."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


def utc_now() -> datetime:
    """Return timezone-aware UTC datetime."""
    return datetime.now(timezone.utc)


@dataclass
class Event:
    """Normalized event payload used by the event engine."""

    event_id: str
    event_type: str
    source: str
    subject: str | None
    payload: dict[str, Any]
    timestamp: datetime = field(default_factory=utc_now)
    idempotency_key: str | None = None
    risk_hint: str | None = None


@dataclass
class RuleAction:
    """Action declaration attached to an EventRule."""

    action_type: str
    target: str | None = None
    params: dict[str, Any] = field(default_factory=dict)


@dataclass
class EventRule:
    """Rule definition for event evaluation."""

    id: str
    name: str
    event_type: str
    conditions: dict[str, Any] = field(default_factory=dict)
    action_mode: str = "auto"  # skip|ask|suggest|auto (skip not persisted as config)
    actions: list[RuleAction] = field(default_factory=list)
    risk_level: str = "low"  # low|medium|high
    priority: int = 0
    dedupe_window_seconds: int = 0
    cooldown_seconds: int = 0
    attention_budget_per_day: int = 0
    is_active: bool = True


@dataclass
class RuleDecision:
    """Decision output produced by rule evaluation."""

    decision: str
    reason: str
    rule_id: str


@dataclass
class RuleRun:
    """Persistent execution record for a rule-event pair."""

    run_id: str
    rule_id: str
    event_id: str
    decision: str
    reason: str
    status: str
    action_trace_id: str | None = None
    duration_ms: int | None = None
    created_at: datetime = field(default_factory=utc_now)


@dataclass
class ApprovalRequest:
    """Human approval request data."""

    approval_id: str
    rule_id: str
    event_id: str
    risk_level: str
    context: dict[str, Any] = field(default_factory=dict)
    status: str = "pending"
    created_at: datetime = field(default_factory=utc_now)
    resolved_at: datetime | None = None
