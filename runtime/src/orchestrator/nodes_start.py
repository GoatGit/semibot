"""START node for orchestrator state machine."""

import time
from typing import Any

from src.memory.service import empty_memory_snapshot
from src.orchestrator.state import AgentState
from src.utils.logging import get_logger

logger = get_logger(__name__)


async def start_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    """Initialize execution context and load memories."""
    started_at = time.time()
    logger.info(
        "Starting agent execution",
        extra={"session_id": state["session_id"], "agent_id": state["agent_id"]},
    )

    event_emitter = context.get("event_emitter")
    if event_emitter:
        await event_emitter.emit_thinking("正在初始化执行上下文...", "analyzing")

    memory_system = context.get("memory_system")
    memory_context = ""
    memory_snapshot = empty_memory_snapshot()
    runtime_context = state.get("context")
    runtime_context_metadata = getattr(runtime_context, "metadata", None)
    runtime_org_id = None
    if isinstance(runtime_context_metadata, dict):
        raw_org_id = runtime_context_metadata.get("org_id")
        if isinstance(raw_org_id, str):
            runtime_org_id = raw_org_id.strip() or None

    if memory_system:
        try:
            user_message = state["messages"][-1]["content"] if state["messages"] else ""
            memory_started_at = time.time()
            memory_snapshot = await memory_system.build_memory_context(
                session_id=state["session_id"],
                agent_id=state["agent_id"],
                query=user_message,
                org_id=runtime_org_id,
                long_term_limit=5,
            )
            memory_context = str(memory_snapshot.get("memory_context") or "")
            logger.info(
                "start_node_memory_context_ready",
                extra={
                    "session_id": state["session_id"],
                    "agent_id": state["agent_id"],
                    "duration_ms": int((time.time() - memory_started_at) * 1000),
                    "short_term_chars": len(str(memory_snapshot.get("short_term") or "")),
                    "long_term_results": len(memory_snapshot.get("long_term_results") or []),
                },
            )
        except Exception as exc:
            logger.error(f"Failed to load memory: {exc}", exc_info=True)

    logger.info(
        "start_node_completed",
        extra={
            "session_id": state["session_id"],
            "agent_id": state["agent_id"],
            "duration_ms": int((time.time() - started_at) * 1000),
            "memory_context_chars": len(memory_context),
        },
    )
    return {
        "memory_context": memory_context,
        "memory_snapshot": memory_snapshot,
        "iteration": 0,
        "current_step": "plan",
    }
