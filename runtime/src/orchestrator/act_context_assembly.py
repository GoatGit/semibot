"""Assemble ACT turn messages by reusing existing context builders and budgets."""

from __future__ import annotations

from typing import Any

from src.orchestrator.act_context import (
    _build_step_memory,
    _compact_act_artifact_context,
    _compact_act_transcript,
    _filter_historical_tool_results_for_artifact_context,
    _get_step_transcripts,
    _resolved_step_output_contract,
    _truncate_act_prompt_text,
)
from src.orchestrator.act_context_compression import apply_context_compression
from src.orchestrator.act_llm_caller import build_per_turn_user_message
from src.orchestrator.nodes_stateflow import _build_act_artifact_context
from src.orchestrator.runtime_middleware import RuntimeSignal
from src.orchestrator.runtime_middleware import get_step_runtime_state
from src.orchestrator.state import AgentState, PlanStep, ToolCallResult
from src.utils.logging import get_logger

logger = get_logger(__name__)


async def assemble_act_turn_messages(
    *,
    state: AgentState,
    action: PlanStep,
    runtime_context: Any | None,
    memory_system: Any | None,
    step_system_messages: list[dict[str, Any]],
    step_transcript: list[dict[str, Any]],
    step_results: list[ToolCallResult],
    prior_results: list[ToolCallResult] | None,
    act_phase: str,
    terminal_retry_count: int,
    current_iteration: int,
    latest_user_text: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any], str, RuntimeSignal | None]:
    dep_step_ids: set[str] = {
        ref.source_step_id
        for ref in (action.input_refs or [])
        if ref.source_step_id
    }

    def _iter_matches(meta_iteration: Any) -> bool:
        if meta_iteration is None:
            return True
        try:
            return int(meta_iteration) == current_iteration
        except (ValueError, TypeError):
            return True

    historical_rows = _filter_historical_tool_results_for_artifact_context(
        state.get("tool_results", [])
    )
    if dep_step_ids:
        historical_rows = [
            r for r in historical_rows
            if isinstance(r.metadata, dict)
            and (
                r.metadata.get("act_step_id") in dep_step_ids
                or r.metadata.get("source_step_id") in dep_step_ids
            )
        ]
    else:
        historical_rows = [
            r for r in historical_rows
            if not isinstance(r.metadata, dict)
            or _iter_matches(r.metadata.get("iteration"))
        ]
    recent_rows = list(historical_rows)
    if prior_results:
        recent_rows.extend(prior_results)
    recent_rows.extend(step_results)
    original_artifact_context = _build_act_artifact_context(recent_rows, runtime_context)
    artifact_context = _compact_act_artifact_context(original_artifact_context)
    step_memory = _build_step_memory(step_results, runtime_context)

    compact_transcript = _compact_act_transcript(step_transcript)
    act_messages = list(step_system_messages)
    act_messages.extend(compact_transcript)

    short_term_budget_text = ""
    if memory_system and hasattr(memory_system, "format_short_term_budget_prompt"):
        try:
            short_term_budget_text = str(
                await memory_system.format_short_term_budget_prompt(state["session_id"])
            )
        except Exception as exc:
            logger.warning("act_short_term_budget_unavailable", extra={"error": str(exc)})

    act_user_content = build_per_turn_user_message(
        act_phase=act_phase,
        terminal_retry_count=terminal_retry_count,
        short_term_budget_text=short_term_budget_text,
        step_memory=step_memory,
        artifact_context=artifact_context,
        current_step_output_contract=_resolved_step_output_contract(action),
    )
    step_meta = get_step_runtime_state(state, str(action.id or ""), current_iteration)
    compression_messages, compression_signal = apply_context_compression(
        act_phase=act_phase,
        original_transcript_len=len(step_transcript),
        compact_transcript_len=len(compact_transcript),
        original_artifact_count=len(original_artifact_context),
        compact_artifact_count=len(artifact_context),
        last_runtime_signal=step_meta.get("loop_guard", {}).get("last_loop_signal"),
    )
    act_messages.extend(compression_messages)
    act_messages.append({"role": "user", "content": _truncate_act_prompt_text(act_user_content)})
    return act_messages, artifact_context, step_memory, short_term_budget_text, compression_signal
