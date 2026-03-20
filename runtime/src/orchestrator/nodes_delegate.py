"""Delegate node for the orchestrator graph."""

from __future__ import annotations

from typing import Any

from src.memory.service import render_memory_snapshot
from src.orchestrator.state import AgentState, ToolCallResult
from src.utils.logging import get_logger

logger = get_logger(__name__)


async def delegate_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    """
    DELEGATE node: Delegate task to a SubAgent.

    This node:
    1. Identifies the appropriate SubAgent
    2. Prepares the delegation context
    3. Executes the SubAgent
    4. Collects the SubAgent's results
    """
    logger.info(
        "Delegating to SubAgent",
        extra={
            "session_id": state["session_id"],
            "sub_agent_id": state["plan"].sub_agent_id if state["plan"] else None,
        },
    )

    event_emitter = context.get("event_emitter")
    delegator = context.get("sub_agent_delegator")
    plan = state["plan"]

    if not plan:
        return {
            "error": "Delegation not configured or no target specified",
            "current_step": "observe",
        }

    if not delegator or not plan.sub_agent_id:
        error_text = "Delegation unavailable in current runtime"
        logger.warning(
            error_text,
            extra={
                "session_id": state["session_id"],
                "sub_agent_id": plan.sub_agent_id,
                "delegator_configured": bool(delegator),
            },
        )
        failed_result = ToolCallResult(
            tool_name=f"subagent:{plan.sub_agent_id or 'unknown'}",
            params={"task": plan.goal, "context": plan.delegate_context or ""},
            error=error_text,
            success=False,
        )
        return {
            "error": error_text,
            "tool_results": [failed_result],
            "current_step": "observe",
        }

    try:
        if event_emitter:
            await event_emitter.emit_skill_call_start(
                plan.sub_agent_id, f"subagent:{plan.sub_agent_id}", {"task": plan.goal},
            )

        task = plan.goal
        delegation_context = {
            "memory": render_memory_snapshot(state.get("memory_snapshot", {})) or state.get("memory_context", ""),
            "memory_snapshot": state.get("memory_snapshot", {}),
            "parent_session_id": state["session_id"],
        }
        if plan.delegate_context:
            delegation_context["planner_context"] = plan.delegate_context
        if plan.delegate_reason:
            delegation_context["why_delegate"] = plan.delegate_reason
        if plan.delegate_return_conditions:
            delegation_context["return_conditions"] = list(plan.delegate_return_conditions)

        result = await delegator.delegate(
            sub_agent_id=plan.sub_agent_id,
            task=task,
            context=delegation_context,
        )

        delegated_response = str(result.get("result") or "").strip()
        tool_result = ToolCallResult(
            tool_name=f"subagent:{plan.sub_agent_id}",
            params={
                "task": task,
                "context": plan.delegate_context or "",
                "why_delegate": plan.delegate_reason or "",
                "expected_outputs": list(plan.delegate_expected_outputs or []),
                "return_conditions": list(plan.delegate_return_conditions or []),
            },
            result=delegated_response or result.get("result"),
            success=not result.get("error"),
            error=result.get("error"),
            metadata={
                "delegate": True,
                "sub_agent_id": plan.sub_agent_id,
                "why_delegate": plan.delegate_reason or "",
                "expected_outputs": list(plan.delegate_expected_outputs or []),
                "return_conditions": list(plan.delegate_return_conditions or []),
            },
        )

        if event_emitter:
            await event_emitter.emit_skill_call_complete(
                plan.sub_agent_id,
                f"subagent:{plan.sub_agent_id}",
                delegated_response or result.get("result"),
                not result.get("error"),
                error=result.get("error"),
            )

        return {
            "tool_results": [tool_result],
            "current_step": "observe",
        }

    except Exception as e:
        logger.error(f"Delegation failed: {e}")

        if event_emitter:
            await event_emitter.emit_skill_call_complete(
                plan.sub_agent_id,
                f"subagent:{plan.sub_agent_id}",
                None,
                False,
                error=str(e),
            )

        return {
            "error": f"Delegation failed: {e}",
            "tool_results": [
                ToolCallResult(
                    tool_name=f"subagent:{plan.sub_agent_id}",
                    params={},
                    error=str(e),
                    success=False,
                )
            ],
            "current_step": "observe",
        }
