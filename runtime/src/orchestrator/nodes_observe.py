"""Observe-domain helper functions for orchestrator nodes."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from src.constants import MAX_REPLAN_ATTEMPTS
from src.orchestrator.nodes_shared import (
    _collect_visible_artifacts,
    _current_round_skill_id,
    _final_delivery_contract_fulfilled,
    _infer_artifact_semantics,
    _iter_generated_files_from_result,
    _is_non_retryable_readonly_api_failure,
    _is_readonly_network_tool_result,
    _is_transient_readonly_network_failure,
    _tool_result_error_text,
    _tool_result_success,
)
from src.orchestrator.nodes_stateflow import _build_execution_state_for_planner
from src.orchestrator.state import AgentState, ExecutionPlan, Message, ToolCallResult
from src.utils.logging import get_logger

logger = get_logger(__name__)


def _build_failure_reflection(
    *,
    tool_results: list[ToolCallResult | dict[str, Any]],
    current_skill_name: str = "",
) -> str:
    observed_failures: list[str] = []
    non_capability_lines: list[str] = []
    do_not_repeat: list[str] = []
    capability_gap = "not established in this round"
    successful_generated_files: list[str] = []
    has_pending_approval = False

    for result in tool_results:
        success = bool(result.get("success")) if isinstance(result, dict) else bool(result.success)
        tool_name = str(result.get("tool_name") or "unknown") if isinstance(result, dict) else str(result.tool_name or "unknown")
        if success:
            for generated in _iter_generated_files_from_result(result):
                source_path = str(generated.get("source_path") or generated.get("path") or "").strip()
                if source_path:
                    successful_generated_files.append(source_path)
            continue

        error_text = _tool_result_error_text(result) or "unknown error"
        payload = result if isinstance(result, dict) else {
            "result": getattr(result, "result", None),
            "metadata": getattr(result, "metadata", None),
        }
        tool_result = payload.get("result") if isinstance(payload, dict) else None
        metadata = payload.get("metadata") if isinstance(payload, dict) else None
        excerpt = ""
        candidates: list[str] = []
        if isinstance(tool_result, dict):
            for key in ("stderr", "stdout", "preview", "message"):
                value = tool_result.get(key)
                if isinstance(value, str) and value.strip():
                    candidates.append(value.strip())
        if isinstance(metadata, dict):
            for key in ("stderr", "stdout", "preview"):
                value = metadata.get(key)
                if isinstance(value, str) and value.strip():
                    candidates.append(value.strip())
        for raw in candidates:
            compact = " ".join(raw.split())
            if compact:
                excerpt = compact[:280]
                break
        if excerpt and excerpt.lower() not in error_text.lower():
            observed_failures.append(f"- {tool_name}: {error_text}; details: {excerpt}")
        else:
            observed_failures.append(f"- {tool_name}: {error_text}")

        lowered = error_text.lower()
        if "approval_pending" in lowered or "status: pending" in lowered or "need manual approval" in lowered:
            has_pending_approval = True
            do_not_repeat.append("- Do not treat pending approval as approval_denied or as a missing capability.")
        if "file not found" in lowered:
            non_capability_lines.append("- This does not prove a missing capability; it indicates artifact path handoff failed.")
            do_not_repeat.append("- Do not read a session artifact by bare filename if a generated file path is available.")
        if any(token in lowered for token in ("pdf", ".pdf")) and any(token in lowered for token in ("markdown", ".md", "report")):
            non_capability_lines.append("- This does not prove a missing capability; it indicates the wrong artifact type was passed to a script.")
            do_not_repeat.append("- Do not pass PDF/JSON artifacts to a script that expects a markdown/text report.")
        if "script target not found" in lowered or "must reference a script file under scripts/" in lowered:
            non_capability_lines.append("- This does not prove a missing capability; it indicates the plan invented an invalid script command.")
            do_not_repeat.append("- Do not invent new skill script paths or shell commands that are not grounded in the current skill.")
        if any(token in lowered for token in ("not configured", "no available tool", "unsupported capability", "missing capability")):
            capability_gap = "possible but unproven in this round"

    if successful_generated_files:
        non_capability_lines.append("- At least one artifact was generated successfully in this round.")
        markdown_artifacts = [path for path in successful_generated_files if path.lower().endswith((".md", ".markdown", ".txt"))]
        if markdown_artifacts:
            non_capability_lines.append("- A markdown/text artifact is already available and should be treated as the primary report source.")

    if not observed_failures:
        observed_failures.append("- No explicit tool failure was recorded in this round.")

    if not non_capability_lines:
        non_capability_lines.append("- The observed failures do not yet establish a missing capability.")

    if not do_not_repeat:
        do_not_repeat.append("- Do not repeat the exact same failing plan pattern without a concrete change in artifact usage, parameters, or tool choice.")

    do_not_repeat.append("- Do not switch to meta-skills only because the current round failed.")

    requirements: list[str] = []
    if current_skill_name:
        requirements.append(
            f"- Stay within the current round skill context '{current_skill_name}' unless a true capability gap is strongly evidenced."
        )
        requirements.append(
            "- Preserve the current round's skill methodology and carry forward only the round-relevant execution constraints."
        )
    requirements.append("- Prefer markdown/text as the primary report artifact; treat HTML/PDF as derived artifacts.")
    if successful_generated_files:
        requirements.append("- Reuse existing successful artifacts if they are valid inputs for the next step.")
    if has_pending_approval:
        requirements.append("- If an approval is pending, do not reinterpret it as a tool failure or capability gap.")
    requirements.append("- Only consider meta-skills if repeated failures indicate a true missing capability rather than wrong parameters, wrong paths, wrong artifact types, or pending approvals.")

    reflection_lines = [
        "[SYSTEM] FAILURE REFLECTION",
        "",
        "Observed Failures",
        *observed_failures,
        "",
        "What This Does NOT Mean",
        *non_capability_lines,
        "",
        "Do Not Repeat",
        *do_not_repeat,
        "",
        "Capability Gap Hypothesis",
        f"- {capability_gap}",
        "",
        "Requirements For The Next Plan",
        *requirements,
    ]
    return "\n".join(reflection_lines)


def _build_replan_failure_details(
    *,
    tool_results: list[ToolCallResult | dict[str, Any]],
    metadata: dict[str, Any],
    failure_pattern: dict[str, Any] | None = None,
) -> dict[str, Any]:
    step_id = ""
    act_decision = ""
    step_index: int | None = None
    if isinstance(failure_pattern, dict):
        step_id = str(failure_pattern.get("step_id") or "").strip()
        act_decision = str(failure_pattern.get("act_decision") or "").strip()
        raw_step_index = failure_pattern.get("step_index")
        if isinstance(raw_step_index, int):
            step_index = raw_step_index
    if not step_id:
        step_id = str(metadata.get("last_act_step_id") or "").strip()

    act_trace_map = metadata.get("act_loop_trace_by_step") if isinstance(metadata.get("act_loop_trace_by_step"), dict) else {}
    step_trace = act_trace_map.get(step_id) if step_id else None
    if not isinstance(step_trace, list):
        step_trace = []

    transcript_map = metadata.get("step_transcripts") if isinstance(metadata.get("step_transcripts"), dict) else {}
    step_transcript = transcript_map.get(step_id) if step_id else None
    if not isinstance(step_transcript, list):
        step_transcript = []

    assistant_transcript_excerpt: list[str] = []
    for item in step_transcript:
        if not isinstance(item, dict):
            continue
        if str(item.get("role") or "").strip() != "assistant":
            continue
        content = str(item.get("content") or "").strip()
        if content:
            assistant_transcript_excerpt.append(content[:2000])
    raw_terminal_response_excerpt = assistant_transcript_excerpt[-1] if assistant_transcript_excerpt else None

    failed_tool_results: list[dict[str, Any]] = []
    for result in tool_results:
        success = bool(result.get("success")) if isinstance(result, dict) else bool(result.success)
        if success:
            continue
        tool_name = str(result.get("tool_name") or "unknown") if isinstance(result, dict) else str(result.tool_name or "unknown")
        error_text = _tool_result_error_text(result) or "unknown error"
        item: dict[str, Any] = {
            "tool_name": tool_name,
            "error": error_text[:500],
        }
        metadata_dict = result.get("metadata") if isinstance(result, dict) else result.metadata
        if isinstance(metadata_dict, dict):
            payload_summary = metadata_dict.get("payload_summary")
            if isinstance(payload_summary, dict):
                item["payload_summary"] = payload_summary
        failed_tool_results.append(item)

    return {
        "failed_step_id": step_id or None,
        "last_act_step_id": str(metadata.get("last_act_step_id") or "").strip() or None,
        "act_decision": act_decision or None,
        "step_index": step_index,
        "failure_pattern": failure_pattern if isinstance(failure_pattern, dict) else None,
        "act_loop_trace": step_trace[-20:],
        "assistant_transcript_excerpt": assistant_transcript_excerpt[-3:],
        "raw_terminal_response_excerpt": raw_terminal_response_excerpt,
        "failed_tool_results": failed_tool_results[:6],
    }


def _summarize_observe_reason(
    *,
    outcome: str,
    latest_structured_act_result: ToolCallResult | None = None,
    next_actions: list[Any] | None = None,
    current_skill_name: str = "",
) -> str:
    prefix = f"{current_skill_name}: " if current_skill_name else ""
    if outcome == "awaiting_approval":
        return prefix + "waiting for user approval before continuing"
    if outcome == "task_completed":
        return prefix + "task is complete; no further execution is needed"
    if outcome != "continue_execution":
        return prefix + "planner is revisiting the current round"

    if latest_structured_act_result and isinstance(latest_structured_act_result.metadata, dict):
        meta = latest_structured_act_result.metadata
        act_decision = str(meta.get("act_decision") or "").strip().lower()
        observations = [
            str(item.get("summary") or "").strip()
            for item in (meta.get("act_observations") or [])
            if isinstance(item, dict) and str(item.get("summary") or "").strip()
        ]
        artifacts = [
            str(item or "").strip()
            for item in (meta.get("act_artifacts_produced") or [])
            if str(item or "").strip()
        ]
        if act_decision in {"advance_step", "continue_current_step"}:
            if artifacts:
                return prefix + (
                    "current step produced intermediate artifacts but the task is not complete; "
                    f"continuing with remaining work. Artifacts: {', '.join(artifacts[:3])}"
                )
            if observations:
                return prefix + (
                    "current step made partial progress but more work remains; "
                    f"latest observation: {observations[0]}"
                )
    if next_actions:
        return prefix + (
            "current plan still has remaining work; continuing with "
            + ", ".join(str(getattr(step, "title", "") or getattr(step, "id", "") or "next step") for step in next_actions[:3])
        )
    return prefix + "current round made progress but more work remains"


def _build_observe_progress_signature(
    *,
    current_skill_name: str,
    tool_results: list[ToolCallResult | dict[str, Any]],
    plan: ExecutionPlan | None,
    pending_actions: list[Any] | None = None,
) -> dict[str, Any]:
    failed_rows: list[str] = []
    success_tools: list[str] = []
    normalized_results: list[ToolCallResult] = []

    for row in tool_results[-6:]:
        if isinstance(row, dict):
            normalized = ToolCallResult(
                tool_name=str(row.get("tool_name") or "unknown"),
                params=row.get("params") or {},
                result=row.get("result"),
                success=bool(row.get("success")),
                error=str(row.get("error") or ""),
                metadata=row.get("metadata") or {},
            )
        else:
            normalized = row
        normalized_results.append(normalized)
        if normalized.success:
            success_tools.append(str(normalized.tool_name or "unknown"))
        else:
            failed_rows.append(f"{normalized.tool_name or 'unknown'}:{_tool_result_error_text(normalized)[:160]}")

    remaining_titles: list[str] = []
    if plan and plan.steps:
        source_steps = pending_actions if pending_actions else plan.steps
        for step in source_steps[:4]:
            remaining_titles.append(str(step.title or step.id or ""))

    artifacts: list[dict[str, Any]] = []
    for row in normalized_results:
        metadata = row.metadata or {}
        generated = metadata.get("generated_files")
        if isinstance(generated, list):
            for item in generated:
                if not isinstance(item, dict) or item.get("user_visible", True) is False:
                    continue
                artifact = dict(item)
                path_value = str(
                    artifact.get("artifact_result_path")
                    or artifact.get("source_path")
                    or artifact.get("path")
                    or ""
                ).strip()
                if path_value:
                    artifact["artifact_result_path"] = path_value
                if not artifact.get("artifact_medium"):
                    artifact["artifact_medium"] = "file"
                if not artifact.get("artifact_format"):
                    suffix = Path(
                        str(artifact.get("filename") or artifact.get("path") or "")
                    ).suffix.lower().lstrip(".")
                    artifact["artifact_format"] = suffix or "binary"
                if not artifact.get("artifact_type"):
                    inferred = _infer_artifact_semantics(
                        Path(path_value or str(artifact.get("filename") or artifact.get("path") or "artifact")),
                        str(artifact.get("artifact_role") or ""),
                    )
                    artifact["artifact_type"] = inferred.get("artifact_type")
                    artifact["artifact_name"] = artifact.get("artifact_name") or inferred.get("artifact_name")
                    artifact["artifact_purpose"] = artifact.get("artifact_purpose") or inferred.get("artifact_purpose")
                    artifact["is_likely_final"] = bool(
                        artifact.get("is_likely_final", inferred.get("is_likely_final", False))
                    )
                artifacts.append(artifact)
        text_artifact = metadata.get("text_artifact")
        if isinstance(text_artifact, dict):
            text_value = str(text_artifact.get("artifact_result_text") or "").strip()
            if not text_value or text_artifact.get("user_visible", True) is False:
                continue
            artifact = dict(text_artifact)
            artifact.setdefault("artifact_medium", "text")
            artifact.setdefault("artifact_format", "plain_text")
            artifact.setdefault("artifact_role", "text")
            artifact.setdefault("artifact_type", "text_output")
            artifact.setdefault("artifact_name", "text output")
            artifact.setdefault("artifact_purpose", "text output artifact")
            if bool(artifact.get("is_likely_final")):
                artifacts.append(artifact)

    artifact_names = [
        str(item.get("artifact_name") or item.get("filename") or item.get("artifact_result_path") or "").strip()
        for item in artifacts[:6]
        if str(item.get("artifact_name") or item.get("filename") or item.get("artifact_result_path") or "").strip()
    ]

    return {
        "skill": current_skill_name,
        "failures": failed_rows,
        "success_tools": success_tools,
        "remaining_titles": remaining_titles,
        "artifacts": artifact_names,
    }


def _build_observe_failure_pattern(
    *,
    blocking_failures: list[ToolCallResult | dict[str, Any]],
    latest_structured_act_result: ToolCallResult | None,
    metadata: dict[str, Any],
    plan: ExecutionPlan | None,
) -> dict[str, Any]:
    act_step_id = ""
    act_decision = ""
    if latest_structured_act_result and isinstance(latest_structured_act_result.metadata, dict):
        act_step_id = str(latest_structured_act_result.metadata.get("act_step_id") or "").strip()
        act_decision = str(latest_structured_act_result.metadata.get("act_decision") or "").strip().lower()
    if not act_step_id:
        act_step_id = str(metadata.get("last_act_step_id") or "").strip()
    rows: list[str] = []
    for result in blocking_failures[:6]:
        tool_name = str(result.get("tool_name") or "unknown") if isinstance(result, dict) else str(result.tool_name or "unknown")
        error_text = _tool_result_error_text(result) or "unknown error"
        rows.append(f"{tool_name}:{error_text[:200]}")
    return {
        "step_id": act_step_id,
        "act_decision": act_decision,
        "step_index": next(
            (i for i, s in enumerate(plan.steps) if str(s.id or "").strip() == act_step_id),
            None,
        ) if isinstance(plan, ExecutionPlan) and plan.steps and act_step_id else None,
        "failures": rows,
    }


async def observe_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    logger.info(
        "Observing results",
        extra={
            "session_id": state["session_id"],
            "result_count": len(state["tool_results"]),
        },
    )

    event_emitter = context.get("event_emitter")
    if event_emitter:
        await event_emitter.emit_thinking("正在分析执行结果...", "reasoning")

    config = context.get("config", {})
    max_iterations = config.get("max_iterations", 15)
    metadata = dict(state.get("metadata") or {})
    plan = state.get("plan")
    current_skill_name = _current_round_skill_id(state)
    current_iteration = state["iteration"] + 1
    failure_pattern: dict[str, Any] | None = None

    # --- Replan helper (closure over local state) ---
    async def _return_replan(
        *,
        extra_messages: list[Message] | None = None,
    ) -> dict[str, Any]:
        # Only report blocking failures (not intermediate errors that ACT
        # already handled).  ``blocking_failures`` is computed in the outer
        # scope before this closure is invoked.
        reflection_text = _build_failure_reflection(
            tool_results=blocking_failures,
            current_skill_name=current_skill_name,
        )
        if event_emitter and reflection_text:
            try:
                await event_emitter.emit(
                    "failure_reflection",
                    {
                        "session_id": state["session_id"],
                        "content": reflection_text,
                    },
                )
            except Exception:
                logger.warning(
                    "failure_reflection_emit_failed",
                    extra={"session_id": state["session_id"]},
                    exc_info=True,
                )
        reflection_msg = Message(role="system", content=reflection_text, name=None, tool_call_id=None)
        failed_lines: list[str] = []
        for result in blocking_failures:
            tool_name = str(result.get("tool_name") or "unknown") if isinstance(result, dict) else str(result.tool_name or "unknown")
            error_text = _tool_result_error_text(result) or "unknown error"
            failed_lines.append(f"{tool_name}: {error_text}")
        if failed_lines:
            prefix = f"{current_skill_name}: " if current_skill_name else ""
            metadata["replan_reason"] = prefix + "; ".join(failed_lines[:4])
        elif current_skill_name:
            metadata["replan_reason"] = f"{current_skill_name}: current round requires replanning"
        else:
            metadata["replan_reason"] = "current round requires replanning"
        metadata["observe_outcome"] = "replan_current_round"
        metadata["observe_reason"] = str(metadata.get("replan_reason") or "").strip()
        metadata["replan_failure_reflection"] = reflection_text
        metadata["replan_failure_details"] = _build_replan_failure_details(
            tool_results=blocking_failures,
            metadata=metadata,
            failure_pattern=failure_pattern if isinstance(failure_pattern, dict) else None,
        )
        return {
            "iteration": current_iteration,
            "metadata": metadata,
            "execution_state": _build_execution_state_for_planner({**state, "metadata": metadata}, prefer_existing=False),
            "messages": [reflection_msg, *(extra_messages or [])],
            "current_step": "plan",
            "observe_outcome": "replan_current_round",
        }

    # --- Derive current_tool_results ---
    tool_results = state["tool_results"]
    if not tool_results:
        current_tool_results = []
    else:
        result_count = metadata.get("last_act_result_count") if isinstance(metadata, dict) else None
        if not isinstance(result_count, int) or result_count <= 0 or result_count >= len(tool_results):
            current_tool_results = list(tool_results)
        else:
            current_tool_results = list(tool_results[-result_count:])

    # --- Derive act terminal decision first (needed for blocking_failures) ---
    latest_structured_act_result = next(
        (
            result
            for result in reversed(current_tool_results)
            if isinstance(getattr(result, "metadata", None), dict)
            and (
                str(result.metadata.get("act_decision") or "").strip().lower()
                in {"continue_current_step", "advance_step", "complete_task"}
                or str(result.metadata.get("act_result_type") or "").strip().lower() in {"execution_result", "execution_blocked"}
            )
        ),
        None,
    )
    act_terminal_decision_value = (
        str(getattr(latest_structured_act_result, "metadata", {}).get("act_decision") or "").strip().lower()
        if latest_structured_act_result is not None
        else ""
    )
    # Any terminal decision from ACT means the LLM has seen and absorbed
    # intermediate tool failures (e.g. transient ReadTimeout).  Observe should
    # trust that decision and NOT re-surface those intermediate errors.
    # However, if the terminal result itself failed (e.g. JSON parse error),
    # the decision is unreliable and we fall through to inspect results.
    act_produced_terminal_decision = (
        act_terminal_decision_value in {
            "advance_step",
            "complete_task",
            "continue_current_step",
        }
        and _tool_result_success(latest_structured_act_result)
    )

    # --- Compute blocking_failures ---
    # Core principle: observe judges act by its FINAL output, not intermediate
    # tool calls.  When act LLM already made a terminal decision (advance_step /
    # complete_task), it has seen and absorbed any mid-loop failures.  Observe
    # should trust that decision and not re-surface those intermediate errors.
    blocking_failures: list[ToolCallResult | dict[str, Any]] = []
    if act_produced_terminal_decision:
        # Act decided the step is done — no intermediate failures are blocking.
        logger.debug(
            "observe_trust_act_terminal_decision",
            extra={
                "session_id": state["session_id"],
                "act_decision": str(latest_structured_act_result.metadata.get("act_decision") or ""),
                "total_results": len(current_tool_results),
                "failed_count": sum(1 for r in current_tool_results if not _tool_result_success(r)),
            },
        )
    else:
        # Act did NOT produce a terminal decision (e.g. hit max turns, budget
        # exceeded).  Fall back to inspecting individual results.
        readonly_success_exists = any(
            _tool_result_success(row) and _is_readonly_network_tool_result(row)
            for row in current_tool_results
        )
        for row in current_tool_results:
            if _tool_result_success(row):
                continue
            if readonly_success_exists and _is_readonly_network_tool_result(row):
                continue
            blocking_failures.append(row)
    has_errors = bool(blocking_failures)
    # all_failed is derived from blocking_failures, not raw current_tool_results,
    # so that intermediate errors absorbed by ACT don't trigger all-failed replan.
    all_failed = (
        bool(blocking_failures)
        and not any(_tool_result_success(r) for r in current_tool_results)
    ) if current_tool_results else False

    approval_ids: list[str] = []
    for result in current_tool_results:
        meta = getattr(result, "metadata", None)
        if not isinstance(meta, dict):
            continue
        status = str(meta.get("approval_status") or "").strip().lower()
        approval_id = str(meta.get("approval_id") or "").strip()
        if status == "pending" and approval_id:
            approval_ids.append(approval_id)
    pending_approval_ids = list(dict.fromkeys(approval_ids))

    effective_act_decision = ""
    next_actions = state.get("pending_actions") or []
    if latest_structured_act_result is not None:
        act_metadata = latest_structured_act_result.metadata
        effective_act_decision = str(act_metadata.get("act_decision") or "").strip().lower()
        act_concerns = str(act_metadata.get("execution_concerns") or "").strip()
        if act_concerns:
            logger.info(
                "observe_act_execution_concerns",
                extra={
                    "session_id": state["session_id"],
                    "step_id": str(act_metadata.get("act_step_id") or ""),
                    "execution_concerns": act_concerns[:500],
                },
            )

    # --- Loop guard ---
    progress_signature = _build_observe_progress_signature(
        current_skill_name=current_skill_name,
        tool_results=current_tool_results,
        plan=state.get("plan"),
        pending_actions=state.get("pending_actions"),
    )
    loop_guard = metadata.get("observe_loop_guard") if isinstance(metadata, dict) else None
    last_signature = loop_guard.get("last_signature") if isinstance(loop_guard, dict) else None
    repeat_count = int(loop_guard.get("repeat_count") or 0) if isinstance(loop_guard, dict) else 0
    repeat_count = repeat_count + 1 if last_signature == progress_signature else 1
    failure_pattern = _build_observe_failure_pattern(
        blocking_failures=blocking_failures,
        latest_structured_act_result=latest_structured_act_result,
        metadata=metadata,
        plan=plan if isinstance(plan, ExecutionPlan) else None,
    )
    last_failure_pattern = (
        loop_guard.get("last_failure_pattern") if isinstance(loop_guard, dict) else None
    )
    failure_repeat_count = int(loop_guard.get("failure_repeat_count") or 0) if isinstance(loop_guard, dict) else 0
    if bool(blocking_failures):
        failure_repeat_count = failure_repeat_count + 1 if last_failure_pattern == failure_pattern else 1
    else:
        failure_repeat_count = 0
    metadata["observe_loop_guard"] = {
        "last_signature": progress_signature,
        "repeat_count": repeat_count,
        "last_failure_pattern": failure_pattern if blocking_failures else None,
        "failure_repeat_count": failure_repeat_count,
    }

    transient_network_retry_count = int(metadata.get("transient_network_retry_count") or 0)
    transient_network_retry_limit = min(max(2, MAX_REPLAN_ATTEMPTS), 3)
    if bool(blocking_failures) and all(_is_transient_readonly_network_failure(result) for result in blocking_failures):
        transient_network_retry_count += 1
        metadata["transient_network_retry_count"] = transient_network_retry_count
    else:
        metadata["transient_network_retry_count"] = 0

    # --- Build context and evaluate decision table ---
    from src.orchestrator.observe_decisions import ObserveContext, evaluate_observe_decisions

    obs_ctx = ObserveContext(
        state=state,
        metadata=metadata,
        current_iteration=current_iteration,
        max_iterations=max_iterations,
        current_skill_name=current_skill_name,
        current_tool_results=current_tool_results,
        blocking_failures=blocking_failures,
        has_errors=has_errors,
        all_failed=all_failed,
        pending_approval_ids=pending_approval_ids,
        latest_structured_act_result=latest_structured_act_result,
        effective_act_decision=effective_act_decision,
        next_actions=next_actions,
        plan=plan if isinstance(plan, ExecutionPlan) else None,
        failure_repeat_count=failure_repeat_count,
        transient_network_retry_count=transient_network_retry_count,
        transient_network_retry_limit=transient_network_retry_limit,
    )

    outcome = evaluate_observe_decisions(obs_ctx)

    # --- Translate outcome into return dict ---
    if outcome.needs_replan:
        result = await _return_replan(extra_messages=outcome.extra_messages)
        if outcome.execution_state_override is not None:
            result["execution_state"] = outcome.execution_state_override
        return result

    metadata["observe_outcome"] = outcome.observe_outcome
    metadata["observe_reason"] = _summarize_observe_reason(
        outcome=outcome.observe_outcome,
        latest_structured_act_result=latest_structured_act_result,
        next_actions=next_actions if outcome.observe_outcome == "continue_execution" else None,
        current_skill_name=current_skill_name,
    )

    result_dict: dict[str, Any] = {
        "iteration": current_iteration,
        "metadata": metadata,
        "execution_state": (
            outcome.execution_state_override
            if outcome.execution_state_override is not None
            else _build_execution_state_for_planner(state, prefer_existing=False)
        ),
        "current_step": outcome.current_step,
        "observe_outcome": outcome.observe_outcome,
    }

    if outcome.observe_outcome == "awaiting_approval":
        result_dict["metadata"] = {**metadata, "pending_approval_ids": pending_approval_ids}

    if outcome.extra_messages and not outcome.needs_replan:
        result_dict["messages"] = outcome.extra_messages

    if outcome.error:
        result_dict["error"] = outcome.error

    if outcome.plan_override is not None:
        result_dict["plan"] = outcome.plan_override

    if outcome.pending_actions_override is not None:
        result_dict["pending_actions"] = outcome.pending_actions_override

    return result_dict

