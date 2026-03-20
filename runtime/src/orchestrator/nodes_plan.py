import asyncio
import json
import os
from contextlib import suppress
from pathlib import Path
from time import perf_counter
from typing import Any

from src.llm.provider_compat import resolve_plan_execution_strategy
from src.orchestrator.context_budget import PLAN_BUDGET, _env_int
from src.orchestrator.execution import parse_plan_response
from src.orchestrator.nodes_observe import _build_failure_reflection
from src.orchestrator.nodes_respond import _infer_delivery_language
from src.orchestrator.nodes_shared import (
    _build_assistant_transcript_message,
    _current_round_skill_id,
    _parse_tool_call_arguments,
    _serialize_tool_backfeed_content,
)
from src.orchestrator.nodes_stateflow import _build_execution_state_for_planner
from src.orchestrator.state import AgentState, ExecutionPlan, Message, PlanStep, resolve_time_context
from src.skills.skill_index_prompt import build_skill_index_entries, format_skills_for_prompt
from src.events.runtime_emitter import emit_runtime_event
from src.utils.logging import get_logger

# --- Re-exports from plan sub-modules (preserves backward-compatible import paths) ---
from src.orchestrator.plan_validator import (  # noqa: F401
    _candidate_plan_skill_context_skill_id,
    _check_replan_prefix,
    _check_skill_context_structure,
    _extract_loaded_skill_phase_outline,
    _extract_raw_plan_steps_for_validation,
    _is_latest_intent,
    _is_skill_wrapper_plan,
    _lookup_enabled_skill_item,
    _plan_contains_stale_year_for_latest_request,
    _planner_contract_validation_error,
    validate_plan_candidate,
)
from src.orchestrator.plan_rewriter import (  # noqa: F401
    _apply_plan_time_context,
    _build_fresh_research_fallback_plan,
)
from src.orchestrator.plan_llm_caller import (  # noqa: F401
    _build_compact_mode_context,
    _error_response_excerpt,
    _is_bad_request_error,
    _is_context_overflow_error,
    _parse_planner_json_object,
    _planner_llm_timeout_seconds,
    _planner_terminal_retry_hint,
    _recent_user_messages_for_compact_plan,
    _sanitize_loose_json_string_literals,
    _trim_plan_loop_messages,
    _unwrap_exception,
    handle_plan_llm_error,
    planner_chat_turn,
    planner_terminal_phase_retries,
)
from src.orchestrator.plan_message_builder import (  # noqa: F401
    _build_plan_loop_messages,
    _build_plan_loop_system_prompt,
    _compact_planner_value,
    _latest_user_text_from_messages,
    _load_skill_md_for_planner,
    _truncate_planner_text,
)
from src.orchestrator.plan_context import (  # noqa: F401
    PlanningContext,
    build_planning_context,
    finalize_plan_result,
    process_plan_tool_calls,
)

import re as _re

logger = get_logger(__name__)

_ENABLE_FRESHNESS_VALIDATION = str(os.getenv("SEMIBOT_ENABLE_FRESHNESS_VALIDATION", "false")).strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}

# --- Disabled: domain-specific intent detection tokens (non-generic) ---
_ABSTRACT_PHASE_TOKENS: tuple[str, ...] = ()
_BROWSER_INTENT_KEYWORDS: tuple[str, ...] = ()
_RULE_AUTHORING_INTENT_KEYWORDS: tuple[str, ...] = ()

_PLANNER_SKILL_MD_MAX_CHARS = PLAN_BUDGET.max_skill_md_chars
_PLANNER_MEMORY_MAX_CHARS = PLAN_BUDGET.max_memory_chars
_PLANNER_MEMORY_MAX_ASSISTANT_TURN_CHARS = PLAN_BUDGET.max_history_per_message_chars
_PLANNER_HISTORY_USER_MAX_CHARS = PLAN_BUDGET.max_history_per_message_chars
_PLANNER_HISTORY_ASSISTANT_MAX_CHARS = 800
_PLANNER_STATE_TEXT_MAX_CHARS = 400
_MAX_SKILLS_IN_PROMPT = _env_int("SEMIBOT_MAX_SKILLS_IN_PROMPT", PLAN_BUDGET.max_skill_index_items)
_MAX_SKILLS_PROMPT_CHARS = _env_int("SEMIBOT_MAX_SKILLS_PROMPT_CHARS", PLAN_BUDGET.max_skill_index_chars)
_MAX_SKILL_DESC_CHARS = _env_int("SEMIBOT_MAX_SKILL_DESC_CHARS", PLAN_BUDGET.max_skill_desc_chars)
_PLAN_TOOL_MAX_TURNS = 8
_PLAN_RESPONSE_RETRY_HINT = (
    'Your output was not a valid plan JSON object. '
    'DO NOT output an array `[{"step"...}]`. '
    'DO NOT output `"tool_calls"`. '
    'Output exactly one JSON object with `type` = "plan" | "delegate" | "terminate", '
    'and the corresponding `steps`, `goal`, etc. '
    'No markdown fences or extra text.'
)
_PLAN_TERMINAL_MAX_RETRIES = 3


def _planner_response_format() -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "planner_response",
            "strict": False,
            "schema": {
                "type": "object",
                "properties": {
                    "type": {
                        "type": "string",
                        "enum": ["plan", "delegate", "terminate"],
                    }
                },
                "required": ["type"],
                "additionalProperties": True,
            },
        },
    }



def _is_rule_authoring_intent(text: str) -> bool:  # noqa: ARG001
    """Disabled: rule authoring intent detection (non-generic)."""
    return False


def _filter_rule_authoring_by_intent(available_schemas: list[dict[str, Any]], user_text: str) -> list[dict[str, Any]]:  # noqa: ARG001
    """Disabled: rule authoring capability filtering (non-generic). Returns all schemas."""
    return available_schemas


def _merge_dynamic_registry_schemas(
    available_schemas: list[dict[str, Any]],
    runtime_context: Any,
) -> list[dict[str, Any]]:
    if not runtime_context:
        return available_schemas
    metadata = getattr(runtime_context, "metadata", None)
    if not isinstance(metadata, dict):
        return available_schemas
    registry = metadata.get("skill_registry")
    if registry is None or not hasattr(registry, "get_tool_schemas"):
        return available_schemas
    try:
        fresh = registry.get_tool_schemas()
    except Exception:
        logger.warning("_merge_dynamic_registry_schemas: registry.get_tool_schemas() failed", exc_info=True)
        return available_schemas

    blocked_skill_names: set[str] = set()
    available_skills = getattr(runtime_context, "available_skills", None)
    if isinstance(available_skills, list):
        blocked_skill_names = {
            str(getattr(skill, "name", "")).strip()
            for skill in available_skills
            if str(getattr(skill, "name", "")).strip()
        }

    allowed_names: set[str] = set()
    get_capability_names = getattr(runtime_context, "get_all_capability_names", None)
    if callable(get_capability_names):
        try:
            allowed_names = {str(name).strip() for name in get_capability_names() if str(name).strip()}
        except Exception:
            allowed_names = set()

    merged = list(available_schemas)
    existing = {
        str((item.get("function") or {}).get("name") or "")
        for item in merged
        if isinstance(item, dict)
    }
    for schema in fresh:
        if not isinstance(schema, dict):
            continue
        name = str((schema.get("function") or {}).get("name") or "")
        if allowed_names and name not in allowed_names:
            continue
        if name in blocked_skill_names:
            continue
        if not name or name in existing:
            continue
        merged.append(schema)
        existing.add(name)
    return merged


def _is_browser_intent(text: str) -> bool:  # noqa: ARG001
    """Disabled: browser intent detection (non-generic)."""
    return False


def _extract_target_url(text: str) -> str | None:  # noqa: ARG001
    """Disabled: target URL extraction (non-generic)."""
    return None


async def _execute_plan_tool(
    *,
    tool_call: dict[str, Any],
    runtime_context: Any | None,
) -> dict[str, Any]:
    function = tool_call.get("function") or {}
    tool_name = str(function.get("name") or "").strip()
    args, args_error = _parse_tool_call_arguments(function.get("arguments"))
    if args_error is not None:
        return {"success": False, "error": args_error}

    if tool_name == "read_skill":
        skill_id = str(args.get("skill_id") or "").strip()
        skill_item = _lookup_enabled_skill_item(runtime_context, skill_id)
        if not skill_item:
            return {
                "success": False,
                "error": (
                    f"Skill '{skill_id}' not found in local skill index. "
                    "If the user wants to install it, create a plan with a step that uses "
                    "skill_installer with registry_name to install from skills.sh registry."
                ),
            }
        content, truncated = _load_skill_md_for_planner(skill_item)
        if not content:
            return {"success": False, "error": f"Skill '{skill_id}' has no SKILL.md"}
        suffix = (
            "\n\n(truncated to 20000 chars; planner must rely on the visible planning rules only)"
            if truncated
            else ""
        )
        return {
            "success": True,
            "skill_id": skill_id,
            "content": content + suffix,
        }

    if tool_name == "inspect_sub_agent":
        agent_id = str(args.get("agent_id") or "").strip()
        sub_agents = getattr(runtime_context, "available_sub_agents", []) if runtime_context is not None else []
        for item in sub_agents or []:
            if str(getattr(item, "id", "")).strip() != agent_id:
                continue
            mcp_servers = getattr(item, "mcp_servers", []) or []
            supported_tools: list[str] = []
            for server in mcp_servers:
                for tool in getattr(server, "available_tools", []) or []:
                    if isinstance(tool, dict):
                        name = str(tool.get("name") or "").strip()
                        if name:
                            supported_tools.append(name)
            return {
                "success": True,
                "id": getattr(item, "id", ""),
                "name": getattr(item, "name", ""),
                "description": getattr(item, "description", ""),
                "capabilities": list(getattr(item, "skills", []) or []),
                "supported_tools": supported_tools,
            }
        return {"success": False, "error": f"Sub-agent '{agent_id}' not found"}

    return {"success": False, "error": f"Unknown plan tool: {tool_name}"}


_PLANNER_EXECUTION_CAPABILITY_MAP: dict[str, tuple[str, str]] = {
    "search": ("web_retrieval", "Search the web for real-time information, current events, weather, prices, and online content"),
    "web_fetch": ("webpage_content_extraction", "Fetch and extract content from a specific webpage URL"),
    "semi_browser": ("browser_interaction", "Navigate and interact with web pages in a browser"),
    "file_io": ("workspace_file_operations", "Read, write, and edit files in the workspace"),
    "code_executor": ("code_execution", "Execute code in a sandboxed environment"),
    "http_client": ("http_api_calls", "Make HTTP requests to external APIs"),
    "sql_query_readonly": ("readonly_sql_query", "Run read-only SQL queries against a database"),
    "csv_xlsx": ("spreadsheet_generation", "Generate CSV or Excel spreadsheet files"),
    "xlsx": ("spreadsheet_generation", "Generate CSV or Excel spreadsheet files"),
    "pdf_report": ("pdf_generation", "Generate PDF report files"),
    "pdf": ("pdf_generation", "Generate PDF report files"),
    "text_processing": ("text_processing", "Transform, extract, and restructure text and structured data"),
    "memory": ("session_memory", "Store and retrieve information in session memory"),
    "skill_script_runner": ("skill_script_execution", "Execute a skill's script"),
    "skill_installer": ("skill_installation", "Install a skill from the registry"),
    "control_plane": ("orchestration_control", "Manage orchestration rules and configuration"),
    "rule_authoring": ("rule_authoring", "Create and edit event-processing rules"),
}


def _get_planner_execution_capabilities(available_schemas: list[dict[str, Any]]) -> dict[str, str]:
    """Return {capability_name: description} for capabilities available in this session."""
    tool_names: set[str] = set()
    for schema in available_schemas:
        if not isinstance(schema, dict):
            continue
        fn = schema.get("function")
        if isinstance(fn, dict):
            name = str(fn.get("name") or "").strip()
            if name:
                tool_names.add(name)
                continue
        name = str(schema.get("name") or "").strip()
        if name:
            tool_names.add(name)
    capabilities: dict[str, str] = {}
    for name in tool_names:
        entry = _PLANNER_EXECUTION_CAPABILITY_MAP.get(name)
        if entry:
            cap_name, cap_desc = entry
            if cap_name not in capabilities:
                capabilities[cap_name] = cap_desc
        else:
            capabilities.setdefault("other_execution_capability", "Other execution capability")
    return capabilities


def _is_abstract_reasoning_step(step: PlanStep) -> bool:  # noqa: ARG001
    """Disabled: abstract reasoning step detection (non-generic)."""
    return False



async def plan_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    """
    PLAN node: Parse user intent and generate execution plan.

    This node uses the LLM to:
    1. Understand what the user wants to accomplish
    2. Break down the task into executable steps
    3. Determine if delegation to SubAgents is needed
    4. Generate a structured execution plan
    """
    logger.info(
        "Generating execution plan",
        extra={"session_id": state["session_id"], "iteration": state["iteration"]},
    )

    event_emitter = context.get("event_emitter")
    if event_emitter:
        await event_emitter.emit_thinking("正在分析任务并制定执行计划...", "planning")

    # 1. Build all dependencies
    ctx = await build_planning_context(state, context)
    if not ctx.llm_provider:
        return {"error": "LLM provider not configured", "current_step": "respond"}

    # 2. Build planner loop messages
    planning_messages = _build_plan_loop_messages(
        state_messages=ctx.messages,
        original_goal=ctx.original_goal,
        current_round_goal=ctx.current_round_goal,
        execution_state=ctx.execution_state,
        prior_plan_summary=ctx.prior_plan_summary,
        available_execution_capabilities=ctx.available_execution_capability_names,
        planning_limits={"remaining_iterations": ctx.remaining_iteration_budget, "max_iterations": ctx.max_iterations},
        runtime_context=ctx.runtime_context,
        memory_context=ctx.effective_memory,
        failure_reflection=ctx.failure_reflection,
        sub_agents_for_planner=ctx.sub_agents_for_planner,
        agent_system_prompt=ctx.agent_system_prompt,
        current_date=ctx.session_current_date,
        current_weekday=ctx.session_current_weekday,
        current_timezone=ctx.session_current_timezone,
    )
    plan_tools = [
        {
            "type": "function",
            "function": {
                "name": "read_skill",
                "description": "Read the SKILL.md of a registered skill. Use this when a skill in the skill index matches the task and you need its methodology before creating a plan.",
                "parameters": {"type": "object", "properties": {"skill_id": {"type": "string", "description": "Skill ID from the skill index"}}, "required": ["skill_id"]},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "inspect_sub_agent",
                "description": "Get detailed capabilities of a sub-agent before delegation.",
                "parameters": {"type": "object", "properties": {"agent_id": {"type": "string", "description": "Sub-agent ID from the available sub-agents list"}}, "required": ["agent_id"]},
            },
        },
    ]
    loaded_skill_id = ctx.loaded_skill_id
    loaded_skill_content = ctx.loaded_skill_content
    if ctx.skill_preload_message:
        planning_messages.append(ctx.skill_preload_message)

    requires_fresh_research_plan = ctx.requires_fresh_research_plan
    plan: ExecutionPlan | None = None
    planner_loop_trace: list[dict[str, Any]] = []
    # Skip tool phase when there are no skills to read and no sub-agents to inspect.
    # This avoids wasted LLM calls (read_skill with empty params, etc.) for simple queries.
    _has_inspectable_resources = bool(ctx.available_skills) or bool(ctx.sub_agents_for_planner)
    tools_available = not bool(loaded_skill_id) and _has_inspectable_resources
    compact_mode = False
    plan_strategy = resolve_plan_execution_strategy(
        llm_provider=ctx.llm_provider,
        model=ctx.agent_model,
        terminal_response_format=_planner_response_format(),
    )

    _chat_kwargs: dict[str, Any] = {
        "llm_provider": ctx.llm_provider,
        "planning_messages": planning_messages,
        "agent_model": ctx.agent_model,
        "plan_temperature": ctx.plan_temperature,
        "plan_strategy": plan_strategy,
        "event_emitter": event_emitter,
        "state": state,
        "compact_mode": compact_mode,
    }

    try:
        # 3. Planner loop
        for turn_index in range(_PLAN_TOOL_MAX_TURNS):
            effective_tools = plan_tools if tools_available and turn_index < _PLAN_TOOL_MAX_TURNS - 1 else None
            planner_model = str(ctx.agent_model or getattr(ctx.llm_provider, "model", "") or "").strip()
            try:
                _chat_kwargs["compact_mode"] = compact_mode
                response, llm_call_duration_ms = await planner_chat_turn(
                    **_chat_kwargs,
                    turn_index=turn_index,
                    phase_name="tool" if effective_tools else "terminal",
                    phase_tools=effective_tools,
                    phase_response_format=(
                        plan_strategy.tool_phase_response_format if effective_tools else plan_strategy.terminal_phase_response_format
                    ),
                )
                if effective_tools and not getattr(response, "tool_calls", None):
                    # Optimization: if the tool-phase response is already valid plan JSON,
                    # accept it directly instead of forcing an extra terminal-phase LLM call.
                    _tool_phase_text = str(response.content or "").strip()
                    _tool_phase_parsed = _parse_planner_json_object(_tool_phase_text) if _tool_phase_text else None
                    if _tool_phase_parsed is not None and _tool_phase_parsed.get("type") in ("plan", "delegate", "terminate"):
                        planner_loop_trace.append(
                            {
                                "turn_index": turn_index,
                                "phase": "tool",
                                "tools_enabled": True,
                                "compact_mode": compact_mode,
                                "loaded_skill_id": str(loaded_skill_id or "").strip() or None,
                                "raw_response": _tool_phase_text,
                                "outcome": "accepted_json_from_tool_phase",
                                "duration_ms": llm_call_duration_ms,
                            }
                        )
                        # Fall through to the terminal-phase JSON parsing below
                    else:
                        planner_loop_trace.append(
                            {
                                "turn_index": turn_index,
                                "phase": "tool",
                                "tools_enabled": True,
                                "compact_mode": compact_mode,
                                "loaded_skill_id": str(loaded_skill_id or "").strip() or None,
                                "raw_response": _tool_phase_text,
                                "outcome": "switch_to_terminal_phase",
                                "rejection_reason": (
                                    "two_phase_provider_no_tool_calls"
                                    if plan_strategy.two_phase
                                    else "no_tool_calls_terminal_phase"
                                ),
                                "duration_ms": llm_call_duration_ms,
                            }
                        )
                        if plan_strategy.two_phase:
                            planning_messages.append(
                                {
                                    "role": "system",
                                    "content": (
                                        "You did not emit a runtime tool call. "
                                        "Now switch to terminal phase and return exactly one final JSON object. "
                                        + _planner_terminal_retry_hint(1)
                                    ),
                                }
                            )
                            response, llm_call_duration_ms = await planner_chat_turn(
                                **_chat_kwargs,
                                turn_index=turn_index,
                                phase_name="terminal",
                                phase_tools=None,
                                phase_response_format=plan_strategy.terminal_phase_response_format,
                            )
            except Exception as llm_error:
                llm_call_duration_ms = 0
                if event_emitter:
                    await event_emitter.emit(
                        "planner.llm_call_failed",
                        {
                            "turn_index": turn_index,
                            "model": planner_model or None,
                            "tools_enabled": bool(effective_tools),
                            "compact_mode": compact_mode,
                            "duration_ms": llm_call_duration_ms,
                            "error": str(_unwrap_exception(llm_error))[:500],
                            "response_excerpt": _error_response_excerpt(llm_error),
                        },
                    )
                err_signal = handle_plan_llm_error(
                    llm_error=llm_error,
                    event_emitter=event_emitter,
                    state=state,
                    planner_loop_trace=planner_loop_trace,
                    planning_messages=planning_messages,
                    turn_index=turn_index,
                    planner_model=planner_model,
                    effective_tools=effective_tools,
                    compact_mode=compact_mode,
                    loaded_skill_id=loaded_skill_id,
                    llm_provider=ctx.llm_provider,
                    tools_available=tools_available,
                    effective_memory=ctx.effective_memory,
                    memory_system=ctx.memory_system,
                    memory_snapshot=state.get("memory_snapshot", {}),
                    runtime_context=ctx.runtime_context,
                    available_execution_capability_names=ctx.available_execution_capability_names,
                    agent_system_prompt=ctx.agent_system_prompt,
                    loaded_skill_content=loaded_skill_content,
                    messages=ctx.messages,
                    session_current_date=ctx.session_current_date,
                    session_current_weekday=ctx.session_current_weekday,
                    session_current_timezone=ctx.session_current_timezone,
                )
                compact_mode = err_signal["compact_mode"]
                tools_available = err_signal["tools_available"]
                planning_messages = err_signal["planning_messages"]
                _chat_kwargs["planning_messages"] = planning_messages
                if err_signal["action"] == "continue":
                    continue
                raise

            # --- Tool call handling ---
            if response.tool_calls:
                loaded_skill_id, loaded_skill_content = await process_plan_tool_calls(
                    response=response,
                    planning_messages=planning_messages,
                    planner_loop_trace=planner_loop_trace,
                    loaded_skill_id=loaded_skill_id,
                    loaded_skill_content=loaded_skill_content,
                    runtime_context=ctx.runtime_context,
                    turn_index=turn_index,
                    effective_tools=effective_tools,
                    compact_mode=compact_mode,
                    llm_call_duration_ms=llm_call_duration_ms,
                )
                continue

            # --- Terminal phase: parse JSON response ---
            response_text = str(response.content or "").strip()
            parsed_response: dict[str, Any] | None = None
            if response_text:
                parsed_response = _parse_planner_json_object(response_text)
            if parsed_response is None and effective_tools is None:
                response, llm_call_duration_ms, response_text, parsed_response = await planner_terminal_phase_retries(
                    llm_provider=ctx.llm_provider,
                    planning_messages=planning_messages,
                    agent_model=ctx.agent_model,
                    plan_temperature=ctx.plan_temperature,
                    plan_strategy=plan_strategy,
                    event_emitter=event_emitter,
                    state=state,
                    compact_mode=compact_mode,
                    loaded_skill_id=loaded_skill_id,
                    planner_loop_trace=planner_loop_trace,
                    turn_index=turn_index,
                    initial_response=response,
                    initial_duration_ms=llm_call_duration_ms,
                )

            if parsed_response is not None:
                candidate_plan = _apply_plan_time_context(
                    parse_plan_response(parsed_response),
                    state.get("metadata"),
                )
                trace_entry: dict[str, Any] = {"turn_index": turn_index, "tools_enabled": bool(effective_tools), "compact_mode": compact_mode, "loaded_skill_id": str(loaded_skill_id or '').strip() or None, "raw_response": response_text, "parsed_response": parsed_response, "candidate_plan_type": candidate_plan.plan_type, "candidate_selected_skill": str(candidate_plan.selected_skill or '').strip() or None, "candidate_skill_context_skill_id": _candidate_plan_skill_context_skill_id(candidate_plan) if isinstance(candidate_plan, ExecutionPlan) else None}

                rejection_reason = validate_plan_candidate(
                    parsed_response=parsed_response,
                    candidate_plan=candidate_plan,
                    loaded_skill_id=loaded_skill_id,
                    loaded_skill_content=loaded_skill_content,
                    runtime_context=ctx.runtime_context,
                    completed_step_ids=ctx.completed_step_ids_for_replan,
                    prior_completed_step_refs=ctx.prior_completed_step_refs,
                    requires_fresh_research=requires_fresh_research_plan,
                    session_current_date=ctx.session_current_date,
                    enable_freshness_validation=_ENABLE_FRESHNESS_VALIDATION,
                )
                if rejection_reason:
                    logger.warning(
                        "planner_candidate_rejected",
                        extra={"session_id": state["session_id"], "turn_index": turn_index, "reason": rejection_reason[:200]},
                    )
                    planning_messages.append(_build_assistant_transcript_message(response_content=str(response.content or "")))
                    planning_messages.append({"role": "system", "content": rejection_reason})
                    trace_entry["outcome"] = "rejected"
                    trace_entry["rejection_reason"] = rejection_reason
                    planner_loop_trace.append(trace_entry)
                    continue

                trace_entry["outcome"] = "accepted"
                planner_loop_trace.append(trace_entry)
                plan = candidate_plan
                break

            planner_loop_trace.append({"turn_index": turn_index, "phase": "terminal" if effective_tools is None else "tool", "tools_enabled": bool(effective_tools), "compact_mode": compact_mode, "raw_response": response_text, "outcome": "rejected", "rejection_reason": "response did not parse as a JSON object"})
            planning_messages.append(_build_assistant_transcript_message(response_content=str(response.content or "")))
            planning_messages.append({"role": "system", "content": _PLAN_RESPONSE_RETRY_HINT})

        # 4. Handle loop exhaustion
        if plan is None:
            if event_emitter:
                await event_emitter.emit("planner_loop_trace", {"turns": planner_loop_trace})
            await emit_runtime_event(
                ctx.runtime_event_emitter,
                event_type="planner_loop_trace",
                source="runtime.plan_node",
                subject=state["session_id"],
                payload={
                    "session_id": state["session_id"],
                    "iteration": int(state.get("iteration", 0)),
                    "outcome": "failed",
                    "turns": planner_loop_trace,
                },
            )
            return {"error": "Planning failed: planner did not produce valid JSON within turn budget", "metadata": {**(state.get("metadata") or {}), "planner_loop_trace": planner_loop_trace}, "current_step": "respond"}

        # 5. Post-process and return
        # Update ctx with mutable state that may have changed during the loop
        ctx.loaded_skill_id = loaded_skill_id
        ctx.loaded_skill_content = loaded_skill_content
        ctx.requires_fresh_research_plan = requires_fresh_research_plan
        return await finalize_plan_result(
            plan=plan,
            state=state,
            ctx=ctx,
            planner_loop_trace=planner_loop_trace,
        )

    except Exception as e:
        root: Exception | None = e
        visited: set[int] = set()
        while root is not None and id(root) not in visited:
            visited.add(id(root))
            if root.__class__.__name__ == "RetryError":
                last_attempt = getattr(root, "last_attempt", None)
                if last_attempt is not None and hasattr(last_attempt, "exception"):
                    with suppress(Exception):
                        inner = last_attempt.exception()
                        if isinstance(inner, Exception):
                            root = inner
                            continue
            if isinstance(getattr(root, "__cause__", None), Exception):
                root = root.__cause__
                continue
            if isinstance(getattr(root, "__context__", None), Exception):
                root = root.__context__
                continue
            break
        if root is None or root is e:
            error_text = str(e).strip()
            if not error_text and isinstance(e, TimeoutError):
                error_text = f"planner LLM call timed out after {_planner_llm_timeout_seconds(ctx.llm_provider):g}s"
        else:
            outer = str(e).strip()
            inner = str(root).strip()
            inner_name = root.__class__.__name__
            if outer and inner and inner not in outer:
                error_text = f"{outer}; root={inner_name}: {inner}"
            elif inner:
                error_text = f"{inner_name}: {inner}"
            else:
                error_text = inner_name
        logger.exception("Planning failed", extra={"error": error_text})
        return {"error": f"Planning failed: {error_text}", "current_step": "respond"}
