"""Reflect node implementation for the orchestrator state machine."""

from __future__ import annotations

from typing import Any

from src.orchestrator.execution import parse_reflection_response
from src.orchestrator.state import AgentState, ReflectionResult
from src.utils.logging import get_logger

logger = get_logger(__name__)


async def reflect_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    """Summarize execution outcomes and persist learnings when valuable."""
    logger.info(
        "Reflecting on execution",
        extra={"session_id": state["session_id"]},
    )

    event_emitter = context.get("event_emitter")
    if event_emitter:
        await event_emitter.emit_thinking("正在总结执行结果...", "concluding")

    llm_provider = context.get("llm_provider")
    memory_system = context.get("memory_system")
    runtime_context = state.get("context")
    runtime_context_metadata = getattr(runtime_context, "metadata", None)
    runtime_org_id = None
    if isinstance(runtime_context_metadata, dict):
        raw_org_id = runtime_context_metadata.get("org_id")
        if isinstance(raw_org_id, str):
            runtime_org_id = raw_org_id.strip() or None

    reflection = ReflectionResult(
        summary="Task completed.",
        lessons_learned=[],
        worth_remembering=False,
        importance=0.5,
    )

    if llm_provider:
        try:
            agent_system_prompt = ""
            agent_model = None
            if runtime_context and runtime_context.agent_config:
                agent_system_prompt = runtime_context.agent_config.system_prompt or ""
                agent_model = runtime_context.agent_config.model

            reflection_response = await llm_provider.reflect(
                messages=state["messages"],
                plan=state["plan"],
                results=state["tool_results"],
                agent_system_prompt=agent_system_prompt,
                model=agent_model,
            )
            reflection = parse_reflection_response(reflection_response)
        except Exception as e:
            logger.warning(f"Reflection generation failed: {e}")

    if reflection.worth_remembering and memory_system:
        try:
            await memory_system.save_long_term(
                agent_id=state["agent_id"],
                session_id=state["session_id"],
                content=reflection.summary,
                importance=reflection.importance,
                org_id=runtime_org_id,
                memory_type="semantic",
                metadata={"source": "reflection"},
            )
        except Exception as e:
            logger.warning(f"Failed to save to long-term memory: {e}")

    evolution_triggered = False
    try:
        from src.evolution.engine import EvolutionEngine

        evolution_engine_deps = {
            "llm": context.get("llm_provider"),
            "memory": context.get("memory_system"),
            "registry": context.get("skill_registry"),
            "db": context.get("db_pool"),
        }
        if all(evolution_engine_deps.values()):
            evolution_engine = EvolutionEngine(
                llm=evolution_engine_deps["llm"],
                memory_system=evolution_engine_deps["memory"],
                skill_registry=evolution_engine_deps["registry"],
                db_pool=evolution_engine_deps["db"],
            )
            runtime_ctx = state.get("context")
            agent_config = {}
            if runtime_ctx and hasattr(runtime_ctx, "agent_config") and runtime_ctx.agent_config:
                agent_config = runtime_ctx.agent_config.metadata if hasattr(runtime_ctx.agent_config, "metadata") else {}
            evolution_state = {
                "reflection": {"success": reflection.worth_remembering, "summary": reflection.summary},
                "tool_results": state.get("tool_results", []),
                "agent_config": agent_config,
                "agent_id": state["agent_id"],
                "org_id": runtime_org_id,
                "session_id": state["session_id"],
                "messages": state.get("messages", []),
                "plan": state.get("plan"),
            }
            await evolution_engine.maybe_evolve(evolution_state)
            evolution_triggered = True
    except Exception as e:
        logger.warning(f"[Evolution] 触发进化异常（不影响主流程）: {e}")

    return {
        "reflection": reflection,
        "current_step": "respond",
        "evolution_triggered": evolution_triggered,
    }
