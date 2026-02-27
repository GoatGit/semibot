"""Human-in-the-loop approval management."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any
from uuid import uuid4

from src.events.event_store import EventStore
from src.events.models import ApprovalRequest, Event


class ApprovalManager:
    """Create and resolve approval requests."""

    def __init__(
        self,
        store: EventStore,
        emit_event: Callable[[Event], Awaitable[None]] | None = None,
    ):
        self.store = store
        self.emit_event = emit_event

    async def request(
        self,
        *,
        rule_id: str,
        event_id: str,
        risk_level: str,
        context: dict[str, Any] | None = None,
    ) -> ApprovalRequest:
        normalized_context = context if isinstance(context, dict) else {}
        approval = ApprovalRequest(
            approval_id=f"appr_{uuid4().hex}",
            rule_id=rule_id,
            event_id=event_id,
            risk_level=risk_level,
            context=normalized_context,
            status="pending",
        )
        self.store.insert_approval(approval)
        if self.emit_event:
            await self.emit_event(
                Event(
                    event_id=f"evt_approval_req_{uuid4().hex}",
                    event_type="approval.requested",
                    source="runtime.approval_manager",
                    subject=approval.approval_id,
                    payload={
                        "approval_id": approval.approval_id,
                        "rule_id": rule_id,
                        "event_id": event_id,
                        "risk_level": risk_level,
                        "status": "pending",
                        "context": normalized_context,
                    },
                    risk_hint=risk_level,
                )
            )
        return approval

    async def resolve(self, approval_id: str, decision: str) -> ApprovalRequest | None:
        next_status = "approved" if decision == "approved" else "rejected"
        self.store.update_approval(approval_id, next_status)
        approval = self.store.get_approval(approval_id)
        if approval and self.emit_event:
            await self.emit_event(
                Event(
                    event_id=f"evt_approval_res_{uuid4().hex}",
                    event_type="approval.approved" if next_status == "approved" else "approval.rejected",
                    source="runtime.approval_manager",
                    subject=approval.approval_id,
                    payload={
                        "approval_id": approval.approval_id,
                        "rule_id": approval.rule_id,
                        "event_id": approval.event_id,
                        "risk_level": approval.risk_level,
                        "status": approval.status,
                        "context": approval.context,
                    },
                    risk_hint=approval.risk_level,
                )
            )
        return approval

    def list_pending(self) -> list[ApprovalRequest]:
        return self.store.list_pending_approvals()
