"""ACT node and execution-domain helpers for orchestrator state machine."""

import asyncio
import inspect
import json
import os
import time
from contextlib import suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
import re as _re

from src.orchestrator.nodes_plan import (
    _is_abstract_reasoning_step,
    _latest_user_text_from_messages,
    _merge_dynamic_registry_schemas,
)
from src.orchestrator.nodes_respond import (
    _build_inline_delivery_fallback,
    _infer_delivery_language,
)
from src.orchestrator.nodes_shared import (
    _build_assistant_transcript_message,
    _current_round_skill_id,
    _iter_generated_files_from_result,
    _parse_tool_call_arguments,
    _serialize_tool_backfeed_content,
)
from src.orchestrator.nodes_stateflow import (
    _artifact_matches_input_ref,
    _build_act_artifact_context,
    _resolve_input_binding_from_artifact,
)
from src.orchestrator.state import AgentState, ExecutionPlan, PlanStep, ToolCallResult, resolve_time_context
from src.llm.provider_compat import resolve_act_execution_strategy
from src.utils.logging import get_logger

# --- Re-exports from act sub-modules (preserves backward-compatible import paths) ---
from src.orchestrator.act_context import (  # noqa: F401
    _assistant_tool_call_ids,
    _build_step_memory,
    _chunk_act_transcript,
    _compact_act_artifact_context,
    _compact_act_transcript,
    _filter_historical_tool_results_for_artifact_context,
    _format_loaded_resource_summary,
    _get_step_transcripts,
    _infer_text_artifact_type,
    _match_generated_artifact_reference,
    _normalize_workspace_rel_path,
    _parallel_step_group_is_safe,
    _paths_look_semantically_equivalent,
    _persist_act_loop_trace_to_state,
    _persist_step_transcript_to_state,
    _resolved_step_output_contract,
    _semantic_file_tokens,
    _set_step_transcript,
    _truncate_act_prompt_text,
    _truncate_act_message_content,
)
from src.orchestrator.act_terminal import (  # noqa: F401
    _act_response_format,
    _build_act_decision_event_payload,
    _build_llm_act_terminal_result,
    _build_text_artifact_payload,
    _parse_structured_json_object,
    _sanitize_loose_json_string_literals,
    _step_requires_interactive_browser,
    _structured_json_diagnostics,
    _terminal_result_allows_step_advance,
    _terminal_result_is_fake_partial_progress,
    finalize_act_terminal_result,
    validate_act_terminal_response,
)
from src.orchestrator.act_tool_executor import (  # noqa: F401
    _bind_file_io_skill_scope,
    _build_act_tool_schemas,
    _build_tool_transcript_message,
    _code_executor_embeds_bound_text_for_summary_only,
    _code_executor_is_terminal_json_wrapper,
    _ensure_step_result_handoff_contract,
    _execute_with_events,
    _extract_generated_file_candidates,
    _filter_finance_search_results,
    _find_latest_generated_report_path,
    _has_same_step_search_provider_failures,
    _inject_context_data,  # noqa: F401 - re-exported for backward-compatible imports/tests
    _inject_file_io_session_artifacts,
    _inject_skill_script_artifacts,
    _is_finance_research_intent,
    _is_latest_research_intent,
    _postprocess_execution_result,
    _prepare_artifact_aware_action,
    _search_query_contains_stale_year,
    _serialize_tool_result_payload,
    _summarize_generic_result_for_handoff,
    _tool_call_is_readonly_parallel_safe,
    _validate_llm_act_tool_call,
    execute_single_act_tool_call,
    process_act_tool_call_chunks,
    _ENABLE_FRESHNESS_VALIDATION as _ENABLE_FRESHNESS_VALIDATION,
    _READONLY_PARALLEL_TOOL_NAMES as _READONLY_PARALLEL_TOOL_NAMES,
    _READONLY_PARALLEL_HTTP_METHODS as _READONLY_PARALLEL_HTTP_METHODS,
    _MAX_PARALLEL_READONLY_TOOL_CALLS as _MAX_PARALLEL_READONLY_TOOL_CALLS,
)
from src.orchestrator.act_llm_caller import (  # noqa: F401
    build_act_system_messages,
    build_step_static_context,
    build_per_turn_user_message,
    handle_act_llm_error,
    handle_act_output_truncation,
)

logger = get_logger(__name__)

# ACT inner loop limits — configurable via env vars.
_MAX_INNER_TURNS = int(os.getenv("SEMIBOT_ACT_MAX_INNER_TURNS") or "30")
_MAX_TOOL_CALLS_PER_STEP = int(os.getenv("SEMIBOT_ACT_MAX_TOOL_CALLS_PER_STEP") or "50")


def _extract_cli_flag_assignments(args: list[str]) -> list[tuple[str, str]]:
    assignments: list[tuple[str, str]] = []
    idx = 0
    while idx < len(args):
        token = str(args[idx]).strip()
        if token.startswith("--") and "=" in token:
            flag, value = token.split("=", 1)
            assignments.append((flag, value.strip()))
            idx += 1
            continue
        if _re.fullmatch(r"--[a-zA-Z0-9][\w-]*|-\w", token) and idx + 1 < len(args):
            value = str(args[idx + 1]).strip()
            if value and not value.startswith("-"):
                assignments.append((token, value))
                idx += 2
                continue
        idx += 1
    return assignments


async def _execute_llm_act_step(
    *,
    state: AgentState,
    context: dict[str, Any],
    action: PlanStep,
    unified_executor: Any,
    event_emitter: Any | None,
    prior_results: list[ToolCallResult] | None = None,
) -> list[ToolCallResult]:
    llm_provider = context.get("llm_provider")
    runtime_context = state.get("context")
    skill_registry = context.get("skill_registry")
    if llm_provider is None:
        return [
            ToolCallResult(
                tool_name="llm_act",
                params={"title": action.title},
                error="LLM provider not configured for act",
                success=False,
            )
        ]

    current_skill_id = _current_round_skill_id(state, action)
    current_plan = state.get("plan")
    current_date, current_weekday, current_timezone = resolve_time_context(
        state.get("metadata"),
        current_plan if isinstance(current_plan, ExecutionPlan) else None,
        prefer_plan=True,
    )
    base_system_messages = build_act_system_messages(current_date, current_weekday, current_timezone)
    latest_user_text = _latest_user_text_from_messages(state.get("messages", []))
    memory_system = context.get("memory_system")

    _step_static = build_step_static_context(
        current_plan=current_plan,
        action=action,
        latest_user_text=latest_user_text,
        execution_state=state.get("execution_state"),
    )
    _step_system_messages: list[dict[str, Any]] = list(base_system_messages) + [
        {"role": "system", "content": _step_static}
    ]

    step_results: list[ToolCallResult] = []
    step_transcript = list(_get_step_transcripts(state.get("metadata") or {}).get(action.id, []))
    act_loop_trace: list[dict[str, Any]] = []
    max_inner_turns = _MAX_INNER_TURNS
    max_tool_calls_per_step = _MAX_TOOL_CALLS_PER_STEP
    turn_count = 0
    tool_call_count = 0
    act_phase = "tool"
    max_terminal_retries = 3
    terminal_retry_count = 0
    rate_limit_retry_count = 0
    max_rate_limit_retries = 3
    context_overflow_retry_count = 0
    max_context_overflow_retries = 2
    timeout_retry_count = 0
    max_timeout_retries = 2
    output_truncation_retry_count = 0
    max_output_truncation_retries = 2

    _current_iteration = int(state.get("iteration", 0))
    dep_step_ids: set[str] = {
        ref.source_step_id
        for ref in (action.input_refs or [])
        if ref.source_step_id
    }

    def _iter_matches(meta_iteration: Any) -> bool:
        if meta_iteration is None:
            return True
        try:
            return int(meta_iteration) == _current_iteration
        except (ValueError, TypeError):
            return True

    while True:
        # --- Artifact context ---
        historical_rows = _filter_historical_tool_results_for_artifact_context(
            state.get("tool_results", [])
        )
        historical_rows = [
            r for r in historical_rows
            if not isinstance(r.metadata, dict)
            or _iter_matches(r.metadata.get("iteration"))
        ]
        if dep_step_ids:
            historical_rows = [
                r for r in historical_rows
                if isinstance(r.metadata, dict)
                and (
                    r.metadata.get("act_step_id") in dep_step_ids
                    or r.metadata.get("source_step_id") in dep_step_ids
                )
            ]
        recent_rows = list(historical_rows)
        if prior_results:
            recent_rows.extend(prior_results)
        recent_rows.extend(step_results)
        artifact_context = _compact_act_artifact_context(_build_act_artifact_context(recent_rows, runtime_context))
        step_memory = _build_step_memory(step_results, runtime_context)

        # --- Build messages ---
        act_messages = list(_step_system_messages)
        act_messages.extend(_compact_act_transcript(step_transcript))

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
        )
        act_messages.append({"role": "user", "content": _truncate_act_prompt_text(act_user_content)})

        # --- Tool/model config ---
        if runtime_context is not None:
            metadata = getattr(runtime_context, "metadata", None)
            if isinstance(metadata, dict):
                metadata["_current_act_tool_query"] = " | ".join(
                    part
                    for part in [
                        str(action.title or "").strip(),
                        str(action.intent or "").strip(),
                        " ".join(str(item or "").strip() for item in (action.expected_outputs or []) if str(item or "").strip()),
                        str(latest_user_text or "").strip(),
                    ]
                    if part
                )
                observe_loop_guard = state.get("metadata", {}).get("observe_loop_guard") if isinstance(state.get("metadata"), dict) else None
                metadata["_current_act_failure_repeat_count"] = (
                    int(observe_loop_guard.get("failure_repeat_count") or 0)
                    if isinstance(observe_loop_guard, dict)
                    else 0
                )
        available_tools = _build_act_tool_schemas(runtime_context, skill_registry)
        agent_model = None
        act_temperature = 0.2
        if runtime_context and getattr(runtime_context, "agent_config", None):
            role_cfg = runtime_context.agent_config.model_roles.act
            agent_model = role_cfg.model or runtime_context.agent_config.model
            if role_cfg.temperature is not None:
                act_temperature = role_cfg.temperature
        act_strategy = resolve_act_execution_strategy(
            llm_provider=llm_provider,
            model=agent_model,
            terminal_response_format=_act_response_format(),
        )
        phase_tools = (available_tools or None) if act_phase == "tool" else None
        phase_response_format = (
            act_strategy.tool_phase_response_format
            if act_phase == "tool"
            else act_strategy.terminal_phase_response_format
        )

        # --- LLM call ---
        try:
            _act_llm_call_started = time.perf_counter()
            response = await llm_provider.chat(
                messages=act_messages,
                tools=phase_tools,
                temperature=act_temperature,
                response_format=phase_response_format,
                model=agent_model,
            )
            _act_llm_call_duration_ms = int((time.perf_counter() - _act_llm_call_started) * 1000)
        except Exception as llm_error:
            signal = handle_act_llm_error(
                llm_error=llm_error,
                state=state,
                action=action,
                step_transcript=step_transcript,
                step_results=step_results,
                act_loop_trace=act_loop_trace,
                turn_count=turn_count,
                act_phase=act_phase,
                rate_limit_retry_count=rate_limit_retry_count,
                max_rate_limit_retries=max_rate_limit_retries,
                context_overflow_retry_count=context_overflow_retry_count,
                max_context_overflow_retries=max_context_overflow_retries,
                timeout_retry_count=timeout_retry_count,
                max_timeout_retries=max_timeout_retries,
            )
            if signal["action"] == "return":
                return step_results
            rate_limit_retry_count = signal["rate_limit_retry_count"]
            context_overflow_retry_count = signal["context_overflow_retry_count"]
            timeout_retry_count = signal.get("timeout_retry_count", timeout_retry_count)
            if signal.get("step_transcript") is not None:
                step_transcript = signal["step_transcript"]
            if signal.get("backoff_seconds", 0) > 0:
                await asyncio.sleep(signal["backoff_seconds"])
            continue
        turn_count += 1

        # --- Usage emit ---
        raw_usage = getattr(response, "usage", {})
        _act_usage = dict(raw_usage) if isinstance(raw_usage, dict) else {}
        if event_emitter and _act_usage:
            await event_emitter.emit(
                "llm.usage",
                {
                    "session_id": state["session_id"],
                    "agent_id": state.get("agent_id"),
                    "node": "act",
                    "model": agent_model or None,
                    "prompt_tokens": int(_act_usage.get("prompt_tokens") or 0),
                    "completion_tokens": int(_act_usage.get("completion_tokens") or 0),
                    "total_tokens": int(_act_usage.get("total_tokens") or 0),
                    "duration_ms": _act_llm_call_duration_ms,
                    "step_id": str(action.id or ""),
                    "iteration": state.get("iteration", 0),
                },
            )

        # --- Output truncation ---
        trunc_signal = handle_act_output_truncation(
            response=response,
            state=state,
            action=action,
            step_transcript=step_transcript,
            step_results=step_results,
            act_loop_trace=act_loop_trace,
            turn_count=turn_count,
            act_phase=act_phase,
            output_truncation_retry_count=output_truncation_retry_count,
            max_output_truncation_retries=max_output_truncation_retries,
        )
        if trunc_signal["action"] == "return":
            return step_results
        if trunc_signal["action"] == "continue":
            output_truncation_retry_count = trunc_signal["output_truncation_retry_count"]
            if trunc_signal.get("step_transcript") is not None:
                step_transcript = trunc_signal["step_transcript"]
            continue

        # --- Tool calls ---
        if response.tool_calls:
            tc_signal = await process_act_tool_call_chunks(
                response=response,
                tool_calls=list(response.tool_calls or []),
                state=state,
                action=action,
                current_skill_id=current_skill_id,
                runtime_context=runtime_context,
                prior_results=prior_results,
                step_results=step_results,
                step_transcript=step_transcript,
                act_loop_trace=act_loop_trace,
                latest_user_text=latest_user_text,
                unified_executor=unified_executor,
                event_emitter=event_emitter,
                turn_count=turn_count,
                act_phase=act_phase,
                tool_call_count=tool_call_count,
                max_inner_turns=max_inner_turns,
                max_tool_calls_per_step=max_tool_calls_per_step,
            )
            if tc_signal["action"] == "return":
                return step_results
            tool_call_count = tc_signal["tool_call_count"]
            act_phase = "tool"
            continue

        # --- Two-phase transition ---
        if act_strategy.two_phase and act_phase == "tool":
            act_loop_trace.append({
                "turn_index": turn_count,
                "phase": act_phase,
                "outcome": "switch_to_terminal_phase",
                "reason": "two_phase_provider_no_tool_calls",
            })
            _persist_act_loop_trace_to_state(state, action.id, act_loop_trace)
            act_phase = "terminal"
            continue

        # --- Terminal validation ---
        term_signal = validate_act_terminal_response(
            response=response,
            state=state,
            action=action,
            step_transcript=step_transcript,
            step_results=step_results,
            act_loop_trace=act_loop_trace,
            turn_count=turn_count,
            act_phase=act_phase,
            terminal_retry_count=terminal_retry_count,
            max_terminal_retries=max_terminal_retries,
            tool_call_count=tool_call_count,
        )
        if term_signal["action"] == "return":
            return step_results
        if term_signal["action"] == "continue":
            act_phase = term_signal["act_phase"]
            terminal_retry_count = term_signal["terminal_retry_count"]
            continue

        # --- Terminal accepted: build result and return ---
        return await finalize_act_terminal_result(
            structured_payload=term_signal["structured_payload"],
            completion_text=term_signal["completion_text"],
            response=response,
            state=state,
            action=action,
            step_transcript=step_transcript,
            step_results=step_results,
            act_loop_trace=act_loop_trace,
            turn_count=turn_count,
            act_phase=act_phase,
            tool_call_count=tool_call_count,
            current_skill_id=current_skill_id,
            event_emitter=event_emitter,
        )


async def act_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    """
    ACT node: Execute pending actions (tool/skill calls).

    This node:
    1. Uses UnifiedActionExecutor (with RuntimeSessionContext)
    2. Supports parallel execution for independent actions
    3. Collects results and errors

    Args:
        state: Current agent state
        context: Injected dependencies (unified_executor, event_emitter, etc.)

    Returns:
        State updates with tool execution results
    """
    logger.info(
        "Executing actions",
        extra={
            "session_id": state["session_id"],
            "action_count": len(state["pending_actions"]),
        },
    )

    event_emitter = context.get("event_emitter")

    unified_executor = context.get("unified_executor") or context.get("action_executor")
    if not unified_executor:
        return {
            "error": "No executor configured",
            "current_step": "observe",
            "pending_actions": [],
        }

    pending_actions = state["pending_actions"]
    if not pending_actions:
        return {
            "current_step": "observe",
        }
    runtime_context = state.get("context")
    rewritten_count = 0
    if pending_actions:
        executable_names: set[str] = {
            "search",
            "web_fetch",
            "semi_browser",
            "code_executor",
            "file_io",
            "http_client",
            "control_plane",
            "rule_authoring",
            "skill_installer",
        }
        if runtime_context:
            metadata = getattr(runtime_context, "metadata", None)
            registry = metadata.get("skill_registry") if isinstance(metadata, dict) else None
            if registry is not None:
                try:
                    executable_names.update(str(name).strip() for name in registry.list_tools() if str(name).strip())
                except Exception:
                    logger.warning("_is_action_executable: registry.list_tools() failed", exc_info=True)
            available_skills = getattr(runtime_context, "available_skills", None)
            if isinstance(available_skills, list):
                executable_names.difference_update(
                    {
                        str(getattr(skill, "name", "")).strip()
                        for skill in available_skills
                        if str(getattr(skill, "name", "")).strip()
                    }
                )

        def _is_action_executable(tool_name: str) -> bool:
            if not tool_name:
                return False
            if tool_name in executable_names:
                return True
            capability_graph = getattr(unified_executor, "capability_graph", None)
            if capability_graph is not None and hasattr(capability_graph, "get_capability"):
                get_capability = getattr(capability_graph, "get_capability")
                if inspect.iscoroutinefunction(get_capability):
                    return False
                try:
                    capability = get_capability(tool_name)
                except Exception:
                    capability = None
                if inspect.isawaitable(capability):
                    # Close the unawaited coroutine to prevent resource leak.
                    capability.close()
                    capability = None
                if capability is not None and str(getattr(capability, "capability_type", "")) == "mcp":
                    return True
            return False

        fallback_tool: str | None = None
        for name in ("search", "web_fetch", "semi_browser", "code_executor", "file_io"):
            if _is_action_executable(name):
                fallback_tool = name
                break
        if fallback_tool:
            rewritten_actions: list[PlanStep] = []
            for action in pending_actions:
                tool_name = str(action.tool or "").strip()
                if _is_abstract_reasoning_step(action) or _is_action_executable(tool_name):
                    rewritten_actions.append(action)
                    continue
                query_seed = str(action.params.get("query") or action.title or tool_name or "latest updates").strip()
                action.tool = fallback_tool
                if fallback_tool == "search":
                    action.params = {"queries": [query_seed]}
                rewritten_count += 1
                logger.warning(
                    "pending_action_rewritten_unexecutable_tool",
                    extra={
                        "session_id": state["session_id"],
                        "from": tool_name or "<empty>",
                        "to": fallback_tool,
                    },
                )
                rewritten_actions.append(action)
            pending_actions = rewritten_actions
    if rewritten_count and event_emitter:
        await event_emitter.emit("pending_actions_sanitized", {"rewritten": rewritten_count})

    logger.info(
        "Using UnifiedActionExecutor",
        extra={"session_id": state["session_id"]},
    )

    results: list[ToolCallResult] = []
    current_skill_name = _current_round_skill_id(state)
    latest_user_text = _latest_user_text_from_messages(state.get("messages", []))
    remaining_actions: list[PlanStep] = []
    last_executed_action: PlanStep | None = None

    async def _execute_single_action(action: PlanStep) -> list[ToolCallResult]:
        if context.get("llm_provider") is not None:
            return await _execute_llm_act_step(
                state=state,
                context=context,
                action=action,
                unified_executor=unified_executor,
                event_emitter=event_emitter,
                prior_results=results,
            )
        _prepare_artifact_aware_action(
            action,
            prior_results=results,
            runtime_context=runtime_context,
            session_id=state["session_id"],
            selected_skill_name=current_skill_name,
        )
        return [
            await _execute_with_events(
                unified_executor,
                action,
                event_emitter,
                result_postprocessor=lambda result: _postprocess_execution_result(
                    action=action,
                    result=result,
                    current_skill_name=current_skill_name,
                    latest_user_text=latest_user_text,
                ),
            )
        ]

    idx = 0
    while idx < len(pending_actions):
        action = pending_actions[idx]

        if action.parallel:
            group: list[PlanStep] = []
            end_idx = idx
            while end_idx < len(pending_actions) and pending_actions[end_idx].parallel:
                group.append(pending_actions[end_idx])
                end_idx += 1

            if not _parallel_step_group_is_safe(group):
                try:
                    result_batch = await _execute_single_action(action)
                    results.extend(result_batch)
                    terminal = result_batch[-1] if result_batch else None
                    last_executed_action = action
                    terminal_result = terminal if isinstance(terminal, ToolCallResult) else None
                    if _terminal_result_allows_step_advance(terminal_result, action=action):
                        idx += 1
                        continue

                    terminal_metadata = terminal_result.metadata if terminal_result and isinstance(terminal_result.metadata, dict) else {}
                    terminal_decision = str(terminal_metadata.get("act_decision") or "").strip().lower()
                    keep_current_action_pending = bool(
                        terminal_result
                        and terminal_result.success
                        and terminal_decision == "continue_current_step"
                    )
                    remaining_actions = pending_actions[idx:] if keep_current_action_pending else pending_actions[idx + 1 :]
                    logger.info(
                        "sequential_execution_stopped_after_failure",
                        extra={
                            "session_id": state["session_id"],
                            "failed_tool": getattr(terminal, "tool_name", action.tool),
                            "failed_step_id": action.id,
                            "remaining_actions": len(remaining_actions),
                        },
                    )
                    break
                except Exception as e:
                    logger.error(f"Action execution failed: {e}")
                    results.append(
                        ToolCallResult(
                            tool_name=action.tool or "unknown",
                            params=action.params,
                            error=str(e),
                            success=False,
                        )
                    )
                    remaining_actions = pending_actions[idx + 1 :]
                    logger.info(
                        "sequential_execution_stopped_after_exception",
                        extra={
                            "session_id": state["session_id"],
                            "failed_tool": action.tool,
                            "failed_step_id": action.id,
                            "remaining_actions": len(remaining_actions),
                        },
                    )
                    break

            parallel_results = await asyncio.gather(
                *[_execute_single_action(item) for item in group],
                return_exceptions=True,
            )
            group_failed = False
            for offset, result_batch in enumerate(parallel_results):
                if isinstance(result_batch, Exception):
                    group_failed = True
                    tool_name = group[offset].tool or "unknown"
                    terminal = ToolCallResult(
                        tool_name=tool_name,
                        params=group[offset].params,
                        error=str(result_batch),
                        success=False,
                    )
                    results.append(terminal)
                    last_executed_action = group[offset]
                else:
                    results.extend(result_batch)
                    terminal = result_batch[-1] if result_batch else None
                    last_executed_action = group[offset]
                    terminal_decision = ""
                    if terminal and isinstance(getattr(terminal, "metadata", None), dict):
                        terminal_decision = str(
                            terminal.metadata.get("act_decision") or ""
                        ).strip().lower()
                    if not (terminal and getattr(terminal, "success", False)) or terminal_decision != "advance_step":
                        group_failed = True
            if group_failed:
                remaining_actions = pending_actions[end_idx:]
                logger.info(
                    "parallel_group_execution_stopped_after_failure",
                    extra={
                        "session_id": state["session_id"],
                        "remaining_actions": len(remaining_actions),
                        "group_size": len(group),
                    },
                )
                break
            idx = end_idx
            continue

        try:
            result_batch = await _execute_single_action(action)
            results.extend(result_batch)
            terminal = result_batch[-1] if result_batch else None
            last_executed_action = action
            terminal_result = terminal if isinstance(terminal, ToolCallResult) else None
            if _terminal_result_allows_step_advance(terminal_result, action=action):
                idx += 1
                continue

            terminal_metadata = terminal_result.metadata if terminal_result and isinstance(terminal_result.metadata, dict) else {}
            terminal_decision = str(terminal_metadata.get("act_decision") or "").strip().lower()
            keep_current_action_pending = bool(
                terminal_result
                and terminal_result.success
                and terminal_decision == "continue_current_step"
            )
            remaining_actions = pending_actions[idx:] if keep_current_action_pending else pending_actions[idx + 1 :]
            logger.info(
                "sequential_execution_stopped_after_failure",
                extra={
                    "session_id": state["session_id"],
                    "failed_tool": getattr(terminal, "tool_name", action.tool),
                    "failed_step_id": action.id,
                    "remaining_actions": len(remaining_actions),
                },
            )
            break
        except Exception as e:
            logger.error(f"Action execution failed: {e}")
            results.append(
                ToolCallResult(
                    tool_name=action.tool or "unknown",
                    params=action.params,
                    error=str(e),
                    success=False,
                )
            )
            remaining_actions = pending_actions[idx + 1 :]
            logger.info(
                "sequential_execution_stopped_after_exception",
                extra={
                    "session_id": state["session_id"],
                    "failed_tool": action.tool,
                    "failed_step_id": action.id,
                    "remaining_actions": len(remaining_actions),
                },
            )
            break
    else:
        remaining_actions = []

    result_state = {
        "tool_results": results,
        "pending_actions": remaining_actions,
        "current_step": "observe",
        "plan": state.get("plan"),
        "metadata": dict(state.get("metadata") or {}),
    }
    if last_executed_action is not None:
        result_state["metadata"].update(
            {
                "last_act_step_id": last_executed_action.id,
                "last_act_result_count": max(int(len(results) or 0), 0),
            }
        )
    return result_state
