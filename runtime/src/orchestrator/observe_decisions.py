"""Observe-node decision table.

Each decision is a named function that inspects ``ObserveContext`` and returns
an ``ObserveOutcome`` when it fires, or ``None`` to defer to the next decision.
``evaluate_observe_decisions`` iterates the table in priority order.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Literal

from src.constants import MAX_REPLAN_ATTEMPTS
from src.orchestrator.nodes_shared import (
    _collect_visible_artifacts,
    _final_delivery_contract_fulfilled,
    _is_non_retryable_readonly_api_failure,
    _is_transient_readonly_network_failure,
    _tool_result_error_text,
    _tool_result_success,
)
from src.orchestrator.nodes_stateflow import _build_execution_state_for_planner
from src.orchestrator.state import ExecutionPlan, Message, ToolCallResult
from src.utils.logging import get_logger

logger = get_logger(__name__)


def _step_looks_like_pure_delivery_followup(step: Any) -> bool:
    """Return True for narrow follow-up steps that only package an existing result."""
    if step is None:
        return False
    output_contract = getattr(step, "output_contract", None)
    if output_contract is None:
        return False
    handoff_purpose = str(getattr(output_contract, "handoff_purpose", "") or "").strip().lower()
    handoff_mode = str(getattr(output_contract, "handoff_mode", "") or "").strip().lower()
    must_materialize_file = bool(getattr(output_contract, "must_materialize_file", False))
    must_produce_text = bool(getattr(output_contract, "must_produce_text", True))
    return (
        handoff_purpose == "user_delivery"
        and handoff_mode == "final_delivery"
        and not must_materialize_file
        and must_produce_text
    )


def _can_finish_early_with_existing_delivery(ctx: ObserveContext) -> bool:
    """Allow task completion when remaining work is only a delivery wrapper."""
    if ctx.latest_structured_act_result is None or not _tool_result_success(ctx.latest_structured_act_result):
        return False
    if str(ctx.effective_act_decision or "").strip().lower() != "advance_step":
        return False
    if not ctx.next_actions:
        return False
    if not all(_step_looks_like_pure_delivery_followup(step) for step in ctx.next_actions):
        return False

    visible_artifacts = _collect_visible_artifacts(ctx.current_tool_results)
    delivery_contract = (
        ctx.plan.final_delivery_contract
        if isinstance(ctx.plan, ExecutionPlan) and isinstance(ctx.plan.final_delivery_contract, dict)
        else {}
    )
    delivery_fulfilled, _ = _final_delivery_contract_fulfilled(
        final_delivery_contract=delivery_contract,
        artifacts=visible_artifacts,
        latest_structured_act_result=ctx.latest_structured_act_result,
        execution_state=_build_execution_state_for_planner(ctx.state, prefer_existing=False),
    )
    return delivery_fulfilled


# ---------------------------------------------------------------------------
# Context & outcome dataclasses
# ---------------------------------------------------------------------------

@dataclass
class ObserveContext:
    """Pre-computed state available to every decision function."""

    state: dict[str, Any]
    metadata: dict[str, Any]
    current_iteration: int
    max_iterations: int
    current_skill_name: str
    current_tool_results: list[ToolCallResult | dict[str, Any]]
    blocking_failures: list[ToolCallResult | dict[str, Any]]
    has_errors: bool
    all_failed: bool
    pending_approval_ids: list[str]
    latest_structured_act_result: ToolCallResult | None
    effective_act_decision: str
    next_actions: list[Any]
    plan: ExecutionPlan | None
    # Loop guard
    failure_repeat_count: int
    # Transient network
    transient_network_retry_count: int
    transient_network_retry_limit: int


@dataclass
class ObserveOutcome:
    """Result of a decision that fires."""

    name: str
    observe_outcome: str  # "task_completed" | "awaiting_approval" | "replan_current_round" | "continue_execution"
    current_step: str  # "respond" | "act" | "plan"
    reason: str = ""
    extra_messages: list[Message] | None = None
    error: str | None = None
    # If True, the caller should invoke _return_replan() instead of building the result directly
    needs_replan: bool = False
    # Extra state overrides
    execution_state_override: dict[str, Any] | None = None
    plan_override: Any | None = None
    pending_actions_override: list[Any] | None = None


# ---------------------------------------------------------------------------
# Decision functions — ordered by priority
# ---------------------------------------------------------------------------

def _decide_max_iterations(ctx: ObserveContext) -> ObserveOutcome | None:
    if ctx.current_iteration < ctx.max_iterations:
        return None
    return ObserveOutcome(
        name="max_iterations_reached",
        observe_outcome="task_completed",
        current_step="respond",
        reason=f"maximum iteration limit reached ({ctx.max_iterations})",
    )


def _decide_pending_approval(ctx: ObserveContext) -> ObserveOutcome | None:
    if not ctx.pending_approval_ids:
        return None
    return ObserveOutcome(
        name="pending_approval",
        observe_outcome="awaiting_approval",
        current_step="respond",
        reason="waiting for user approval before continuing",
    )


def _decide_task_complete(ctx: ObserveContext) -> ObserveOutcome | None:
    """advance_step + no remaining actions = task done (subject to delivery check)."""
    if ctx.effective_act_decision != "advance_step" or ctx.next_actions:
        return None
    if ctx.latest_structured_act_result is None:
        return None

    visible_artifacts = _collect_visible_artifacts(ctx.current_tool_results)
    delivery_contract = (
        ctx.plan.final_delivery_contract
        if isinstance(ctx.plan, ExecutionPlan) and isinstance(ctx.plan.final_delivery_contract, dict)
        else {}
    )
    delivery_fulfilled, delivery_reason = _final_delivery_contract_fulfilled(
        final_delivery_contract=delivery_contract,
        artifacts=visible_artifacts,
        latest_structured_act_result=ctx.latest_structured_act_result,
        execution_state=_build_execution_state_for_planner(ctx.state, prefer_existing=False),
    )
    if not delivery_fulfilled and ctx.current_iteration < MAX_REPLAN_ATTEMPTS:
        _act_meta = (
            ctx.latest_structured_act_result.metadata
            if ctx.latest_structured_act_result and isinstance(getattr(ctx.latest_structured_act_result, "metadata", None), dict)
            else {}
        )
        logger.warning(
            "observe_delivery_contract_not_fulfilled",
            extra={
                "session_id": ctx.state.get("session_id"),
                "delivery_reason": delivery_reason,
                "visible_artifact_count": len(visible_artifacts),
                "act_artifact_result_text_len": len(str(_act_meta.get("artifact_result_text") or "")),
                "act_artifact_result_path": str(_act_meta.get("artifact_result_path") or ""),
                "act_decision": str(_act_meta.get("act_decision") or ""),
                "iteration": ctx.current_iteration,
            },
        )
        context_msg = Message(
            role="user",
            content=(
                "[SYSTEM] REPLAN — execution reported terminal completion, but no user-deliverable artifact_result_* payload was produced.\n"
                f"Reason: {delivery_reason}\n"
                "Regenerate only the remaining work needed to produce a non-empty artifact_result_* payload for the final user delivery."
            ),
            name=None,
            tool_call_id=None,
        )
        return ObserveOutcome(
            name="delivery_contract_not_fulfilled",
            observe_outcome="replan_current_round",
            current_step="plan",
            reason=f"delivery contract not fulfilled: {delivery_reason}",
            extra_messages=[context_msg],
            needs_replan=True,
        )

    return ObserveOutcome(
        name="task_complete",
        observe_outcome="task_completed",
        current_step="respond",
        reason="task is complete; no further execution is needed",
    )


def _decide_task_complete_early(ctx: ObserveContext) -> ObserveOutcome | None:
    """Allow observe to end the task when only delivery wrapper steps remain."""
    if not _can_finish_early_with_existing_delivery(ctx):
        return None
    return ObserveOutcome(
        name="task_complete_early",
        observe_outcome="task_completed",
        current_step="respond",
        reason="existing result already satisfies final delivery; skipping redundant follow-up delivery steps",
    )


def _decide_transient_network_retry(ctx: ObserveContext) -> ObserveOutcome | None:  # noqa: ARG001
    """Disabled: transient network retry decision (non-generic)."""
    return None


def _decide_non_retryable_api_failure(ctx: ObserveContext) -> ObserveOutcome | None:  # noqa: ARG001
    """Disabled: non-retryable API failure decision (non-generic)."""
    return None


def _decide_execution_stall(ctx: ObserveContext) -> ObserveOutcome | None:
    if not (ctx.has_errors and ctx.failure_repeat_count >= 2 and ctx.current_iteration >= 2):
        return None
    stall_msg = Message(
        role="user",
        content=(
            "[SYSTEM] STOP — execution is not converging.\n"
            "The current round has repeated the same failing pattern without meaningful progress.\n"
            "Do not continue replanning in this round."
        ),
        name=None,
        tool_call_id=None,
    )
    return ObserveOutcome(
        name="execution_stall",
        observe_outcome="task_completed",
        current_step="respond",
        reason="execution stalled after repeated failing patterns without meaningful progress",
        extra_messages=[stall_msg],
        error="Execution stalled: repeated failing pattern without meaningful progress",
    )


def _decide_all_failed_replan(ctx: ObserveContext) -> ObserveOutcome | None:
    if not ctx.all_failed or ctx.current_iteration >= MAX_REPLAN_ATTEMPTS:
        return None
    return ObserveOutcome(
        name="all_failed_replan",
        observe_outcome="replan_current_round",
        current_step="plan",
        reason="all tool calls failed",
        needs_replan=True,
    )


def _decide_partial_failure_replan(ctx: ObserveContext) -> ObserveOutcome | None:
    if not ctx.has_errors or ctx.current_iteration >= MAX_REPLAN_ATTEMPTS:
        return None
    error_summaries = []
    for r in ctx.blocking_failures:
        tool_name = str(r.get("tool_name") or "unknown") if isinstance(r, dict) else str(r.tool_name or "unknown")
        error_text = _tool_result_error_text(r) or "unknown error"
        error_summaries.append(f"- {tool_name}: {error_text}")
    context_msg = Message(
        role="user",
        content=(
            "[SYSTEM] REPLAN — some executed steps failed, so the current round is not complete.\n"
            "Regenerate the plan for the remaining work within the current round.\n\n"
            "Failed steps:\n"
            + ("\n".join(error_summaries) if error_summaries else "- unknown error")
        ),
        name=None,
        tool_call_id=None,
    )
    return ObserveOutcome(
        name="partial_failure_replan",
        observe_outcome="replan_current_round",
        current_step="plan",
        reason="some steps failed, replanning remaining work",
        extra_messages=[context_msg],
        needs_replan=True,
    )


def _decide_missing_bindings_replan(ctx: ObserveContext) -> ObserveOutcome | None:
    if not ctx.plan or not ctx.next_actions:
        return None
    next_execution_state = _build_execution_state_for_planner(
        {**ctx.state, "plan": ctx.plan, "pending_actions": ctx.next_actions, "metadata": ctx.metadata},
        prefer_existing=False,
    )
    next_bindings = (
        next_execution_state.get("step_input_bindings", {}).get(
            str(ctx.next_actions[0].id or "").strip(), []
        )
        if isinstance(next_execution_state, dict)
        else []
    )
    missing_bindings = [
        item for item in next_bindings
        if isinstance(item, dict) and item.get("binding_missing")
    ]
    if not missing_bindings or ctx.current_iteration >= MAX_REPLAN_ATTEMPTS:
        return None
    context_msg = Message(
        role="user",
        content=(
            "[SYSTEM] REPLAN — the next step is missing required bound inputs.\n"
            "Do not guess file paths or implicit artifacts. Regenerate the remaining work so required step inputs are explicitly produced.\n\n"
            "Missing bindings:\n"
            + "\n".join(
                f"- {str(item.get('input_name') or 'input')}: source_step_id={str(item.get('source_step_id') or 'n/a')}, preferred_medium={str(item.get('preferred_medium') or 'artifact_result_text')}"
                for item in missing_bindings[:8]
            )
        ),
        name=None,
        tool_call_id=None,
    )
    return ObserveOutcome(
        name="missing_bindings_replan",
        observe_outcome="replan_current_round",
        current_step="plan",
        reason="next step missing required bound inputs",
        extra_messages=[context_msg],
        needs_replan=True,
        execution_state_override=next_execution_state,
    )


def _decide_continue_execution(ctx: ObserveContext) -> ObserveOutcome | None:
    if not ctx.plan or not ctx.next_actions:
        return None
    next_execution_state = _build_execution_state_for_planner(
        {**ctx.state, "plan": ctx.plan, "pending_actions": ctx.next_actions, "metadata": ctx.metadata},
        prefer_existing=False,
    )
    return ObserveOutcome(
        name="continue_execution",
        observe_outcome="continue_execution",
        current_step="act",
        reason="continuing with remaining work",
        execution_state_override=next_execution_state,
        plan_override=ctx.plan,
        pending_actions_override=ctx.next_actions,
    )


def _decide_default_complete(ctx: ObserveContext) -> ObserveOutcome | None:
    """Fallback: no more actions, task is done."""
    return ObserveOutcome(
        name="default_complete",
        observe_outcome="task_completed",
        current_step="respond",
        reason="task is complete; no further execution is needed",
    )


# ---------------------------------------------------------------------------
# Decision table — priority order
# ---------------------------------------------------------------------------

OBSERVE_DECISIONS: list[Callable[[ObserveContext], ObserveOutcome | None]] = [
    _decide_max_iterations,
    _decide_pending_approval,
    _decide_task_complete,
    _decide_task_complete_early,
    _decide_transient_network_retry,
    _decide_non_retryable_api_failure,
    _decide_execution_stall,
    _decide_all_failed_replan,
    _decide_partial_failure_replan,
    _decide_missing_bindings_replan,
    _decide_continue_execution,
    _decide_default_complete,
]


def evaluate_observe_decisions(ctx: ObserveContext) -> ObserveOutcome:
    """Iterate the decision table and return the first outcome that fires."""
    for decide in OBSERVE_DECISIONS:
        outcome = decide(ctx)
        if outcome is not None:
            return outcome
    # Should never reach here due to _decide_default_complete
    return _decide_default_complete(ctx)  # type: ignore[return-value]
