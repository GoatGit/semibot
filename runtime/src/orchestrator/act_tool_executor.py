"""ACT tool call execution, validation, and transcript helpers."""

import asyncio
import json
import time
import re as _re
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from src.orchestrator.nodes_plan import (
    _merge_dynamic_registry_schemas,
)
from src.orchestrator.nodes_respond import (
    _build_inline_delivery_fallback,
    _extract_search_results,
    _infer_delivery_language,
)
from src.orchestrator.nodes_shared import (
    _build_assistant_transcript_message,
    _is_transient_readonly_network_failure,
    _iter_generated_files_from_result,
    _parse_tool_call_arguments,
    _serialize_tool_backfeed_content,
)
from src.orchestrator.state import AgentState, PlanStep, ToolCallResult
from src.utils.logging import get_logger

logger = get_logger(__name__)

_READONLY_PARALLEL_TOOL_NAMES = {"search", "web_fetch"}
_READONLY_PARALLEL_HTTP_METHODS = {"GET", "HEAD", "OPTIONS"}
_MAX_PARALLEL_READONLY_TOOL_CALLS = 4

# Helpers extracted to sibling sub-modules.
from src.orchestrator.act_context import (
    _resolved_step_output_contract,
)
from src.orchestrator.act_terminal import (
    _build_text_artifact_payload,
)
from src.orchestrator.act_tool_injection import (
    _ENABLE_FRESHNESS_VALIDATION,
    _REAL_ARTIFACT_MARKERS,
    _code_executor_embeds_bound_text_for_summary_only,
    _extract_finance_focus_tokens,
    _filter_finance_search_results,
    _get_freshness_validation_flag,
    _has_same_step_search_provider_failures,
    _inject_context_data,
    _inject_file_io_session_artifacts,
    _is_finance_research_intent,
    _is_latest_research_intent,
    _prepare_artifact_aware_action,
    _search_query_contains_stale_year,
    _synthesize_artifacts_from_legacy,
)


def _code_executor_is_terminal_json_wrapper(code: str) -> bool:
    lower = str(code or "").lower()
    # Legacy decision keywords OR new artifact-based terminal markers.
    has_terminal_marker = (
        "continue_current_step" in lower
        or "advance_step" in lower
        or "complete_task" in lower
        or "execution_result" in lower
        or "execution_blocked" in lower
        or "artifact_result_text" in lower
        or "execution_concerns" in lower
    )
    if not has_terminal_marker:
        return False
    if "json.dumps" not in lower and "print(" not in lower:
        return False
    if any(marker in lower for marker in _REAL_ARTIFACT_MARKERS):
        return False
    return True


def _extract_generated_file_candidates(tool_results: list[ToolCallResult | dict[str, Any]]) -> list[str]:
    candidates: list[str] = []
    for result in tool_results:
        for item in _iter_generated_files_from_result(result):
            source_path = str(item.get("source_path") or "").strip()
            path = str(item.get("path") or "").strip()
            if source_path:
                candidates.append(source_path)
            if path:
                candidates.append(path)
    return candidates


def _find_latest_generated_report_path(
    prior_results: list[ToolCallResult | dict[str, Any]],
) -> str:
    generated_candidates = _extract_generated_file_candidates(prior_results)
    for candidate in reversed(generated_candidates):
        if candidate and Path(candidate).exists() and candidate.endswith((".md", ".markdown", ".txt")):
            return candidate

    for result in prior_results:
        payload = result.get("result") if isinstance(result, dict) else getattr(result, "result", None)
        stdout = payload.get("stdout") if isinstance(payload, dict) else None
        if not isinstance(stdout, str):
            continue
        match = _re.search(r"Report path:\s*(\S+\.(?:md|markdown|txt))", stdout, _re.IGNORECASE)
        if not match:
            continue
        candidate = str(match.group(1) or "").strip()
        if candidate and Path(candidate).exists():
            return candidate
    return ""


def _inject_skill_script_artifacts(
    action: PlanStep,
    prior_results: list[ToolCallResult | dict[str, Any]],
    session_id: str,
) -> None:
    params = action.params if isinstance(action.params, dict) else {}
    command = str(params.get("command") or "").strip()
    if not command or "--report" not in command:
        return
    report_path = _find_latest_generated_report_path(prior_results)
    if not report_path:
        return
    current = params.get("command")
    if not isinstance(current, str):
        return
    rewritten = _re.sub(
        r"(--report\s+)(\S+)",
        lambda m: f"{m.group(1)}{report_path}",
        current,
        count=1,
    )
    if rewritten != current:
        params["command"] = rewritten
        action.params = params
        logger.info(
            "skill_script_artifact_injected",
            extra={"session_id": session_id, "step_id": action.id, "path": report_path},
        )


def _bind_file_io_skill_scope(action: PlanStep, selected_skill_name: str) -> None:
    if str(action.tool or "").strip() != "file_io":
        return
    params = action.params if isinstance(action.params, dict) else {}
    if str(params.get("scope") or "").strip().lower() != "skill":
        return
    if not str(params.get("skill_name") or "").strip() and selected_skill_name:
        params["skill_name"] = selected_skill_name
        action.params = params


def _serialize_tool_result_payload(result: ToolCallResult) -> str:
    payload = {
        "success": bool(result.success),
        "tool_name": str(result.tool_name or ""),
        "params": result.params or {},
        "result": result.result,
        "error": result.error,
        "metadata": result.metadata or {},
    }
    try:
        return json.dumps(payload, ensure_ascii=False)
    except Exception:
        fallback = {
            "success": bool(result.success),
            "tool_name": str(result.tool_name or ""),
            "params": result.params or {},
            "result": str(result.result or ""),
            "error": str(result.error or ""),
            "metadata": result.metadata or {},
        }
        return json.dumps(fallback, ensure_ascii=False)


def _build_tool_transcript_message(
    *,
    tool_call_id: str,
    result: ToolCallResult,
) -> dict[str, Any]:
    # Priority 7: truncate tool result payload aggressively in the transcript.
    # Subsequent turns only need to know success/failure; full content is in
    # step_memory and artifact_context.
    payload: dict[str, Any] = {
        "success": bool(result.success),
        "tool_name": str(result.tool_name or ""),
        "params": result.params or {},
        "result": result.result,
        "error": result.error,
        "metadata": result.metadata or {},
    }
    # Truncation is handled structurally by _compact_prompt_payload inside
    # _serialize_tool_backfeed_content — no raw string slicing here, which
    # would break JSON structure and waste the structural compressor.
    return {
        "role": "tool",
        "tool_call_id": tool_call_id,
        "content": _serialize_tool_backfeed_content(
            tool_name=str(result.tool_name or ""),
            tool_call_id=tool_call_id,
            payload=payload,
        ),
    }


def _tool_call_is_readonly_parallel_safe(call: dict[str, Any]) -> bool:
    function = call.get("function") or {}
    tool_name = str(function.get("name") or "").strip().lower()
    if tool_name in _READONLY_PARALLEL_TOOL_NAMES:
        return True
    if tool_name != "http_client":
        return False
    params, error = _parse_tool_call_arguments(function.get("arguments"))
    if error is not None:
        return False
    method = str(params.get("method") or "GET").strip().upper() or "GET"
    return method in _READONLY_PARALLEL_HTTP_METHODS


def _build_act_tool_schemas(runtime_context: Any | None, skill_registry: Any | None) -> list[dict[str, Any]]:
    tool_schemas: list[dict[str, Any]] = []
    if runtime_context is not None:
        from src.orchestrator.capability import CapabilityGraph

        try:
            capability_graph = CapabilityGraph(runtime_context)
            tool_schemas = capability_graph.get_schemas_for_planner()
            tool_schemas = _merge_dynamic_registry_schemas(tool_schemas, runtime_context)
        except Exception:
            logger.warning("_build_act_tool_schemas: CapabilityGraph failed, falling back to empty schemas", exc_info=True)
            tool_schemas = []
    elif skill_registry is not None and hasattr(skill_registry, "get_tool_schemas"):
        try:
            raw = skill_registry.get_tool_schemas()
            if isinstance(raw, list):
                tool_schemas = [item for item in raw if isinstance(item, dict)]
        except Exception:
            logger.warning("_build_act_tool_schemas: skill_registry.get_tool_schemas failed", exc_info=True)
            tool_schemas = []
    return tool_schemas


def _validate_llm_act_tool_call(
    *,
    action: PlanStep,
    prior_results: list[ToolCallResult],
    current_step_results: list[ToolCallResult] | None,
    runtime_context: Any | None,
    latest_user_text: str = "",
    today: datetime | None = None,
) -> ToolCallResult | None:
    """Validate a single ACT tool call. Delegates to the declarative rule engine."""
    from src.orchestrator.act_tool_validators import validate_act_tool_call
    return validate_act_tool_call(
        action=action,
        prior_results=prior_results,
        current_step_results=current_step_results,
        runtime_context=runtime_context,
        latest_user_text=latest_user_text,
        today=today,
    )


def _summarize_generic_result_for_handoff(result: ToolCallResult) -> str:
    tool_name = str(getattr(result, "tool_name", "") or "").strip()
    if tool_name in {"code_executor", "file_io"}:
        return ""
    payload = result.result
    if isinstance(payload, dict):
        source_rows: list[dict[str, Any]] = []
        for key in ("items", "results"):
            rows = payload.get(key)
            if isinstance(rows, list):
                source_rows = [row for row in rows if isinstance(row, dict)]
                if source_rows:
                    break
        if source_rows:
            title_params = result.params or {}
            raw_queries = title_params.get("queries")
            if isinstance(raw_queries, list) and raw_queries:
                title = str(raw_queries[0] or "").strip()
            else:
                title = str(title_params.get("query") or title_params.get("task") or "").strip()
            title = title or "current request"
            return _build_inline_delivery_fallback(
                title=title,
                source_items=[
                    {
                        "title": str(item.get("title") or item.get("name") or "").strip() or f"Result {index}",
                        "url": str(item.get("url") or "").strip(),
                        "summary": str(item.get("snippet") or item.get("content") or item.get("summary") or "").strip(),
                    }
                    for index, item in enumerate(source_rows[:6], start=1)
                ],
                language=_infer_delivery_language(title),
            )
        for key in ("artifact_result_text", "summary", "preview", "content"):
            text = str(payload.get(key) or "").strip()
            if text:
                return text[:2000]
        with suppress(Exception):
            return json.dumps(payload, ensure_ascii=False)[:2000]
    text = str(payload or "").strip()
    return text[:2000] if text else ""


def _ensure_step_result_handoff_contract(action: PlanStep, result: ToolCallResult) -> ToolCallResult:
    metadata = dict(getattr(result, "metadata", None) or {})
    output_contract = _resolved_step_output_contract(action)
    metadata["output_contract"] = output_contract
    metadata["source_step_id"] = str(action.id or "").strip()
    metadata["source_step_title"] = str(action.title or "").strip()

    generated_files = metadata.get("generated_files")
    if isinstance(generated_files, list):
        normalized_files: list[dict[str, Any]] = []
        for item in generated_files:
            if not isinstance(item, dict):
                continue
            enriched = dict(item)
            enriched.setdefault("source_step_id", str(action.id or "").strip())
            enriched.setdefault("source_step_title", str(action.title or "").strip())
            enriched.setdefault("handoff_mode", output_contract.get("handoff_mode"))
            enriched.setdefault("handoff_purpose", output_contract.get("handoff_purpose"))
            if not str(enriched.get("artifact_role") or "").strip():
                enriched["artifact_role"] = str(output_contract.get("artifact_role") or "text")
            normalized_files.append(enriched)
        metadata["generated_files"] = normalized_files

    text_artifact = metadata.get("text_artifact")
    if isinstance(text_artifact, dict):
        enriched_text_artifact = dict(text_artifact)
        enriched_text_artifact.setdefault("source_step_id", str(action.id or "").strip())
        enriched_text_artifact.setdefault("source_step_title", str(action.title or "").strip())
        enriched_text_artifact.setdefault("artifact_role", str(output_contract.get("artifact_role") or "text"))
        enriched_text_artifact.setdefault("handoff_mode", output_contract.get("handoff_mode"))
        enriched_text_artifact.setdefault("handoff_purpose", output_contract.get("handoff_purpose"))
        metadata["text_artifact"] = enriched_text_artifact
        if not str(metadata.get("artifact_result_text") or "").strip():
            metadata["artifact_result_text"] = str(enriched_text_artifact.get("artifact_result_text") or "").strip()

    if output_contract.get("must_produce_text") and not str(metadata.get("artifact_result_text") or "").strip():
        summary_text = _summarize_generic_result_for_handoff(result)
        if summary_text:
            text_payload = _build_text_artifact_payload(action, summary_text)
            text_payload["artifact_role"] = str(output_contract.get("artifact_role") or text_payload.get("artifact_role") or "text")
            text_payload["handoff_mode"] = str(output_contract.get("handoff_mode") or text_payload.get("handoff_mode") or "reasoning_text")
            text_payload["handoff_purpose"] = str(output_contract.get("handoff_purpose") or text_payload.get("handoff_purpose") or "reasoning_continuation")
            metadata["text_artifact"] = text_payload
            metadata["artifact_result_text"] = text_payload.get("artifact_result_text")
            metadata["artifact_type"] = text_payload.get("artifact_type")
            metadata["artifact_medium"] = text_payload.get("artifact_medium")
            metadata["artifact_format"] = text_payload.get("artifact_format")
            metadata["artifact_name"] = text_payload.get("artifact_name")
            metadata["artifact_purpose"] = text_payload.get("artifact_purpose")

    has_text_handoff = bool(str(metadata.get("artifact_result_text") or "").strip())
    has_file_handoff = bool(
        (
            isinstance(metadata.get("generated_files"), list)
            and any(isinstance(item, dict) for item in metadata.get("generated_files"))
        )
        or str(metadata.get("artifact_result_path") or "").strip()
    )
    handoff_purpose = str(output_contract.get("handoff_purpose") or "").strip().lower()
    requires_text_handoff = bool(output_contract.get("must_produce_text"))
    if handoff_purpose == "user_delivery" and has_file_handoff:
        requires_text_handoff = False

    metadata["handoff_contract_satisfied"] = bool(
        (not requires_text_handoff) or has_text_handoff
    )

    result.metadata = metadata

    # Synthesize unified artifacts from legacy metadata fields so that
    # downstream consumers (observe, respond, stateflow) can use the
    # unified Artifact protocol without legacy fallback paths.
    if not result.artifacts:
        step_id = str(action.id or "").strip()
        result.artifacts = _synthesize_artifacts_from_legacy(metadata, step_id)

    return result


def _postprocess_execution_result(
    *,
    action: PlanStep,
    result: ToolCallResult,
    current_skill_name: str,
    latest_user_text: str,
) -> ToolCallResult:
    result = _ensure_step_result_handoff_contract(action, result)
    return result


async def _execute_with_events(
    executor: Any,
    action: PlanStep,
    event_emitter: Any | None,
    precomputed_result: ToolCallResult | None = None,
    result_postprocessor: Callable[[ToolCallResult], ToolCallResult] | None = None,
) -> ToolCallResult:
    """Execute a single action and emit events before/after."""
    start_ms = time.monotonic()

    # Pre-execution events
    if event_emitter:
        await event_emitter.emit_plan_step_start(action.id, action.title, action.tool, action.params)
        if action.tool:
            await event_emitter.emit_tool_call_start(action.tool, action.params)

    result: ToolCallResult = precomputed_result or await executor.execute(action)
    if callable(result_postprocessor):
        try:
            result = result_postprocessor(result)
        except Exception:
            logger.warning(
                "result_postprocessor_failed",
                extra={"session_id": getattr(action, "id", "")},
                exc_info=True,
            )
    duration_ms = int((time.monotonic() - start_ms) * 1000)

    # Post-execution events
    if event_emitter:
        if result.success:
            await event_emitter.emit_tool_call_complete(
                result.tool_name,
                result.result,
                True,
                duration=duration_ms,
                metadata=result.metadata,
            )
            await event_emitter.emit_plan_step_complete(
                action.id, action.title, result.result, duration_ms,
            )
        else:
            await event_emitter.emit_tool_call_complete(
                result.tool_name,
                result.result,
                False,
                error=result.error,
                duration=duration_ms,
                metadata=result.metadata,
            )
            # Don't emit plan_step_failed for transient network errors (e.g. search timeout)
            # — act absorbs these internally and lets the LLM adjust on the next turn.
            if not _is_transient_readonly_network_failure(result):
                await event_emitter.emit_plan_step_failed(action.id, action.title, result.error or "Unknown error")

        # Emit file_created events for any generated files
        generated_files = (result.metadata or {}).get("generated_files", [])
        logger.info(
            "[ACT] file_created check",
            extra={
                "tool_name": result.tool_name,
                "has_metadata": result.metadata is not None,
                "metadata_keys": list((result.metadata or {}).keys()),
                "generated_files_count": len(generated_files),
            },
        )
        for file_meta in generated_files:
            if not isinstance(file_meta, dict):
                continue
            if file_meta.get("user_visible", True) is False:
                continue
            if isinstance(file_meta, dict) and str(file_meta.get("artifact_role") or "").strip().lower() == "data_json":
                continue
            file_id = file_meta.get("file_id", "")
            await event_emitter.emit_file_created(
                file_id=file_id,
                filename=file_meta.get("filename", ""),
                mime_type=file_meta.get("mime_type", "application/octet-stream"),
                size=file_meta.get("size", 0),
                url=f"/api/v1/files/{file_id}",
            )

    return result


# ---------------------------------------------------------------------------
# Loop-level helpers called from the rewritten _execute_llm_act_step
# ---------------------------------------------------------------------------


async def execute_single_act_tool_call(
    call: dict[str, Any],
    *,
    state: AgentState,
    action: PlanStep,
    current_skill_id: str,
    runtime_context: Any | None,
    prior_results: list[ToolCallResult] | None,
    step_results: list[ToolCallResult],
    latest_user_text: str,
    unified_executor: Any,
    event_emitter: Any | None,
    current_step_snapshot: list[ToolCallResult],
) -> ToolCallResult:
    """Execute a single LLM-requested tool call with validation and events."""
    from src.orchestrator.act_terminal import _build_act_decision_event_payload
    from src.orchestrator.nodes_respond import _extract_search_results

    function = call.get("function") or {}
    tool_name = str(function.get("name") or "").strip()
    tool_params, tool_params_error = _parse_tool_call_arguments(function.get("arguments"))
    if event_emitter:
        await event_emitter.emit(
            "act_decision",
            _build_act_decision_event_payload(
                state=state,
                action=action,
                decision="tool_call",
                tool_name=tool_name,
                arguments=tool_params,
                selected_skill_name=current_skill_id,
            ),
        )
    if not tool_name:
        return ToolCallResult(
            tool_name="llm_act",
            params={"title": action.title},
            error="LLM act returned empty tool name",
            success=False,
        )
    if tool_params_error is not None:
        return ToolCallResult(
            tool_name=tool_name or "llm_act",
            params={"title": action.title},
            error=tool_params_error,
            success=False,
        )

    delegated_action = PlanStep(
        id=action.id,
        title=action.title,
        tool=tool_name,
        params=tool_params,
        parallel=False,
        skill_source=action.skill_source,
    )
    combined_prior_results = [*state.get("tool_results", []), *(prior_results or []), *step_results]
    _prepare_artifact_aware_action(
        delegated_action,
        prior_results=combined_prior_results,
        runtime_context=runtime_context,
        session_id=state["session_id"],
        selected_skill_name=current_skill_id,
    )
    if delegated_action.tool in {"xlsx", "pdf"} and combined_prior_results:
        search_results = _extract_search_results(combined_prior_results)
        _inject_context_data(
            delegated_action,
            search_results,
            state["session_id"],
            latest_user_text,
        )
    validation_failure = _validate_llm_act_tool_call(
        action=delegated_action,
        prior_results=combined_prior_results,
        current_step_results=current_step_snapshot,
        runtime_context=runtime_context,
        latest_user_text=latest_user_text,
        today=datetime.now(timezone.utc),
    )
    if validation_failure is not None:
        return validation_failure

    return await _execute_with_events(
        unified_executor,
        delegated_action,
        event_emitter,
        result_postprocessor=lambda result, _da=delegated_action: _postprocess_execution_result(
            action=_da,
            result=result,
            current_skill_name=current_skill_id,
            latest_user_text=latest_user_text,
        ),
    )


async def process_act_tool_call_chunks(
    *,
    response: Any,
    tool_calls: list[dict[str, Any]],
    state: AgentState,
    action: PlanStep,
    current_skill_id: str,
    runtime_context: Any | None,
    prior_results: list[ToolCallResult] | None,
    step_results: list[ToolCallResult],
    step_transcript: list[dict[str, Any]],
    act_loop_trace: list[dict[str, Any]],
    latest_user_text: str,
    unified_executor: Any,
    event_emitter: Any | None,
    turn_count: int,
    act_phase: str,
    tool_call_count: int,
    max_inner_turns: int,
    max_tool_calls_per_step: int,
) -> dict[str, Any]:
    """Process tool calls from an LLM response: validate budgets, chunk, execute.

    Returns a signal dict:
      {"action": "return"} — budget exceeded or guard failure, caller should return step_results
      {"action": "continue", "tool_call_count": N} — tool results backfed, continue loop
    """
    from src.orchestrator.act_context import (
        _persist_act_loop_trace_to_state,
        _persist_step_transcript_to_state,
    )

    act_loop_trace.append({
        "turn_index": turn_count,
        "phase": act_phase,
        "outcome": "tool_calls",
        "tool_count": len(tool_calls),
        "tool_names": [
            str(((call.get("function") or {}).get("name")) or "").strip()
            for call in tool_calls
        ],
    })
    _persist_act_loop_trace_to_state(state, action.id, act_loop_trace)

    remaining_budget = max_tool_calls_per_step - tool_call_count
    if turn_count >= max_inner_turns:
        step_results.append(
            ToolCallResult(
                tool_name="llm_act",
                params={
                    "title": action.title,
                    "requested_tool_calls": len(tool_calls),
                    "turn_count": turn_count,
                    "max_inner_turns": max_inner_turns,
                },
                error=f"Act inner loop exceeded {max_inner_turns} LLM decision turns for one step",
                success=False,
            )
        )
        return {"action": "return"}
    if remaining_budget <= 0:
        step_results.append(
            ToolCallResult(
                tool_name="llm_act",
                params={
                    "title": action.title,
                    "requested_tool_calls": len(tool_calls),
                    "remaining_budget": max(remaining_budget, 0),
                    "tool_call_count": tool_call_count,
                    "max_tool_calls_per_step": max_tool_calls_per_step,
                },
                error=f"Act inner loop exceeded {max_tool_calls_per_step} tool calls for one step",
                success=False,
            )
        )
        return {"action": "return"}
    if len(tool_calls) > remaining_budget:
        tool_calls = tool_calls[:remaining_budget]

    response_content = str(response.content or "").strip()
    assistant_content_sent = False
    use_parallel = (
        len(tool_calls) > 1
        and all(_tool_call_is_readonly_parallel_safe(call) for call in tool_calls)
    )
    tool_call_chunks = (
        [
            tool_calls[i: i + _MAX_PARALLEL_READONLY_TOOL_CALLS]
            for i in range(0, len(tool_calls), _MAX_PARALLEL_READONLY_TOOL_CALLS)
        ]
        if use_parallel
        else [[call] for call in tool_calls]
    )

    new_tool_call_count = tool_call_count
    for chunk in tool_call_chunks:
        step_transcript.append(
            _build_assistant_transcript_message(
                response_content=response_content if not assistant_content_sent else "",
                tool_calls=chunk,
                reasoning_content=(
                    getattr(response, "reasoning_content", None)
                    if not assistant_content_sent
                    else None
                ),
            )
        )
        assistant_content_sent = True
        _persist_step_transcript_to_state(state, action.id, step_transcript)
        current_step_snapshot = list(step_results)
        if use_parallel and len(chunk) > 1:
            execution_results = list(
                await asyncio.gather(
                    *[
                        execute_single_act_tool_call(
                            call,
                            state=state,
                            action=action,
                            current_skill_id=current_skill_id,
                            runtime_context=runtime_context,
                            prior_results=prior_results,
                            step_results=step_results,
                            latest_user_text=latest_user_text,
                            unified_executor=unified_executor,
                            event_emitter=event_emitter,
                            current_step_snapshot=current_step_snapshot,
                        )
                        for call in chunk
                    ]
                )
            )
        else:
            execution_results = [
                await execute_single_act_tool_call(
                    chunk[0],
                    state=state,
                    action=action,
                    current_skill_id=current_skill_id,
                    runtime_context=runtime_context,
                    prior_results=prior_results,
                    step_results=step_results,
                    latest_user_text=latest_user_text,
                    unified_executor=unified_executor,
                    event_emitter=event_emitter,
                    current_step_snapshot=current_step_snapshot,
                )
            ]
        for call, execution_result in zip(chunk, execution_results, strict=True):
            step_results.append(execution_result)
            new_tool_call_count += 1
            step_transcript.append(
                _build_tool_transcript_message(
                    tool_call_id=str(call.get("id") or ""),
                    result=execution_result,
                )
            )
        _persist_step_transcript_to_state(state, action.id, step_transcript)
        failed_results = [row for row in execution_results if not row.success]
        if failed_results:
            if any(
                isinstance(getattr(row, "metadata", None), dict)
                and row.metadata.get("guard") == "llm_act_validation"
                for row in failed_results
            ):
                return {"action": "return"}
            # Transient network errors (timeout, connection reset, etc.) on readonly
            # tools should NOT abort remaining chunks — let the LLM see the error in
            # the next turn and adjust.  Only break for non-transient failures.
            if not all(_is_transient_readonly_network_failure(r) for r in failed_results):
                break

    act_loop_trace.append({
        "turn_index": turn_count,
        "phase": act_phase,
        "outcome": "tool_results_backfed",
        "tool_call_count": new_tool_call_count,
    })
    _persist_act_loop_trace_to_state(state, action.id, act_loop_trace)
    return {"action": "continue", "tool_call_count": new_tool_call_count}
