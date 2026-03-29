"""OBSERVE_DR node for Direct Reasoning Mode."""

from __future__ import annotations

from typing import Any

from src.events.runtime_emitter import emit_runtime_event
from src.orchestrator.state import AgentState, DirectReasoningObserveOutcome


def _pending_approval_ids(state: AgentState) -> list[str]:
    approval_ids: list[str] = []
    for result in state.get("tool_results") or []:
        meta = getattr(result, "metadata", None)
        if not isinstance(meta, dict):
            continue
        if str(meta.get("approval_status") or "").strip().lower() != "pending":
            continue
        approval_id = str(meta.get("approval_id") or "").strip()
        if approval_id:
            approval_ids.append(approval_id)
    return list(dict.fromkeys(approval_ids))


def _derive_observe_dr_outcome(state: AgentState) -> DirectReasoningObserveOutcome:
    pending_approval_ids = _pending_approval_ids(state)
    if pending_approval_ids:
        return {
            "outcome": "awaiting_approval",
            "reason": f"dr is waiting for approval: {', '.join(pending_approval_ids)}",
        }

    dr_result = state.get("dr_result") or {}
    status = str((dr_result or {}).get("status") or "").strip().lower()

    if status == "completed":
        return {
            "outcome": "respond_success",
            "reason": "dr completed with a user-ready answer",
        }
    if status == "partial":
        return {
            "outcome": "respond_partial",
            "reason": "dr produced a partial but acceptable answer",
        }
    if status == "upgrade_required":
        return {
            "outcome": "upgrade_to_plan_act",
            "reason": str((dr_result or {}).get("upgrade_reason") or "dr requires workflow planning").strip(),
        }
    if status == "failed" and str((dr_result or {}).get("upgrade_reason") or "").strip():
        return {
            "outcome": "upgrade_to_plan_act",
            "reason": str((dr_result or {}).get("upgrade_reason") or "dr failed").strip(),
        }
    return {
        "outcome": "respond_partial",
        "reason": "dr failed without a recoverable workflow upgrade path",
    }


async def observe_dr_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    """Observe direct reasoning result and decide respond vs plan."""
    session_id = str(state.get("session_id") or "").strip()
    runtime_context = state.get("context")
    runtime_metadata = getattr(runtime_context, "metadata", None)
    org_id = str((runtime_metadata or {}).get("org_id") or "").strip() if isinstance(runtime_metadata, dict) else ""
    runtime_event_emitter = context.get("runtime_event_emitter")

    await emit_runtime_event(
        runtime_event_emitter,
        event_type="observe_dr.started",
        source="runtime.observe_dr_node",
        subject=session_id or None,
        payload={"session_id": session_id, "org_id": org_id or None},
    )

    outcome = _derive_observe_dr_outcome(state)
    pending_approval_ids = _pending_approval_ids(state)
    await emit_runtime_event(
        runtime_event_emitter,
        event_type=f"observe_dr.{outcome['outcome']}",
        source="runtime.observe_dr_node",
        subject=session_id or None,
        payload={
            "session_id": session_id,
            "org_id": org_id or None,
            "reason": outcome.get("reason"),
            "pending_approval_ids": pending_approval_ids,
        },
    )
    return {
        "observe_dr_outcome": outcome,
        "metadata": {
            **(state.get("metadata") or {}),
            "pending_approval_ids": pending_approval_ids,
        },
        "current_step": "observe_dr",
    }
