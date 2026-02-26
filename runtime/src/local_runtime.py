"""Local one-off runtime execution for Semibot V2 CLI."""

from __future__ import annotations

import os
import time
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from src.events.event_engine import EventEngine
from src.events.event_router import EventRouter
from src.events.event_store import EventStore
from src.events.models import Event
from src.events.runtime_action_executor import RuntimeActionExecutor
from src.llm.base import LLMConfig
from src.llm.openai_provider import OpenAIProvider
from src.orchestrator.context import (
    AgentConfig,
    RuntimeSessionContext,
    SkillDefinition,
    ToolDefinition,
)
from src.orchestrator.graph import create_agent_graph
from src.orchestrator.state import create_initial_state
from src.orchestrator.unified_executor import UnifiedActionExecutor
from src.skills.bootstrap import create_default_registry
from src.skills.registry import SkillRegistry


def _create_llm_provider(model: str | None = None) -> OpenAIProvider | None:
    api_key = os.getenv("OPENAI_API_KEY") or os.getenv("CUSTOM_LLM_API_KEY")
    if not api_key:
        return None

    resolved_model = model or os.getenv("CUSTOM_LLM_MODEL_NAME") or "gpt-4o"
    base_url = os.getenv("OPENAI_API_BASE_URL") or os.getenv("CUSTOM_LLM_API_BASE_URL") or None
    if base_url and "openai.azure.com" not in base_url and not base_url.rstrip("/").endswith("/v1"):
        base_url = f"{base_url.rstrip('/')}/v1"

    return OpenAIProvider(
        LLMConfig(
            model=resolved_model,
            api_key=api_key,
            base_url=base_url,
            timeout=120,
        )
    )


def _build_tool_definitions(registry: SkillRegistry) -> list[ToolDefinition]:
    tools: list[ToolDefinition] = []
    for tool_name in registry.list_tools():
        tool = registry.get_tool(tool_name)
        if not tool:
            continue
        tools.append(
            ToolDefinition(
                name=tool.name,
                description=tool.description,
                parameters=tool.parameters,
                metadata={"source": "builtin"},
            )
        )
    return tools


def _build_skill_definitions(registry: SkillRegistry) -> list[SkillDefinition]:
    skills: list[SkillDefinition] = []
    for skill_name in registry.list_skills():
        skill = registry.get_skill(skill_name)
        if not skill:
            continue
        skills.append(
            SkillDefinition(
                id=skill_name,
                name=skill_name,
                description=skill.description,
                source="local",
                schema={},
                metadata={},
            )
        )
    return skills


def _extract_final_response(result: dict[str, Any]) -> str:
    messages = result.get("messages")
    if not isinstance(messages, list) or not messages:
        return ""
    last = messages[-1]
    if isinstance(last, dict):
        return str(last.get("content") or "")
    return str(getattr(last, "content", ""))


def _serialize_tool_results(result: dict[str, Any]) -> list[dict[str, Any]]:
    rows = result.get("tool_results")
    if not isinstance(rows, list):
        return []
    serialized: list[dict[str, Any]] = []
    for item in rows:
        if hasattr(item, "model_dump"):
            serialized.append(dict(item.model_dump()))
            continue
        if isinstance(item, dict):
            serialized.append(dict(item))
            continue
        tool_name = getattr(item, "tool_name", None)
        params = getattr(item, "params", None)
        serialized.append(
            {
                "tool_name": str(tool_name or ""),
                "params": dict(params) if isinstance(params, dict) else {},
                "result": getattr(item, "result", None),
                "error": getattr(item, "error", None),
                "duration_ms": int(getattr(item, "duration_ms", 0) or 0),
                "success": bool(getattr(item, "success", False)),
                "metadata": getattr(item, "metadata", {}) or {},
            }
        )
    return serialized


async def run_task_once(
    *,
    task: str,
    db_path: str,
    rules_path: str,
    agent_id: str = "semibot",
    session_id: str | None = None,
    model: str | None = None,
    system_prompt: str | None = None,
) -> dict[str, Any]:
    """Run one user task locally and return execution summary."""
    resolved_session_id = session_id or f"local_{int(time.time() * 1000)}_{uuid4().hex[:8]}"
    runtime_events: list[dict[str, Any]] = []

    async def _runtime_event_sink(event: dict[str, Any]) -> None:
        runtime_events.append(event)

    skill_registry = create_default_registry()
    event_engine = EventEngine(
        store=EventStore(db_path=db_path),
        router=EventRouter(RuntimeActionExecutor(runtime_event_sink=_runtime_event_sink)),
        rules_path=rules_path,
    )
    event_engine.reload_rules()
    llm_provider = _create_llm_provider(model)

    runtime_context = RuntimeSessionContext(
        agent_id=agent_id,
        session_id=resolved_session_id,
        agent_config=AgentConfig(
            id=agent_id,
            name=agent_id,
            system_prompt=system_prompt,
            model=model,
        ),
        metadata={"event_emitter": event_engine},
        available_skills=_build_skill_definitions(skill_registry),
        available_tools=_build_tool_definitions(skill_registry),
        available_mcp_servers=[],
        available_sub_agents=[],
    )

    unified_executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=skill_registry,
        mcp_client=None,
        event_emitter=event_engine,
    )

    graph_context: dict[str, Any] = {
        "skill_registry": skill_registry,
        "unified_executor": unified_executor,
    }
    if llm_provider:
        graph_context["llm_provider"] = llm_provider

    graph: Any = create_agent_graph(context=graph_context, runtime_context=runtime_context)
    initial_state = create_initial_state(
        session_id=resolved_session_id,
        agent_id=agent_id,
        user_message=task,
        context=runtime_context,
        metadata={"entrypoint": "cli.run"},
    )

    await event_engine.emit(
        Event(
            event_id=f"evt_{uuid4().hex}",
            event_type="chat.message.received",
            source="cli.run",
            subject=resolved_session_id,
            payload={
                "session_id": resolved_session_id,
                "agent_id": agent_id,
                "message": task,
            },
            risk_hint="low",
            timestamp=datetime.now(UTC),
        )
    )

    try:
        result = await graph.ainvoke(initial_state)
        error = str(result.get("error")) if result.get("error") else None
        status = "failed" if error else "completed"
        final_response = _extract_final_response(result)
        tool_results = _serialize_tool_results(result)

        await event_engine.emit(
            Event(
                event_id=f"evt_{uuid4().hex}",
                event_type="task.completed" if status == "completed" else "task.failed",
                source="cli.run",
                subject=resolved_session_id,
                payload={
                    "session_id": resolved_session_id,
                    "agent_id": agent_id,
                    "status": status,
                    "final_response": final_response,
                    "error": error,
                },
                risk_hint="low" if status == "completed" else "medium",
                timestamp=datetime.now(UTC),
            )
        )

        return {
            "status": status,
            "session_id": resolved_session_id,
            "agent_id": agent_id,
            "final_response": final_response,
            "error": error,
            "tool_results": tool_results,
            "runtime_events": runtime_events,
            "llm_configured": llm_provider is not None,
        }
    except Exception as exc:
        message = str(exc)
        await event_engine.emit(
            Event(
                event_id=f"evt_{uuid4().hex}",
                event_type="task.failed",
                source="cli.run",
                subject=resolved_session_id,
                payload={
                    "session_id": resolved_session_id,
                    "agent_id": agent_id,
                    "status": "failed",
                    "error": message,
                },
                risk_hint="medium",
                timestamp=datetime.now(UTC),
            )
        )
        return {
            "status": "failed",
            "session_id": resolved_session_id,
            "agent_id": agent_id,
            "final_response": "",
            "error": message,
            "tool_results": [],
            "runtime_events": runtime_events,
            "llm_configured": llm_provider is not None,
        }
