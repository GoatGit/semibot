"""ROUTE node for selecting execution mode before planner entry."""

from __future__ import annotations

import json
import os
import re
from typing import Any

from src.events.runtime_emitter import emit_runtime_event
from src.orchestrator.prompts.route_prompts import route_system_prompt
from src.orchestrator.nodes_shared import _latest_user_text
from src.orchestrator.state import AgentState, DrPolicy, RoutingDecision
from src.utils.logging import get_logger

logger = get_logger(__name__)

_ROUTE_ENABLED = str(os.getenv("SEMIBOT_RUNTIME_ROUTE_ENABLED", "true")).strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
_ROUTE_SHADOW_MODE = str(os.getenv("SEMIBOT_RUNTIME_ROUTE_SHADOW_MODE", "false")).strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
_DIRECT_REASONING_ENABLED = str(os.getenv("SEMIBOT_RUNTIME_DIRECT_REASONING_ENABLED", "true")).strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
_DR_DEFAULT_MAX_INNER_TURNS = int(os.getenv("SEMIBOT_ACT_MAX_INNER_TURNS") or "30")
_DR_DEFAULT_MAX_TOOL_CALLS = int(os.getenv("SEMIBOT_ACT_MAX_TOOL_CALLS_PER_STEP") or "50")

_GREETING_TOKENS = {
    "hi",
    "hello",
    "hey",
    "你好",
    "您好",
    "嗨",
    "哈喽",
}

_WORKFLOW_HINT_TOKENS = (
    "先",
    "然后",
    "再",
    "最后",
    "分阶段",
    "多阶段",
    "step by step",
    "workflow",
    "对比报告",
    "导出pdf",
    "写ppt",
)

_DR_HINT_TOKENS = (
    "总结",
    "解读",
    "提炼",
    "概述",
    "梳理",
    "summarize",
    "summary",
    "explain",
    "extract",
)
def _route_surface_text(text: str) -> str:
    return re.sub(
        r"\[DOCUMENT_CONTEXT_BEGIN\].*?\[DOCUMENT_CONTEXT_END\]",
        "",
        str(text or ""),
        flags=re.DOTALL,
    ).strip()


def _default_dr_policy() -> DrPolicy:
    return {
        "single_shot": True,
        "allow_tools": True,
        "allow_skills": True,
        "max_tool_calls": _DR_DEFAULT_MAX_TOOL_CALLS,
        "max_wall_clock_ms": 45000,
        "max_prompt_tokens": 24000,
        "max_react_iterations": _DR_DEFAULT_MAX_INNER_TURNS,
        "allow_parallel_tools": False,
    }


def _contains_document_context(text: str) -> bool:
    return "[DOCUMENT_CONTEXT_BEGIN]" in text and "[DOCUMENT_CONTEXT_END]" in text


def _match_sub_agent(text: str, state: AgentState) -> str | None:
    runtime_context = state.get("context")
    available = getattr(runtime_context, "available_sub_agents", None) or []
    lowered = text.lower()
    for item in available:
        agent_id = str(getattr(item, "id", "") or "").strip()
        agent_name = str(getattr(item, "name", "") or "").strip()
        normalized_agent_id = agent_id.lower()
        if agent_id and len(normalized_agent_id) >= 3 and re.search(rf"\b{re.escape(normalized_agent_id)}\b", lowered):
            return agent_id
        normalized_agent_name = agent_name.lower()
        if agent_name and re.search(rf"\b{re.escape(normalized_agent_name)}\b", lowered):
            return agent_id or agent_name
    return None


def _available_skill_summaries(state: AgentState) -> list[dict[str, Any]]:
    runtime_context = state.get("context")
    available_skills = getattr(runtime_context, "available_skills", None) or []
    summaries: list[dict[str, Any]] = []
    for skill in available_skills:
        skill_id = str(getattr(skill, "id", "") or "").strip()
        skill_name = str(getattr(skill, "name", "") or "").strip()
        description = str(getattr(skill, "description", "") or "").strip()
        metadata = getattr(skill, "metadata", None)
        has_skill_md = bool(metadata.get("has_skill_md")) if isinstance(metadata, dict) else False
        if not (skill_id or skill_name or description):
            continue
        summaries.append(
            {
                "id": skill_id or skill_name,
                "name": skill_name or skill_id,
                "description": description,
                "has_skill_md": has_skill_md,
            }
        )
    return summaries[:20]


def _try_rule_based_route(state: AgentState) -> RoutingDecision | None:
    user_text = _latest_user_text(state)
    normalized = " ".join(_route_surface_text(user_text).split()).strip()
    lowered = normalized.lower()

    if normalized and len(normalized) <= 20 and lowered in _GREETING_TOKENS:
        return {
            "mode": "direct_answer",
            "goal": normalized,
            "reason": "short greeting or small-talk message",
            "delegate_to": None,
            "dr_policy": None,
        }

    delegate_to = _match_sub_agent(normalized, state)
    if delegate_to and any(token in normalized for token in ("交给", "委托", "delegate")):
        return {
            "mode": "delegate",
            "goal": normalized,
            "reason": "explicit delegation request targeting a known sub-agent",
            "delegate_to": delegate_to,
            "dr_policy": None,
        }

    if any(token in normalized for token in _WORKFLOW_HINT_TOKENS):
        return {
            "mode": "plan_act",
            "goal": normalized,
            "reason": "message contains explicit multi-stage workflow markers",
            "delegate_to": None,
            "dr_policy": None,
        }

    if _DIRECT_REASONING_ENABLED and _contains_document_context(user_text) and any(
        token in normalized for token in _DR_HINT_TOKENS
    ):
        return {
            "mode": "direct_reasoning",
            "goal": normalized or "direct reasoning task",
            "reason": "document context is already injected and request is single-turn synthesis",
            "delegate_to": None,
            "dr_policy": _default_dr_policy(),
        }

    return None


def _normalize_routing_decision(raw: dict[str, Any] | None, state: AgentState) -> RoutingDecision:
    latest_user_text = _route_surface_text(_latest_user_text(state))
    mode = str((raw or {}).get("mode") or "").strip().lower()
    if mode not in {"direct_answer", "direct_reasoning", "plan_act", "delegate"}:
        mode = "plan_act"
    normalized: RoutingDecision = {
        "mode": mode,  # type: ignore[typeddict-item]
        "goal": str((raw or {}).get("goal") or latest_user_text).strip() or latest_user_text,
        "reason": str((raw or {}).get("reason") or "model-selected route").strip() or "model-selected route",
        "delegate_to": str((raw or {}).get("delegate_to") or "").strip() or None,
        "dr_policy": _default_dr_policy() if mode == "direct_reasoning" else None,
    }
    if mode == "delegate" and not normalized["delegate_to"]:
        normalized["mode"] = "plan_act"
        normalized["reason"] = "delegate mode requested without a valid sub-agent target"
    return normalized


def _route_model_prompt(state: AgentState) -> str:
    latest_user_text = _route_surface_text(_latest_user_text(state))
    runtime_context = state.get("context")
    available = getattr(runtime_context, "available_sub_agents", None) or []
    available_agents = [
        {
            "id": str(getattr(item, "id", "") or "").strip(),
            "name": str(getattr(item, "name", "") or "").strip(),
        }
        for item in available
        if str(getattr(item, "id", "") or "").strip() or str(getattr(item, "name", "") or "").strip()
    ]
    available_skills = _available_skill_summaries(state)
    return route_system_prompt(
        available_skills_json=json.dumps(available_skills, ensure_ascii=False),
        available_sub_agents_json=json.dumps(available_agents, ensure_ascii=False),
        latest_user_text=latest_user_text,
    )


async def _classify_route_with_model(state: AgentState, llm_provider: Any) -> RoutingDecision:
    from src.orchestrator.plan_llm_caller import _parse_planner_json_object

    runtime_context = state.get("context")
    model = None
    temperature = 0.0
    if runtime_context and getattr(runtime_context, "agent_config", None):
        role_cfg = runtime_context.agent_config.model_roles.plan
        model = role_cfg.model or runtime_context.agent_config.model
        if role_cfg.temperature is not None:
            temperature = role_cfg.temperature
    response = await llm_provider.chat(
        messages=[{"role": "system", "content": _route_model_prompt(state)}],
        temperature=temperature,
        model=model,
        response_format={"type": "json_object"},
    )
    parsed = _parse_planner_json_object(str(getattr(response, "content", "") or "").strip())
    return _normalize_routing_decision(parsed if isinstance(parsed, dict) else None, state)


async def route_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    """Select execution mode for the current run."""
    session_id = str(state.get("session_id") or "").strip()
    runtime_context = state.get("context")
    runtime_metadata = getattr(runtime_context, "metadata", None)
    org_id = str((runtime_metadata or {}).get("org_id") or "").strip() if isinstance(runtime_metadata, dict) else ""
    runtime_event_emitter = context.get("runtime_event_emitter")
    llm_provider = context.get("llm_provider")

    await emit_runtime_event(
        runtime_event_emitter,
        event_type="route.started",
        source="runtime.route_node",
        subject=session_id or None,
        payload={"session_id": session_id, "org_id": org_id or None},
    )

    decision: RoutingDecision
    metadata: dict[str, Any] | None = None
    try:
        if not _ROUTE_ENABLED:
            decision = {
                "mode": "plan_act",
                "goal": _latest_user_text(state),
                "reason": "route feature disabled",
                "delegate_to": None,
                "dr_policy": None,
            }
        else:
            decision = _try_rule_based_route(state)
            if decision is None and llm_provider is not None:
                decision = await _classify_route_with_model(state, llm_provider)
            if decision is None:
                decision = {
                    "mode": "plan_act",
                    "goal": _latest_user_text(state),
                    "reason": "default fallback route",
                    "delegate_to": None,
                    "dr_policy": None,
                }
            if _ROUTE_SHADOW_MODE:
                metadata = dict(state.get("metadata") or {})
                metadata["route_shadow_decision"] = dict(decision)
                decision = {
                    "mode": "plan_act",
                    "goal": str(decision.get("goal") or _latest_user_text(state)).strip(),
                    "reason": f"route shadow mode active; shadow_decision={decision.get('mode')}",
                    "delegate_to": None,
                    "dr_policy": None,
                }
            else:
                metadata = None
    except Exception as exc:
        logger.warning(
            "route_node_failed_fallback_to_plan_act",
            extra={"session_id": session_id, "org_id": org_id or None, "error": str(exc)},
            exc_info=True,
        )
        decision = {
            "mode": "plan_act",
            "goal": _latest_user_text(state),
            "reason": f"route failed: {str(exc)[:200]}",
            "delegate_to": None,
            "dr_policy": None,
        }

    logger.info(
        "route_node_selected_mode",
        extra={
            "session_id": session_id,
            "org_id": org_id or None,
            "mode": decision.get("mode"),
            "reason": decision.get("reason"),
        },
    )

    await emit_runtime_event(
        runtime_event_emitter,
        event_type="route.mode_selected",
        source="runtime.route_node",
        subject=session_id or None,
        payload={
            "session_id": session_id,
            "org_id": org_id or None,
            "mode": decision.get("mode"),
            "reason": decision.get("reason"),
        },
    )
    await emit_runtime_event(
        runtime_event_emitter,
        event_type="route.completed",
        source="runtime.route_node",
        subject=session_id or None,
        payload={"session_id": session_id, "org_id": org_id or None, "mode": decision.get("mode")},
    )

    state_update = {
        "execution_mode": decision.get("mode"),
        "routing_decision": decision,
        "current_step": "route",
    }
    if _ROUTE_SHADOW_MODE and metadata is not None:
        state_update["metadata"] = metadata
    return state_update
