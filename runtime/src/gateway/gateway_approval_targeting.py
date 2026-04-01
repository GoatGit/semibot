from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from src.events.models import ApprovalRequest


@dataclass(slots=True)
class ApprovalTargetingState:
    bound_approval_ids: list[str]
    execution_id: str | None
    scoped_pending: list[ApprovalRequest]
    scoped_history: list[ApprovalRequest]
    candidate_pool: list[ApprovalRequest]
    scope_label: str


ApprovalMatcher = Callable[[ApprovalRequest], bool]


def build_approval_targeting_state(
    *,
    pending: list[ApprovalRequest],
    history: list[ApprovalRequest],
    bound_execution: dict[str, Any] | None,
    matcher: ApprovalMatcher,
) -> ApprovalTargetingState:
    scoped_pending = [item for item in pending if matcher(item)]
    scoped_history = [item for item in history if matcher(item)]

    bound_approval_ids: list[str] = []
    execution_id: str | None = None
    if isinstance(bound_execution, dict):
        execution_id = str(bound_execution.get("id") or "").strip() or None
        binding = bound_execution.get("approval_binding") if isinstance(bound_execution.get("approval_binding"), dict) else {}
        raw_ids = binding.get("approval_ids")
        if isinstance(raw_ids, list):
            bound_approval_ids = [str(item).strip() for item in raw_ids if str(item).strip()]

    candidate_pool = scoped_pending
    if bound_approval_ids:
        bound_pending = [item for item in pending if item.approval_id in set(bound_approval_ids)]
        if bound_pending:
            candidate_pool = bound_pending

    scope_label = "bound" if bound_approval_ids else "subject" if scoped_pending else "none"
    return ApprovalTargetingState(
        bound_approval_ids=bound_approval_ids,
        execution_id=execution_id,
        scoped_pending=scoped_pending,
        scoped_history=scoped_history,
        candidate_pool=candidate_pool,
        scope_label=scope_label,
    )


def duplicate_approval_ids_for_state(
    *,
    requested_ids: list[str],
    decision: str,
    state: ApprovalTargetingState,
) -> list[str]:
    duplicate_approval_ids = requested_ids or state.bound_approval_ids
    if not duplicate_approval_ids and state.scoped_pending:
        duplicate_approval_ids = [item.approval_id for item in state.scoped_pending]
    if not duplicate_approval_ids and state.scoped_history:
        duplicate_approval_ids = [
            item.approval_id
            for item in state.scoped_history
            if str(getattr(item, "status", "") or "").strip() == decision
        ]
    return duplicate_approval_ids


def resolve_target_ids_for_text_command(
    *,
    kind: str,
    requested_id: str | None,
    pending: list[ApprovalRequest],
    state: ApprovalTargetingState,
    requested_in_scope: Callable[[ApprovalRequest], bool],
) -> tuple[list[str], str | None]:
    if isinstance(requested_id, str) and requested_id:
        requested = next((item for item in pending if item.approval_id == requested_id), None)
        if requested is None or not requested_in_scope(requested):
            return [], "approval_not_in_scope_or_not_pending"
        return [requested_id], None

    if kind in {"approve_all", "reject_all"}:
        return [item.approval_id for item in state.candidate_pool], None
    if kind in {"approve", "reject"} and state.bound_approval_ids:
        return state.bound_approval_ids, None
    if kind in {"approve", "reject"} and state.scoped_pending:
        return [item.approval_id for item in state.scoped_pending], None
    if state.candidate_pool:
        return [state.candidate_pool[-1].approval_id], None
    return [], "no_pending_approval_found"
