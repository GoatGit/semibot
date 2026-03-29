"""ACT LLM call context builders, error handling, and output truncation."""

import asyncio
import json
from typing import Any, Literal

from src.orchestrator.act_context import (
    _format_loaded_resource_summary,
    _persist_act_loop_trace_to_state,
    _persist_step_transcript_to_state,
    _resolved_step_output_contract,
    _truncate_act_prompt_text,
)
from src.orchestrator.runtime_middleware import RuntimeFailure, RuntimeSignal
from src.orchestrator.state import AgentState, ExecutionPlan, PlanStep, ToolCallResult
from src.utils.logging import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Loop-level helpers called from the rewritten _execute_llm_act_step
# ---------------------------------------------------------------------------


def handle_act_llm_error(
    *,
    llm_error: Exception,
    state: AgentState,
    action: PlanStep,
    step_transcript: list[dict[str, Any]],
    step_results: list[ToolCallResult],
    act_loop_trace: list[dict[str, Any]],
    turn_count: int,
    act_phase: str,
    rate_limit_retry_count: int,
    max_rate_limit_retries: int,
    context_overflow_retry_count: int,
    max_context_overflow_retries: int,
    timeout_retry_count: int = 0,
    max_timeout_retries: int = 2,
) -> dict[str, Any]:
    """Handle an LLM call exception.

    Returns a signal dict:
      {"action": "continue", "rate_limit_retry_count": N, "context_overflow_retry_count": N,
       "timeout_retry_count": N, "backoff_seconds": N, "step_transcript": [...]}
    or
      {"action": "return"}
    The caller is responsible for ``await asyncio.sleep`` when backoff_seconds > 0,
    appending to step_results when action=="return", and persisting state.
    """
    llm_error_text = str(llm_error)
    payload_summary = getattr(llm_error, "payload_summary", None)
    logger.warning(
        "act_inner_loop_llm_call_failed",
        extra={
            "session_id": state["session_id"],
            "turn_count": turn_count,
            "transcript_len": len(step_transcript),
            "error": llm_error_text[:300],
            "payload_summary": payload_summary,
        },
    )

    is_rate_limit = any(
        token in llm_error_text.lower()
        for token in ("429", "too many requests", "rate limit", "rate_limit", "ratelimit")
    )
    if is_rate_limit:
        new_rl_count = rate_limit_retry_count + 1
        runtime_failure = RuntimeFailure(
            family="llm",
            kind="rate_limit",
            retryable=new_rl_count <= max_rate_limit_retries,
            source="llm_provider",
            message=llm_error_text[:300],
        )
        if new_rl_count > max_rate_limit_retries:
            logger.warning(
                "act_inner_loop_rate_limit_retries_exhausted",
                extra={"session_id": state["session_id"], "turn_count": turn_count, "retries": new_rl_count},
            )
            step_results.append(
                ToolCallResult(
                    tool_name="llm_act",
                    params={"title": action.title},
                    error=f"Rate limit retries exhausted after {max_rate_limit_retries} attempts: {llm_error_text[:300]}",
                    success=False,
                )
            )
            return {"action": "return", "runtime_failure": runtime_failure.to_dict()}
        backoff_seconds = 5 * (2 ** (new_rl_count - 1))
        logger.info(
            "act_inner_loop_rate_limited_retry",
            extra={"session_id": state["session_id"], "turn_count": turn_count, "retry": new_rl_count, "backoff_s": backoff_seconds},
        )
        return {
            "action": "continue",
            "rate_limit_retry_count": new_rl_count,
            "context_overflow_retry_count": context_overflow_retry_count,
            "timeout_retry_count": timeout_retry_count,
            "backoff_seconds": backoff_seconds,
            "step_transcript": step_transcript,
            "runtime_failure": runtime_failure.to_dict(),
            "runtime_signal": RuntimeSignal(
                kind="retry",
                source="budget_guard",
                reason="llm_rate_limit_retry",
                message="Rate limited; retrying ACT LLM call",
                data={"retry_count": new_rl_count, "backoff_seconds": backoff_seconds},
            ).to_dict(),
        }

    is_context_overflow = any(
        token in llm_error_text.lower()
        for token in ("maximum context length", "token", "too long", "content_length", "max_tokens")
    )
    if is_context_overflow and len(step_transcript) > 4:
        new_co_count = context_overflow_retry_count + 1
        runtime_failure = RuntimeFailure(
            family="llm",
            kind="context_overflow",
            retryable=new_co_count <= max_context_overflow_retries,
            source="llm_provider",
            message=llm_error_text[:300],
        )
        if new_co_count > max_context_overflow_retries:
            logger.warning(
                "act_inner_loop_context_overflow_retries_exhausted",
                extra={"session_id": state["session_id"], "turn_count": turn_count, "retries": new_co_count},
            )
            step_results.append(
                ToolCallResult(
                    tool_name="llm_act",
                    params={"title": action.title},
                    error=f"Context overflow retries exhausted after {max_context_overflow_retries} attempts: {llm_error_text[:300]}",
                    success=False,
                )
            )
            return {"action": "return", "runtime_failure": runtime_failure.to_dict()}
        trimmed = step_transcript[:2] + step_transcript[-2:]
        _persist_step_transcript_to_state(state, action.id, trimmed)
        logger.info(
            "act_inner_loop_transcript_trimmed",
            extra={"session_id": state["session_id"], "new_transcript_len": len(trimmed)},
        )
        return {
            "action": "continue",
            "rate_limit_retry_count": rate_limit_retry_count,
            "context_overflow_retry_count": new_co_count,
            "timeout_retry_count": timeout_retry_count,
            "backoff_seconds": 0,
            "step_transcript": trimmed,
            "runtime_failure": runtime_failure.to_dict(),
            "runtime_signal": RuntimeSignal(
                kind="retry",
                source="budget_guard",
                reason="llm_context_overflow_retry",
                message="Transcript trimmed after context overflow",
                data={"retry_count": new_co_count},
            ).to_dict(),
        }

    # Transient timeout / connection errors — retry with backoff
    is_timeout = any(
        token in llm_error_text.lower()
        for token in (
            "timed out", "timeout", "request timed out",
            "interrupted", "connection reset", "connection aborted",
            "connectionerror", "connecterror", "connecttimeout",
            "readtimeout",
        )
    )
    if is_timeout:
        new_to_count = timeout_retry_count + 1
        runtime_failure = RuntimeFailure(
            family="llm",
            kind="timeout",
            retryable=new_to_count <= max_timeout_retries,
            source="llm_provider",
            message=llm_error_text[:300],
        )
        if new_to_count > max_timeout_retries:
            logger.warning(
                "act_inner_loop_timeout_retries_exhausted",
                extra={"session_id": state["session_id"], "turn_count": turn_count, "retries": new_to_count},
            )
            step_results.append(
                ToolCallResult(
                    tool_name="llm_act",
                    params={"title": action.title},
                    error=f"LLM timeout retries exhausted after {max_timeout_retries} attempts: {llm_error_text[:300]}",
                    success=False,
                )
            )
            return {"action": "return", "runtime_failure": runtime_failure.to_dict()}
        backoff_seconds = 3 * (2 ** (new_to_count - 1))
        logger.info(
            "act_inner_loop_timeout_retry",
            extra={"session_id": state["session_id"], "turn_count": turn_count, "retry": new_to_count, "backoff_s": backoff_seconds},
        )
        return {
            "action": "continue",
            "rate_limit_retry_count": rate_limit_retry_count,
            "context_overflow_retry_count": context_overflow_retry_count,
            "timeout_retry_count": new_to_count,
            "backoff_seconds": backoff_seconds,
            "step_transcript": step_transcript,
            "runtime_failure": runtime_failure.to_dict(),
            "runtime_signal": RuntimeSignal(
                kind="retry",
                source="budget_guard",
                reason="llm_timeout_retry",
                message="Transient LLM timeout; retrying ACT LLM call",
                data={"retry_count": new_to_count, "backoff_seconds": backoff_seconds},
            ).to_dict(),
        }

    # Fatal / unrecoverable error
    act_loop_trace.append({
        "turn_index": turn_count,
        "phase": act_phase,
        "outcome": "llm_error",
        "error": llm_error_text[:500],
        "payload_summary": payload_summary,
    })
    _persist_act_loop_trace_to_state(state, action.id, act_loop_trace)
    step_results.append(
        ToolCallResult(
            tool_name="llm_act",
            params={"title": action.title},
            error=f"LLM API call failed: {llm_error_text[:500]}",
            success=False,
            metadata={
                **({"payload_summary": payload_summary} if isinstance(payload_summary, dict) else {}),
                "runtime_failure": RuntimeFailure(
                    family="llm",
                    kind="provider_error",
                    retryable=False,
                    source="llm_provider",
                    message=llm_error_text[:500],
                    meta={"payload_summary": payload_summary} if isinstance(payload_summary, dict) else {},
                ).to_dict(),
            },
        )
    )
    return {"action": "return"}


def handle_act_output_truncation(
    *,
    response: Any,
    state: AgentState,
    action: PlanStep,
    step_transcript: list[dict[str, Any]],
    step_results: list[ToolCallResult],
    act_loop_trace: list[dict[str, Any]],
    turn_count: int,
    act_phase: str,
    output_truncation_retry_count: int,
    max_output_truncation_retries: int,
) -> dict[str, Any]:
    """Handle finish_reason=length.

    Returns:
      {"action": "proceed"} — not truncated, continue normal processing
      {"action": "continue", "output_truncation_retry_count": N, "step_transcript": [...]}
      {"action": "return"}
    """
    if getattr(response, "finish_reason", "") != "length":
        return {"action": "proceed"}

    logger.warning(
        "act_inner_loop_output_truncated",
        extra={
            "session_id": state["session_id"],
            "turn_count": turn_count,
            "transcript_len": len(step_transcript),
        },
    )
    if len(step_transcript) > 4:
        new_count = output_truncation_retry_count + 1
        if new_count > max_output_truncation_retries:
            logger.warning(
                "act_inner_loop_output_truncation_retries_exhausted",
                extra={"session_id": state["session_id"], "turn_count": turn_count, "retries": new_count},
            )
            act_loop_trace.append({
                "turn_index": turn_count,
                "phase": act_phase,
                "outcome": "output_truncation_retries_exhausted",
            })
            _persist_act_loop_trace_to_state(state, action.id, act_loop_trace)
            step_results.append(
                ToolCallResult(
                    tool_name="llm_act",
                    params={"title": action.title},
                    error=f"Output truncation retries exhausted after {max_output_truncation_retries} attempts",
                    success=False,
                )
            )
            return {"action": "return"}
        trimmed = step_transcript[:2] + step_transcript[-2:]
        _persist_step_transcript_to_state(state, action.id, trimmed)
        logger.info(
            "act_inner_loop_transcript_trimmed_for_output_truncation",
            extra={"session_id": state["session_id"], "new_transcript_len": len(trimmed)},
        )
        return {
            "action": "continue",
            "output_truncation_retry_count": new_count,
            "step_transcript": trimmed,
        }
    # Short transcript — just log and proceed
    act_loop_trace.append({
        "turn_index": turn_count,
        "phase": act_phase,
        "outcome": "output_truncated_retry",
        "finish_reason": str(getattr(response, "finish_reason", "") or ""),
    })
    _persist_act_loop_trace_to_state(state, action.id, act_loop_trace)
    return {"action": "proceed"}


def build_act_system_messages(
    current_date: str, current_weekday: str, current_timezone: str,
) -> list[dict[str, Any]]:
    """Build the base system messages with ACT executor prompt."""
    from src.orchestrator.prompts.act_prompts import act_executor_system_prompt

    return [
        {
            "role": "system",
            "content": act_executor_system_prompt(
                current_date=current_date,
                current_weekday=current_weekday,
                current_timezone=current_timezone,
            ),
        },
        {
            "role": "system",
            "content": (
                "Document context protocol:\n"
                "- If the user message includes [DOCUMENT_CONTEXT_BEGIN]/[DOCUMENT_CONTEXT_END], treat it as authoritative document digest.\n"
                "- When you need original evidence, read chunk files via file_io path docs/<doc_id>/v<version>/chunks/<chunk_id>.txt.\n"
                "- If file_io returns missing_chunk_ids, provide a conservative answer based on existing digest and state missing chunks explicitly.\n"
                "- Keep chunk citations in final answers using [chunk:cXXXX] format; do not strip citations."
            ),
        },
    ]


def build_step_static_context(
    *,
    current_plan: Any,
    action: PlanStep,
    latest_user_text: str,
    execution_state: dict[str, Any] | None,
) -> str:
    """Build the static step context string (sent once as a system message)."""
    _skill_context_for_act_text = "Structured skill context for this round:\n(none)\n\n"
    if isinstance(current_plan, ExecutionPlan):
        _skill_context = current_plan.skill_context_for_act
        if isinstance(_skill_context, dict) and _skill_context:
            try:
                _payload = json.dumps(_skill_context, ensure_ascii=False, indent=2)
            except Exception:
                _payload = str(_skill_context)
            _skill_context_for_act_text = f"Structured skill context for this round:\n{_payload}\n\n"

    _step_input_bindings_text = ""
    if isinstance(execution_state, dict):
        _raw_bindings = execution_state.get("step_input_bindings")
        if isinstance(_raw_bindings, dict):
            _step_bindings = _raw_bindings.get(str(action.id or "").strip())
            if isinstance(_step_bindings, list) and _step_bindings:
                _lines = ["Resolved input bindings for this step:"]
                for _item in _step_bindings[:20]:
                    if not isinstance(_item, dict):
                        continue
                    _lines.append(
                        f"- {str(_item.get('input_name') or 'input').strip()}: "
                        f"source_step_id={str(_item.get('source_step_id') or '').strip() or 'n/a'} "
                        f"artifact_role={str(_item.get('artifact_role') or '').strip() or 'n/a'} "
                        f"resolved_medium={str(_item.get('resolved_medium') or 'missing')}"
                    )
                    if _item.get("artifact_result_path"):
                        _lines.append(f"  artifact_result_path={str(_item.get('artifact_result_path'))}")
                    if _item.get("artifact_result_text"):
                        _lines.append(f"  artifact_result_text={str(_item.get('artifact_result_text'))[:400]}")
                    if _item.get("binding_missing"):
                        _lines.append("  binding_missing=true")
                _step_input_bindings_text = "\n".join(_lines) + "\n\n"

    _step_static_content = (
        f"User request:\n{latest_user_text or '(empty)'}\n\n"
        + (
            f"Original goal:\n{current_plan.goal}\n\n"
            if isinstance(current_plan, ExecutionPlan) and str(current_plan.goal or "").strip()
            else ""
        )
        + (
            f"Current round goal:\n{current_plan.round_goal}\n\n"
            if isinstance(current_plan, ExecutionPlan) and str(current_plan.round_goal or "").strip()
            else ""
        )
        + _skill_context_for_act_text
        + (
            "Planner critical constraints:\n"
            + "\n".join(
                f"- {item}"
                for item in (
                    current_plan.planning_rationale.get("critical_constraints", [])
                    if isinstance(current_plan, ExecutionPlan)
                    and isinstance(current_plan.planning_rationale, dict)
                    else []
                )[:20]
            )
            + "\n\n"
            if isinstance(current_plan, ExecutionPlan)
            and isinstance(current_plan.planning_rationale, dict)
            and isinstance(current_plan.planning_rationale.get("critical_constraints"), list)
            and current_plan.planning_rationale.get("critical_constraints")
            else ""
        )
        + (
            "Current round stop or replan conditions:\n"
            + "\n".join(
                f"- {item}" for item in current_plan.stop_or_replan_conditions[:20]
            )
            + "\n\n"
            if isinstance(current_plan, ExecutionPlan)
            and current_plan.stop_or_replan_conditions
            else ""
        )
        + f"Current step title:\n{action.title}\n\n"
        + (
            f"Current step phase:\n{action.phase}\n\n"
            if str(action.phase or "").strip()
            else ""
        )
        + (
            f"Current step intent:\n{action.intent}\n\n"
            if str(action.intent or "").strip()
            else ""
        )
        + (
            "Current step inputs required:\n"
            + "\n".join(f"- {item}" for item in action.inputs_required[:20])
            + "\n\n"
            if action.inputs_required
            else ""
        )
        + (
            "Current step expected outputs:\n"
            + "\n".join(f"- {item}" for item in action.expected_outputs[:20])
            + "\n\n"
            if action.expected_outputs
            else ""
        )
        + (
            "Current step execution constraints:\n"
            + "\n".join(f"- {item}" for item in action.execution_constraints[:20])
            + "\n\n"
            if action.execution_constraints
            else ""
        )
        + (
            "Current step completion criteria:\n"
            + "\n".join(f"- {item}" for item in action.completion_criteria[:20])
            + "\n\n"
            if action.completion_criteria
            else ""
        )
        + (
            "Current step output contract:\n"
            + "\n".join(
                f"- {key}: {value}"
                for key, value in _resolved_step_output_contract(action).items()
                if value not in (None, "", [])
            )
            + "\n\n"
        )
        + _step_input_bindings_text
    )
    return _truncate_act_prompt_text(_step_static_content)


def build_per_turn_user_message(
    *,
    act_phase: str,
    terminal_retry_count: int,
    short_term_budget_text: str,
    step_memory: dict[str, list[dict[str, Any]]],
    artifact_context: list[dict[str, Any]],
    current_step_output_contract: dict[str, Any] | None = None,
) -> str:
    """Build the per-turn dynamic user message."""
    current_primary_output = (
        step_memory.get("current_primary_output", {})
        if isinstance(step_memory.get("current_primary_output"), dict)
        else {}
    )
    output_contract = current_step_output_contract if isinstance(current_step_output_contract, dict) else {}
    handoff_purpose = str(output_contract.get("handoff_purpose") or "").strip().lower()
    has_existing_artifact = bool(
        str(current_primary_output.get("artifact_result_text") or "").strip()
        or str(current_primary_output.get("artifact_result_path") or "").strip()
    )
    delivery_reuse_guidance = ""
    if handoff_purpose == "user_delivery" and has_existing_artifact:
        delivery_reuse_guidance = (
            "Existing delivery-ready material is already available from prior execution context.\n"
            "- Prefer using the existing artifact_result_text / artifact_result_path instead of calling more tools.\n"
            "- If the existing artifact is already sufficient for the user's requested delivery, stop exploration and return the terminal JSON now.\n"
            "- Only call another tool if the current artifact is clearly insufficient to satisfy the step completion criteria.\n\n"
        )
    act_user_content = (
            (
                "Execution phase:\n- terminal_phase\n\n"
                if act_phase == "terminal"
                else "Execution phase:\n- tool_phase\n\n"
            )
            + (
                "Terminal phase requirements:\n"
                "- Return exactly one JSON object.\n"
                "- Do not include markdown fences.\n"
                "- Do not include any prose before or after the JSON object.\n"
                "- Escape newlines inside JSON string fields such as artifact_result_text.\n\n"
                if act_phase == "terminal"
                else ""
            )
            + (
                "Previous terminal attempts failed because the response was not valid JSON. "
                "This retry must return only one valid JSON object that matches the terminal schema. "
                "Do not add explanations, markdown fences, or unescaped multiline text.\n\n"
                if act_phase == "terminal" and terminal_retry_count > 0
                else ""
            )
            + short_term_budget_text
            + _format_loaded_resource_summary(step_memory)
            + "\n\n"
            + delivery_reuse_guidance
            + (
                "Available generated artifacts:\n"
                "- artifact_result_path: the real file path for downstream tool arguments\n"
                "- workspace_relative_path: session-workspace-relative path; use only when a tool explicitly expects workspace-relative paths\n"
                "- artifact_result_text: the actual text output from a prior step; use this for reasoning instead of inventing a file\n"
                + "\n".join(
                    f"- artifact_name={item.get('artifact_name')} artifact_type={item.get('artifact_type')}"
                    + f" artifact_medium={item.get('artifact_medium')}"
                    + f" artifact_format={item.get('artifact_format')}"
                    + f" artifact_role={item.get('artifact_role')}"
                    + f" likely_final={item.get('is_likely_final')}"
                    + (
                        f" artifact_result_path={item.get('artifact_result_path')}"
                        if item.get("artifact_result_path")
                        else ""
                    )
                    + (
                        f" workspace_relative_path={item.get('workspace_relative_path')}"
                        if item.get("workspace_relative_path")
                        else ""
                    )
                    + (
                        f" artifact_result_text={str(item.get('artifact_result_text'))[:400]}"
                        if item.get("artifact_result_text")
                        else ""
                    )
                    + (
                        f" purpose={item.get('artifact_purpose')}"
                        if item.get("artifact_purpose")
                        else ""
                    )
                    for item in artifact_context[:20]
                )
                + "\n\n"
                if artifact_context
                else "Available generated artifacts:\n- none\n\n"
            )
            + "Decide the next concrete action for this step."
    )
    return act_user_content
