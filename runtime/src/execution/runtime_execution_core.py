from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from src.events.event_engine import EventEngine
from src.events.models import Event
from src.execution.runtime_approval import build_event_engine_approval_hook
from src.execution.runtime_terminal import TerminalExecutionResult
from src.orchestrator.context import RuntimeSessionContext
from src.orchestrator.state import create_initial_state
from src.orchestrator.unified_executor import UnifiedActionExecutor


def build_graph_context(
    *,
    skill_registry: Any,
    unified_executor: Any,
    emitter: Any,
    memory_system: Any,
    llm_provider: Any = None,
) -> dict[str, Any]:
    context: dict[str, Any] = {
        "skill_registry": skill_registry,
        "unified_executor": unified_executor,
        "event_emitter": emitter,
        "runtime_event_emitter": emitter,
        "memory_system": memory_system,
    }
    if llm_provider is not None:
        context["llm_provider"] = llm_provider
    return context


def build_initial_execution_state(
    *,
    session_id: str,
    agent_id: str,
    user_message: str,
    runtime_context: RuntimeSessionContext,
    history_messages: list[dict[str, Any]] | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return create_initial_state(
        session_id=session_id,
        agent_id=agent_id,
        user_message=user_message,
        context=runtime_context,
        history_messages=history_messages,
        metadata=metadata or {},
    )


async def invoke_graph_once(
    graph: Any,
    initial_state: dict[str, Any],
    *,
    timeout_seconds: float | None = None,
) -> dict[str, Any]:
    if timeout_seconds is None:
        return await graph.ainvoke(initial_state)
    return await asyncio.wait_for(graph.ainvoke(initial_state), timeout=timeout_seconds)


async def emit_chat_message_received(
    event_engine: EventEngine,
    *,
    source: str,
    session_id: str,
    agent_id: str,
    message: str,
) -> None:
    await event_engine.emit(
        Event(
            event_id=f"evt_{uuid4().hex}",
            event_type="chat.message.received",
            source=source,
            subject=session_id,
            payload={
                "session_id": session_id,
                "agent_id": agent_id,
                "message": message,
            },
            risk_hint="low",
            timestamp=datetime.now(UTC),
        )
    )


async def emit_terminal_runtime_event(
    event_engine: EventEngine,
    *,
    source: str,
    session_id: str,
    agent_id: str,
    terminal_result: TerminalExecutionResult,
) -> None:
    await event_engine.emit(
        Event(
            event_id=f"evt_{uuid4().hex}",
            event_type=terminal_result.event_type,
            source=source,
            subject=session_id,
            payload={
                "session_id": session_id,
                "agent_id": agent_id,
                "status": terminal_result.status,
                "final_response": terminal_result.final_response,
                "awaiting_approval_message": terminal_result.awaiting_approval_message,
                "error": terminal_result.error,
                "pending_approval_ids": terminal_result.pending_approval_ids,
            },
            risk_hint=terminal_result.risk_hint,
            timestamp=datetime.now(UTC),
        )
    )


def build_unified_action_executor(
    *,
    runtime_context: RuntimeSessionContext,
    skill_registry: Any,
    event_engine: Any,
    default_session_id: str,
    approval_scope_id: str | None = None,
    attempt_id: str | None = None,
    user_message_id: str | None = None,
    mcp_client: Any = None,
    executor_cls: type[UnifiedActionExecutor] = UnifiedActionExecutor,
) -> UnifiedActionExecutor:
    return executor_cls(
        runtime_context=runtime_context,
        skill_registry=skill_registry,
        mcp_client=mcp_client,
        approval_hook=build_event_engine_approval_hook(
            event_engine=event_engine,
            default_session_id=default_session_id,
            approval_scope_id=approval_scope_id or default_session_id,
            attempt_id=attempt_id,
            user_message_id=user_message_id,
        ),
        event_emitter=event_engine,
    )
