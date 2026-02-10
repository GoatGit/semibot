"""HTTP routes for the runtime server.

Endpoints:
- GET  /health                  → health check
- POST /api/v1/execute/stream   → SSE execution stream
"""

import asyncio
import json
from typing import Any

from fastapi import APIRouter, Request
from sse_starlette.sse import EventSourceResponse

from src.constants.config import EXECUTION_STREAM_TIMEOUT
from src.orchestrator.context import (
    AgentConfig,
    RuntimeSessionContext,
)
from src.orchestrator.graph import create_agent_graph
from src.orchestrator.state import create_initial_state
from src.server.event_emitter import EventEmitter
from src.server.models import HealthResponse, RuntimeInputState
from src.utils.logging import get_logger

logger = get_logger(__name__)

router = APIRouter()


def _get_skill_registry(request: Request):
    """Retrieve the skill registry stored in app state during lifespan."""
    return getattr(request.app.state, "skill_registry", None)


@router.get("/health", response_model=HealthResponse)
async def health_check() -> HealthResponse:
    """Health check endpoint."""
    return HealthResponse(status="healthy")


@router.post("/api/v1/execute/stream")
async def execute_stream(body: RuntimeInputState, request: Request):
    """Execute the runtime orchestrator and stream SSE events."""
    emitter = EventEmitter()
    skill_registry = _get_skill_registry(request)

    async def run_graph() -> None:
        """Background task that drives the LangGraph execution."""
        try:
            # Build AgentConfig from input
            agent_cfg_input = body.agent_config
            agent_config = AgentConfig(
                id=body.agent_id,
                name=body.agent_id,
                system_prompt=agent_cfg_input.system_prompt if agent_cfg_input else None,
                model=agent_cfg_input.model if agent_cfg_input else None,
                temperature=agent_cfg_input.temperature if agent_cfg_input else 0.7,
                max_tokens=agent_cfg_input.max_tokens if agent_cfg_input else 4096,
            )

            # Build RuntimeSessionContext
            runtime_context = RuntimeSessionContext(
                org_id=body.org_id,
                user_id=(body.metadata or {}).get("user_id", ""),
                agent_id=body.agent_id,
                session_id=body.session_id,
                agent_config=agent_config,
            )

            # Build graph context dict (injected dependencies)
            context: dict[str, Any] = {
                "event_emitter": emitter,
            }
            if skill_registry:
                context["skill_registry"] = skill_registry

            # Create the graph
            graph = create_agent_graph(context=context, runtime_context=runtime_context)

            # Build initial state
            initial_state = create_initial_state(
                session_id=body.session_id,
                agent_id=body.agent_id,
                org_id=body.org_id,
                user_message=body.user_message,
                context=runtime_context,
                metadata=body.metadata,
            )

            # Execute with timeout
            result = await asyncio.wait_for(
                graph.ainvoke(initial_state),
                timeout=EXECUTION_STREAM_TIMEOUT,
            )

            # Extract final response from result messages
            final_response = ""
            messages = result.get("messages", [])
            if messages:
                last_msg = messages[-1]
                if isinstance(last_msg, dict):
                    final_response = last_msg.get("content", "")
                else:
                    final_response = getattr(last_msg, "content", "")

            await emitter.emit_execution_complete(final_response)

        except asyncio.TimeoutError:
            logger.error("Execution timed out", extra={
                "session_id": body.session_id,
                "timeout": EXECUTION_STREAM_TIMEOUT,
            })
            await emitter.emit_execution_error("Execution timed out")
        except Exception as e:
            logger.error("Execution failed", extra={
                "session_id": body.session_id,
                "error": str(e),
            })
            await emitter.emit_execution_error(str(e))
        finally:
            await emitter.close()

    # Launch graph execution in background
    asyncio.create_task(run_graph())

    async def event_generator():
        """Yield SSE events from the emitter queue."""
        async for event in emitter:
            yield {"data": json.dumps(event, ensure_ascii=False, default=str)}
        yield {"data": "[DONE]"}

    return EventSourceResponse(event_generator())
