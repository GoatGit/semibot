"""ACT node and execution-domain helpers for orchestrator state machine."""

import asyncio
import inspect
import os
import time
from typing import Any
import re as _re

from src.orchestrator.nodes_plan import (
    _is_abstract_reasoning_step,
    _latest_user_text_from_messages,
)
from src.orchestrator.nodes_shared import _current_round_skill_id
from src.orchestrator.state import AgentState, ExecutionPlan, PlanStep, ToolCallResult, resolve_time_context
from src.llm.provider_compat import resolve_act_execution_strategy
from src.utils.logging import get_logger

# --- Re-exports from act sub-modules (preserves backward-compatible import paths) ---
from src.orchestrator.act_context import _get_step_transcripts, _parallel_step_group_is_safe, _persist_act_loop_trace_to_state
from src.orchestrator.act_terminal import (
    _act_response_format,
    _terminal_result_allows_step_advance,
    finalize_act_terminal_result,
    validate_act_terminal_response,
)
from src.orchestrator.act_tool_executor import (
    _build_act_tool_schemas,
    _execute_with_events,
    _postprocess_execution_result,
    _prepare_artifact_aware_action,
    process_act_tool_call_chunks,
)
from src.orchestrator.act_llm_caller import (  # noqa: F401
    build_act_system_messages,
    build_step_static_context,
    handle_act_llm_error,
    handle_act_output_truncation,
)
from src.orchestrator.act_budget_guard import resolve_step_budget_limits
from src.orchestrator.act_context_assembly import assemble_act_turn_messages
from src.orchestrator.act_runtime_pipeline import ActRuntimePipeline
from src.orchestrator.runtime_middleware import (
    RuntimeFailure,
    RuntimeSignal,
    load_budget_state,
)

logger = get_logger(__name__)

# ACT inner loop limits — configurable via env vars.
_MAX_INNER_TURNS = int(os.getenv("SEMIBOT_ACT_MAX_INNER_TURNS") or "30")
_MAX_TOOL_CALLS_PER_STEP = int(os.getenv("SEMIBOT_ACT_MAX_TOOL_CALLS_PER_STEP") or "50")
_ACT_LLM_HARD_TIMEOUT_SECONDS = float(os.getenv("SEMIBOT_ACT_LLM_HARD_TIMEOUT_SECONDS") or "120")
_ENABLE_FRESHNESS_VALIDATION = str(os.getenv("SEMIBOT_ENABLE_FRESHNESS_VALIDATION", "false")).strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}


def _act_llm_timeout_seconds(llm_provider: Any) -> float:
    configured = getattr(getattr(llm_provider, "config", None), "timeout", None)
    try:
        timeout = float(configured) if configured is not None else _ACT_LLM_HARD_TIMEOUT_SECONDS
    except (TypeError, ValueError):
        timeout = _ACT_LLM_HARD_TIMEOUT_SECONDS
    return max(1.0, min(timeout, _ACT_LLM_HARD_TIMEOUT_SECONDS))


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
    budget_limits = resolve_step_budget_limits(
        max_tool_calls_per_step=max_tool_calls_per_step,
        max_inner_turns=max_inner_turns,
    )
    step_budget = load_budget_state(
        state,
        step_id=action.id,
        iteration=_current_iteration,
        max_tool_calls_per_step=budget_limits["max_tool_calls_per_step"],
        max_inner_turns=budget_limits["max_inner_turns"],
        max_wall_clock_seconds=budget_limits["max_wall_clock_seconds"],
        max_total_tokens=budget_limits["max_total_tokens"],
    )
    pipeline = ActRuntimePipeline(
        state=state,
        action=action,
        iteration=_current_iteration,
        event_emitter=event_emitter,
        budget=step_budget,
    )
    def _iter_matches(meta_iteration: Any) -> bool:
        if meta_iteration is None:
            return True
        try:
            return int(meta_iteration) == _current_iteration
        except (ValueError, TypeError):
            return True

    while True:
        pipeline.snapshot_counters(
            tool_call_count=tool_call_count,
            terminal_retry_count=terminal_retry_count,
            rate_limit_retry_count=rate_limit_retry_count,
            context_overflow_retry_count=context_overflow_retry_count,
            timeout_retry_count=timeout_retry_count,
            output_truncation_retry_count=output_truncation_retry_count,
        )
        await pipeline.on_tick(act_phase=act_phase, turn_count=turn_count)
        pre_llm_signal = await pipeline.pre_llm_call()
        if pre_llm_signal.kind == "hard_stop":
            step_results.append(
                ToolCallResult(
                    tool_name="llm_act",
                    params={"title": action.title},
                    error=pre_llm_signal.message,
                    success=False,
                    metadata={"runtime_signal": pre_llm_signal.to_dict()},
                )
            )
            return step_results

        try:
            act_messages, artifact_context, step_memory, short_term_budget_text, compression_signal = await assemble_act_turn_messages(
                state=state,
                action=action,
                runtime_context=runtime_context,
                memory_system=memory_system,
                step_system_messages=_step_system_messages,
                step_transcript=step_transcript,
                step_results=step_results,
                prior_results=prior_results,
                act_phase=act_phase,
                terminal_retry_count=terminal_retry_count,
                current_iteration=_current_iteration,
                latest_user_text=latest_user_text,
            )
            await pipeline.on_context_signal(compression_signal)
        except Exception as exc:
            logger.warning("act_context_assembly_failed", extra={"error": str(exc)}, exc_info=True)
            return [
                ToolCallResult(
                    tool_name="llm_act",
                    params={"title": action.title},
                    error=f"ACT context assembly failed: {str(exc)[:300]}",
                    success=False,
                )
            ]

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
            response = await asyncio.wait_for(
                llm_provider.chat(
                    messages=act_messages,
                    tools=phase_tools,
                    temperature=act_temperature,
                    response_format=phase_response_format,
                    model=agent_model,
                ),
                timeout=_act_llm_timeout_seconds(llm_provider),
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
            runtime_failure = signal.get("runtime_failure")
            failure_obj: RuntimeFailure | None = None
            if isinstance(runtime_failure, dict):
                failure_obj = RuntimeFailure(
                    family=str(runtime_failure.get("family") or "llm"),  # type: ignore[arg-type]
                    kind=str(runtime_failure.get("kind") or "provider_error"),
                    retryable=bool(runtime_failure.get("retryable")),
                    source=str(runtime_failure.get("source") or "llm_provider"),
                    message=str(runtime_failure.get("message") or "LLM call failed"),
                    meta=dict(runtime_failure.get("meta") or {}),
                )
            runtime_signal = signal.get("runtime_signal")
            signal_obj: RuntimeSignal | None = None
            if isinstance(runtime_signal, dict):
                signal_obj = RuntimeSignal(
                    kind=str(runtime_signal.get("kind") or "emit_only"),  # type: ignore[arg-type]
                    source=str(runtime_signal.get("source") or "budget_guard"),
                    reason=str(runtime_signal.get("reason") or "llm_retry"),
                    message=str(runtime_signal.get("message") or ""),
                    data=dict(runtime_signal.get("data") or {}),
                )
            await pipeline.on_llm_error(failure_obj, signal_obj)
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
        budget_signal = await pipeline.post_llm_usage(
            usage=_act_usage,
            duration_ms=_act_llm_call_duration_ms,
            model=agent_model,
        )
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
        if budget_signal.kind == "hard_stop":
            step_results.append(
                ToolCallResult(
                    tool_name="llm_act",
                    params={"title": action.title},
                    error=budget_signal.message,
                    success=False,
                    metadata={"runtime_signal": budget_signal.to_dict()},
                )
            )
            return step_results

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
                pipeline=pipeline,
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
            keep_parallel_group_pending = False
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
                    if terminal and getattr(terminal, "success", False) and terminal_decision == "continue_current_step":
                        keep_parallel_group_pending = True
                    elif not (terminal and getattr(terminal, "success", False)) or terminal_decision != "advance_step":
                        group_failed = True
            if group_failed or keep_parallel_group_pending:
                remaining_actions = pending_actions[idx:] if keep_parallel_group_pending else pending_actions[end_idx:]
                logger.info(
                    "parallel_group_execution_stopped_after_failure",
                    extra={
                        "session_id": state["session_id"],
                        "remaining_actions": len(remaining_actions),
                        "group_size": len(group),
                        "keep_parallel_group_pending": keep_parallel_group_pending,
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
