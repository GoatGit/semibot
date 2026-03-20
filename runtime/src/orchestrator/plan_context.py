"""Plan context preparation: build all dependencies needed for the planner loop."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from src.orchestrator.state import AgentState, ExecutionPlan, resolve_time_context
from src.utils.logging import get_logger

logger = get_logger(__name__)


@dataclass
class PlanningContext:
    """All dependencies needed by the planner loop, resolved from state + context."""

    llm_provider: Any
    skill_registry: Any | None
    runtime_context: Any | None
    runtime_org_id: str | None
    event_emitter: Any | None
    runtime_event_emitter: Any | None
    memory_system: Any | None
    available_skills: list[dict[str, Any]]
    available_execution_capability_names: dict[str, str]
    messages: list[dict[str, Any]]
    effective_memory: str
    memory_snapshot: dict[str, Any]
    latest_user_text: str
    failure_reflection: str
    agent_system_prompt: str
    agent_model: Any | None
    plan_temperature: float
    sub_agents_for_planner: list[dict[str, Any]]
    evolved_skills_context: str
    current_plan: ExecutionPlan | None
    session_current_date: str
    session_current_weekday: str
    session_current_timezone: str
    prior_plan_summary: dict[str, Any]
    execution_state: dict[str, Any]
    remaining_iteration_budget: int
    max_iterations: int
    completed_step_ids_for_replan: list[str]
    prior_completed_step_refs: list[tuple[str, str]]
    requires_fresh_research_plan: bool
    original_goal: str
    current_round_goal: str
    # Skill pre-load state (for replan with known selected_skill)
    loaded_skill_id: str | None = None
    loaded_skill_content: str = ""
    skill_preload_message: dict[str, Any] | None = None


async def build_planning_context(
    state: AgentState,
    context: dict[str, Any],
) -> PlanningContext:
    """Resolve all dependencies from state + context for the planner loop.

    Returns a PlanningContext dataclass. If ``llm_provider`` is ``None`` the
    caller should short-circuit with an error.
    """
    from src.orchestrator.nodes_stateflow import _build_execution_state_for_planner
    from src.orchestrator.nodes_observe import _build_failure_reflection
    from src.orchestrator.nodes_shared import _current_round_skill_id
    from src.orchestrator.plan_validator import _is_latest_intent, _lookup_enabled_skill_item
    from src.orchestrator.nodes_plan import (
        _filter_rule_authoring_by_intent,
        _get_planner_execution_capabilities,
        _load_skill_md_for_planner,
        _merge_dynamic_registry_schemas,
        _PLANNER_MEMORY_MAX_CHARS,
        _PLANNER_SKILL_MD_MAX_CHARS,
    )

    event_emitter = context.get("event_emitter")
    llm_provider = context.get("llm_provider")
    skill_registry = context.get("skill_registry")
    config = context.get("config", {})
    runtime_context = state.get("context")
    runtime_context_metadata = getattr(runtime_context, "metadata", None)
    runtime_org_id: str | None = None
    if isinstance(runtime_context_metadata, dict):
        raw_org_id = runtime_context_metadata.get("org_id")
        if isinstance(raw_org_id, str):
            runtime_org_id = raw_org_id.strip() or None

    runtime_event_emitter = (
        runtime_context_metadata.get("event_emitter")
        if isinstance(runtime_context_metadata, dict)
        else None
    )

    # --- Resolve available skills ---
    available_skills: list[dict[str, Any]] = []
    if runtime_context and (skill_registry is None):
        metadata = getattr(runtime_context, "metadata", None)
        if isinstance(metadata, dict):
            candidate_registry = metadata.get("skill_registry")
            if candidate_registry is not None:
                skill_registry = candidate_registry

    if runtime_context:
        from src.orchestrator.capability import CapabilityGraph

        capability_graph = CapabilityGraph(runtime_context)
        available_skills = capability_graph.get_schemas_for_planner()
        available_skills = _merge_dynamic_registry_schemas(available_skills, runtime_context)
        logger.info(
            "Capability graph built for planning",
            extra={"session_id": state["session_id"], "capability_count": len(available_skills)},
        )
    elif skill_registry:
        tool_schemas: list[dict[str, Any]] = []
        get_tool_schemas = getattr(skill_registry, "get_tool_schemas", None)
        if callable(get_tool_schemas):
            try:
                raw_tools = get_tool_schemas()
                if isinstance(raw_tools, list):
                    tool_schemas = [item for item in raw_tools if isinstance(item, dict)]
            except Exception:
                logger.warning("plan_node: skill_registry.get_tool_schemas() failed", exc_info=True)
                tool_schemas = []
        available_skills = tool_schemas
        if not available_skills and hasattr(skill_registry, "get_all_schemas"):
            try:
                raw_all = skill_registry.get_all_schemas()
                if isinstance(raw_all, list):
                    available_skills = [
                        item
                        for item in raw_all
                        if isinstance(item, dict)
                        and str(item.get("type") or "").strip().lower() != "skill"
                    ]
            except Exception:
                logger.warning("plan_node: skill_registry.get_all_schemas() failed", exc_info=True)
                available_skills = []
        logger.warning(
            "Using skill_registry fallback (no RuntimeSessionContext)",
            extra={"session_id": state["session_id"]},
        )

    # --- Memory ---
    messages = list(state["messages"])
    memory_context = str(state.get("memory_context", "") or "").strip()
    memory_snapshot = state.get("memory_snapshot", {})
    memory_system = context.get("memory_system")
    if memory_system and hasattr(memory_system, "render_memory_snapshot"):
        memory_context = memory_system.prepare_memory_context(
            memory_system.render_memory_snapshot(memory_snapshot),
            max_chars=_PLANNER_MEMORY_MAX_CHARS,
        )
    elif memory_context:
        if memory_system and hasattr(memory_system, "prepare_memory_context"):
            memory_context = memory_system.prepare_memory_context(
                memory_context,
                max_chars=_PLANNER_MEMORY_MAX_CHARS,
            )
        else:
            memory_context = memory_context[:_PLANNER_MEMORY_MAX_CHARS]

    latest_user_text = str(messages[-1].get("content") or "") if messages else ""
    before_rule_filter = len(available_skills)
    available_skills = _filter_rule_authoring_by_intent(available_skills, latest_user_text)
    if len(available_skills) != before_rule_filter:
        logger.info(
            "planner_capability_filtered_by_intent",
            extra={"session_id": state["session_id"], "removed": before_rule_filter - len(available_skills), "reason": "rule_authoring_non_intent"},
        )

    # --- Failure reflection ---
    tool_results = state.get("tool_results", [])
    failed_results = [r for r in tool_results if not r.success]
    failure_reflection = ""
    if failed_results and state["iteration"] > 0:
        failure_reflection = _build_failure_reflection(tool_results=tool_results, current_skill_name=_current_round_skill_id(state))
        logger.info("Injected failure reflection for replan", extra={"session_id": state["session_id"], "error_count": len(failed_results)})

    available_execution_capability_names = _get_planner_execution_capabilities(available_skills)

    # --- Agent config ---
    agent_system_prompt = ""
    agent_model = None
    plan_temperature = 0.2
    if runtime_context and runtime_context.agent_config:
        agent_system_prompt = runtime_context.agent_config.system_prompt or ""
        role_cfg = getattr(getattr(runtime_context.agent_config, "model_roles", None), "plan", None)
        if role_cfg:
            agent_model = getattr(role_cfg, "model", None) or getattr(runtime_context.agent_config, "model", None)
            if getattr(role_cfg, "temperature", None) is not None:
                plan_temperature = role_cfg.temperature
        else:
            agent_model = getattr(runtime_context.agent_config, "model", None)

    # --- Sub-agents ---
    sub_agents_for_planner: list[dict[str, Any]] = []
    if runtime_context and hasattr(runtime_context, "available_sub_agents") and runtime_context.available_sub_agents:
        sub_agents_for_planner = [{"id": sa.id, "name": sa.name, "description": sa.description} for sa in runtime_context.available_sub_agents]

    # --- Evolved skills ---
    evolved_skills_context = ""
    try:
        agent_config_meta: dict[str, Any] = {}
        if runtime_context and hasattr(runtime_context, "agent_config") and runtime_context.agent_config:
            agent_config_meta = runtime_context.agent_config.metadata if hasattr(runtime_context.agent_config, "metadata") else {}
        evolution_config = agent_config_meta.get("evolution", {}) if isinstance(agent_config_meta, dict) else {}
        if evolution_config.get("enabled", False) and context.get("memory_system") and context.get("db_pool"):
            from src.evolution.retriever import EvolvedSkillRetriever
            from src.evolution.formatter import format_skills_for_prompt as format_evolved_skills_for_prompt

            retriever = EvolvedSkillRetriever(memory_system=context["memory_system"], db_pool=context["db_pool"])
            user_intent = messages[-1]["content"] if messages else ""
            relevant_skills = await retriever.search(query=user_intent, org_id=runtime_org_id or "", limit=5)
            if relevant_skills:
                evolved_skills_context = format_evolved_skills_for_prompt(relevant_skills)
                logger.info("[Evolution] 检索到 %s 个相关进化技能", len(relevant_skills), extra={"session_id": state["session_id"]})
    except Exception as e:
        logger.warning("[Evolution] 技能检索异常（不影响规划）: %s", e)

    effective_memory = f"{memory_context}\n\n{evolved_skills_context}" if evolved_skills_context and memory_context else (evolved_skills_context or memory_context)

    # --- Time context & plan state ---
    original_goal = latest_user_text
    current_round_goal = str(getattr(state.get("plan"), "round_goal", "") or "").strip() or latest_user_text
    current_plan = state.get("plan")
    session_current_date, session_current_weekday, session_current_timezone = resolve_time_context(
        state.get("metadata"),
        current_plan if isinstance(current_plan, ExecutionPlan) else None,
    )
    if not isinstance(current_plan, ExecutionPlan):
        prior_plan_summary = {"plan_id": "", "plan_mode": "initial", "selected_skill": None, "round_goal": None}
    else:
        prior_plan_summary = {
            "plan_id": f"iter-{int(state.get('iteration', 0))}",
            "plan_mode": str(getattr(current_plan, "plan_mode", "initial") or "initial"),
            "selected_skill": str(current_plan.selected_skill or "").strip() or None,
            "round_goal": str(current_plan.round_goal or "").strip() or None,
        }
    execution_state = _build_execution_state_for_planner(state)
    max_iterations = int(config.get("max_iterations", 15))
    remaining_iteration_budget = max(max_iterations - int(state.get("iteration") or 0), 0)
    execution_state["remaining_budget_or_limits"] = [f"remaining_iterations={remaining_iteration_budget}", f"max_iterations={max_iterations}"]
    completed_step_ids_for_replan = [str(item or "").strip() for item in (execution_state.get("completed_steps") or []) if str(item or "").strip()]
    prior_completed_step_refs: list[tuple[str, str]] = []
    if isinstance(current_plan, ExecutionPlan):
        for step in current_plan.steps:
            step_id = str(step.id or "").strip()
            if step_id in completed_step_ids_for_replan:
                prior_completed_step_refs.append((step_id, str(step.title or "").strip()))

    # --- Skill pre-load for replan ---
    loaded_skill_id: str | None = None
    loaded_skill_content = ""
    skill_preload_message: dict[str, Any] | None = None
    _replan_skill_id = str(prior_plan_summary.get("selected_skill") or "").strip()
    if _replan_skill_id:
        _skill_item = _lookup_enabled_skill_item(runtime_context, _replan_skill_id)
        if _skill_item:
            _skill_content, _ = _load_skill_md_for_planner(_skill_item)
            if _skill_content:
                loaded_skill_id = _replan_skill_id
                loaded_skill_content = _skill_content
                _skill_excerpt = _skill_content[:_PLANNER_SKILL_MD_MAX_CHARS]
                skill_preload_message = {
                    "role": "system",
                    "content": (
                        f"Replan: skill '{_replan_skill_id}' was already selected in the previous iteration. "
                        f"Its SKILL.md is pre-loaded below. Do not call read_skill again. "
                        f"Use this methodology to regenerate the plan directly.\n\n"
                        f"<skill_md skill_id=\"{_replan_skill_id}\">\n{_skill_excerpt}\n</skill_md>"
                    ),
                }
                logger.info(
                    "planner_replan_skill_preloaded",
                    extra={"session_id": state["session_id"], "skill_id": _replan_skill_id},
                )

    # --- Disabled: fresh research plan detection (non-generic) ---
    requires_fresh_research_plan = False

    return PlanningContext(
        llm_provider=llm_provider,
        skill_registry=skill_registry,
        runtime_context=runtime_context,
        runtime_org_id=runtime_org_id,
        event_emitter=event_emitter,
        runtime_event_emitter=runtime_event_emitter,
        memory_system=memory_system,
        available_skills=available_skills,
        available_execution_capability_names=available_execution_capability_names,
        messages=messages,
        effective_memory=effective_memory,
        memory_snapshot=memory_snapshot,
        latest_user_text=latest_user_text,
        failure_reflection=failure_reflection,
        agent_system_prompt=agent_system_prompt,
        agent_model=agent_model,
        plan_temperature=plan_temperature,
        sub_agents_for_planner=sub_agents_for_planner,
        evolved_skills_context=evolved_skills_context,
        current_plan=current_plan if isinstance(current_plan, ExecutionPlan) else None,
        session_current_date=session_current_date,
        session_current_weekday=session_current_weekday,
        session_current_timezone=session_current_timezone,
        prior_plan_summary=prior_plan_summary,
        execution_state=execution_state,
        remaining_iteration_budget=remaining_iteration_budget,
        max_iterations=max_iterations,
        completed_step_ids_for_replan=completed_step_ids_for_replan,
        prior_completed_step_refs=prior_completed_step_refs,
        requires_fresh_research_plan=requires_fresh_research_plan,
        original_goal=original_goal,
        current_round_goal=current_round_goal,
        loaded_skill_id=loaded_skill_id,
        loaded_skill_content=loaded_skill_content,
        skill_preload_message=skill_preload_message,
    )


async def finalize_plan_result(
    *,
    plan: ExecutionPlan,
    state: AgentState,
    ctx: PlanningContext,
    planner_loop_trace: list[dict[str, Any]],
) -> dict[str, Any]:
    """Post-process accepted plan: rewrite, emit events, build return dict."""
    from src.orchestrator.plan_rewriter import (
        _apply_plan_time_context,
        _build_fresh_research_fallback_plan,
    )
    from src.orchestrator.plan_validator import _candidate_plan_skill_context_skill_id
    from src.orchestrator.nodes_plan import _ENABLE_FRESHNESS_VALIDATION
    from src.events.runtime_emitter import emit_runtime_event

    event_emitter = ctx.event_emitter
    loaded_skill_id = ctx.loaded_skill_id

    if _ENABLE_FRESHNESS_VALIDATION and ctx.requires_fresh_research_plan and (plan.plan_type == "terminate" or not plan.steps):
        logger.info("planner_freshness_result_rewritten_to_plan", extra={"session_id": state["session_id"], "original_plan_type": plan.plan_type, "had_steps": bool(plan.steps)})
        request = str(ctx.latest_user_text or "").strip() or "latest updates"
        plan = _build_fresh_research_fallback_plan(request)

    plan = _apply_plan_time_context(plan, state.get("metadata"))
    plan.plan_version = max(int(state.get("iteration", 0)) + 1, 1)
    plan.steps = list(plan.steps)

    orchestration_trace = {
        "selected_skill": str(plan.selected_skill or "").strip() or None,
        "loaded_skill_id": str(loaded_skill_id or "").strip() or None,
        "skill_context_skill_id": _candidate_plan_skill_context_skill_id(plan),
        "selected_skill_kind": "structured_skill_context" if isinstance(plan.skill_context_for_act, dict) and plan.skill_context_for_act else ("selected_skill" if str(plan.selected_skill or "").strip() else None),
        "has_skill_md": bool(loaded_skill_id),
        "plan_mode": str(plan.plan_mode or "").strip() or None,
        "round_goal": str(plan.round_goal or "").strip() or None,
        "step_count": len(plan.steps),
        "step_titles": [str(step.title or "").strip() for step in plan.steps[:8] if str(step.title or "").strip()],
        "is_replan": int(state.get("iteration", 0)) > 0,
        "observe_outcome": str((state.get("metadata") or {}).get("observe_outcome") or "").strip() or None,
        "observe_reason": str((state.get("metadata") or {}).get("observe_reason") or "").strip() or None,
        "replan_reason": str((state.get("metadata") or {}).get("replan_reason") or "").strip() or None,
        "replan_failure_reflection": str((state.get("metadata") or {}).get("replan_failure_reflection") or "").strip() or None,
        "planner_last_rejection_reason": next((str(item.get("rejection_reason") or "").strip() for item in reversed(planner_loop_trace) if str(item.get("rejection_reason") or "").strip()), None),
        "planner_loaded_skill_id": next((str(item.get("loaded_skill_id") or "").strip() for item in reversed(planner_loop_trace) if str(item.get("loaded_skill_id") or "").strip()), None),
    }
    if event_emitter:
        # Only emit skill_orchestration_trace when there is meaningful
        # orchestration content (steps, skill selection, or replan).
        # Terminate plans with no steps produce an empty card in the UI.
        _has_orchestration_content = bool(
            plan.steps
            or str(plan.selected_skill or "").strip()
            or orchestration_trace.get("skill_context_skill_id")
            or orchestration_trace.get("is_replan")
        )
        if _has_orchestration_content:
            await event_emitter.emit("skill_orchestration_trace", orchestration_trace)
        await event_emitter.emit("planner_loop_trace", {"turns": planner_loop_trace})
    await emit_runtime_event(
        ctx.runtime_event_emitter,
        event_type="planner_loop_trace",
        source="runtime.plan_node",
        subject=state["session_id"],
        payload={
            "session_id": state["session_id"],
            "iteration": int(state.get("iteration", 0)),
            "outcome": "accepted",
            "plan_type": plan.plan_type,
            "selected_skill": str(plan.selected_skill or "").strip() or None,
            "step_count": len(plan.steps),
            "turns": planner_loop_trace,
        },
    )

    if event_emitter and plan.steps:
        await event_emitter.emit(
            "plan_version",
            {
                "version": int(plan.plan_version or 1),
                "is_replan": int(state.get("iteration", 0)) > 0,
                "phase": "final",
                "goal": str(plan.goal or ""),
                "steps": [{"id": step.id, "title": step.title, "phase": step.phase, "intent": step.intent, "expected_outputs": step.expected_outputs, "completion_criteria": step.completion_criteria, "parallel": bool(step.parallel)} for step in plan.steps],
            },
        )

    base_metadata = {k: v for k, v in (state.get("metadata") or {}).items() if k != "step_transcripts"}
    metadata = {**base_metadata, "planner_loop_trace": planner_loop_trace, "skill_orchestration_trace": orchestration_trace}

    if plan.plan_type == "terminate":
        return {"plan": plan, "pending_actions": [], "metadata": metadata, "current_step": "respond"}
    if plan.plan_type == "delegate":
        runtime_context = ctx.runtime_context
        policy = getattr(runtime_context, "runtime_policy", None) if runtime_context else None
        sub_agents = getattr(runtime_context, "available_sub_agents", None) or [] if runtime_context else []
        can_delegate = bool(runtime_context and plan.sub_agent_id and (policy is None or getattr(policy, "enable_delegation", True) is not False) and any(getattr(sa, "id", None) == str(plan.sub_agent_id) for sa in sub_agents))
        if not can_delegate:
            logger.warning("Delegation requested by planner but unavailable", extra={"session_id": state["session_id"], "sub_agent_id": plan.sub_agent_id})
            return {
                "plan": plan,
                "pending_actions": [],
                "metadata": metadata,
                "error": f"Delegation requested for sub-agent '{plan.sub_agent_id or 'unknown'}' but delegation is unavailable in current runtime.",
                "current_step": "respond",
            }
        return {"plan": plan, "pending_actions": [], "metadata": metadata, "current_step": "delegate"}
    if not plan.steps:
        logger.warning("Planner produced a plan without semantic steps", extra={"session_id": state["session_id"], "plan_type": plan.plan_type})
        return {
            "plan": plan,
            "pending_actions": [],
            "metadata": metadata,
            "error": "Planning failed: planner produced type='plan' without semantic steps",
            "current_step": "respond",
        }
    pending = [s for s in plan.steps if str(getattr(s, "status", "") or "").strip().lower() != "completed"]
    return {"plan": plan, "pending_actions": pending, "metadata": metadata, "current_step": "act"}


async def process_plan_tool_calls(
    *,
    response: Any,
    planning_messages: list[dict[str, Any]],
    planner_loop_trace: list[dict[str, Any]],
    loaded_skill_id: str | None,
    loaded_skill_content: str,
    runtime_context: Any | None,
    turn_index: int,
    effective_tools: list[dict[str, Any]] | None,
    compact_mode: bool,
    llm_call_duration_ms: int,
) -> tuple[str | None, str]:
    """Process planner tool calls, execute them, and append results to messages.

    Returns updated ``(loaded_skill_id, loaded_skill_content)``.
    """
    import asyncio
    from src.orchestrator.nodes_shared import (
        _build_assistant_transcript_message,
        _parse_tool_call_arguments,
        _serialize_tool_backfeed_content,
    )
    from src.orchestrator.nodes_plan import _execute_plan_tool

    planner_loop_trace.append({"turn_index": turn_index, "tools_enabled": bool(effective_tools), "compact_mode": compact_mode, "loaded_skill_id": str(loaded_skill_id or '').strip() or None, "tool_calls": [{"id": str(call.get('id') or ''), "name": str((call.get('function') or {}).get('name') or '').strip(), "arguments": (call.get('function') or {}).get('arguments')} for call in (response.tool_calls or [])], "raw_response": str(response.content or ""), "outcome": "tool_calls", "duration_ms": llm_call_duration_ms, "finish_reason": str(getattr(response, "finish_reason", "") or "stop"), "usage": dict(getattr(response, "usage", {}) or {})})
    planning_messages.append(_build_assistant_transcript_message(response_content=str(response.content or ""), tool_calls=list(response.tool_calls or []), reasoning_content=getattr(response, "reasoning_content", None)))

    # Phase 1: admission check
    _call_entries: list[dict[str, Any]] = []
    _first_read_skill_id: str | None = None
    for call in response.tool_calls:
        function = call.get("function") or {}
        tool_name = str(function.get("name") or "").strip()
        tool_args, _ = _parse_tool_call_arguments(function.get("arguments"))
        entry: dict[str, Any] = {"call": call, "tool_name": tool_name, "tool_args": tool_args, "needs_exec": False, "payload": None, "requested_skill_id": ""}
        if tool_name == "read_skill":
            requested_skill_id = str(tool_args.get("skill_id") or "").strip()
            entry["requested_skill_id"] = requested_skill_id
            if not requested_skill_id:
                entry["payload"] = {"success": False, "error": "Missing required argument: skill_id"}
            elif loaded_skill_id and requested_skill_id != loaded_skill_id:
                entry["payload"] = {"success": False, "error": f"Planner already loaded skill '{loaded_skill_id}'. Only one primary skill may be loaded per planning session."}
            elif loaded_skill_id == requested_skill_id:
                entry["payload"] = {"success": True, "skill_id": requested_skill_id, "content": f"Skill '{requested_skill_id}' is already loaded in this planning session. Refer to the existing tool result content already present in the transcript."}
            elif _first_read_skill_id and requested_skill_id != _first_read_skill_id:
                entry["payload"] = {"success": False, "error": f"Only one primary skill may be loaded per planning session. '{_first_read_skill_id}' is already being loaded in this batch."}
            else:
                _first_read_skill_id = _first_read_skill_id or requested_skill_id
                entry["needs_exec"] = True
        else:
            entry["needs_exec"] = True
        _call_entries.append(entry)

    # Phase 2: parallel execution
    _exec_indices = [i for i, e in enumerate(_call_entries) if e["needs_exec"]]
    if _exec_indices:
        _exec_results = await asyncio.gather(
            *[_execute_plan_tool(tool_call=_call_entries[i]["call"], runtime_context=runtime_context) for i in _exec_indices]
        )
        for idx, result in zip(_exec_indices, _exec_results, strict=True):
            _call_entries[idx]["payload"] = result

    # Phase 3: post-process results & build messages
    for entry in _call_entries:
        tool_name = entry["tool_name"]
        tool_result_payload = entry["payload"]
        requested_skill_id = entry["requested_skill_id"]
        if tool_name == "read_skill" and entry["needs_exec"] and tool_result_payload.get("success") is True:
            loaded_skill_id = requested_skill_id
            loaded_skill_content = str(tool_result_payload.get("content") or "")
        tool_call_id = str(entry["call"].get("id") or "")
        tool_backfeed_purpose = (
            "planning_methodology_scaffold"
            if tool_name == "read_skill"
            else "delegation_capability_context"
            if tool_name == "inspect_sub_agent"
            else "tool_execution_result"
        )
        planning_messages.append({"role": "tool", "tool_call_id": tool_call_id, "content": _serialize_tool_backfeed_content(tool_name=tool_name, tool_call_id=tool_call_id, payload=tool_result_payload, purpose=tool_backfeed_purpose)})
        planner_loop_trace.append({"turn_index": turn_index, "tools_enabled": bool(effective_tools), "compact_mode": compact_mode, "loaded_skill_id": str(loaded_skill_id or '').strip() or None, "outcome": "tool_result_backfed", "tool_name": tool_name, "tool_call_id": tool_call_id, "purpose": tool_backfeed_purpose, "requested_skill_id": requested_skill_id if tool_name == 'read_skill' else None, "tool_success": bool(tool_result_payload.get("success")), "duration_ms": llm_call_duration_ms})
        if tool_name == "read_skill" and tool_result_payload.get("success") is True:
            if loaded_skill_id == requested_skill_id and requested_skill_id:
                planning_messages.append({"role": "system", "content": f"Skill '{requested_skill_id}' is already loaded. Do not call read_skill for it again. Return the next final JSON plan/delegate/terminate using the already loaded methodology."})
            planning_messages.append({"role": "system", "content": f"Skill '{requested_skill_id}' is now loaded from read_skill. Use the loaded SKILL.md as the methodology scaffold for planning, not as generic background context. Your next final JSON should reflect this explicitly through selected_skill='{requested_skill_id}' and skill_context_for_act."})

    return loaded_skill_id, loaded_skill_content
