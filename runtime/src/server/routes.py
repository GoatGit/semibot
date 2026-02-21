"""HTTP routes for the runtime server.

Endpoints:
- GET  /health                  → health check
- POST /api/v1/execute/stream   → SSE execution stream
- POST /api/v1/execute/cancel   → cancel running execution
- GET  /api/v1/files/{file_id}  → download generated file
"""

import asyncio
import json
import re
import traceback

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse
from sse_starlette.sse import EventSourceResponse

from src.constants.config import EXECUTION_STREAM_TIMEOUT
from src.mcp.bootstrap import setup_mcp_client
from src.orchestrator.context import (
    AgentConfig,
    McpServerDefinition,
    RuntimeSessionContext,
    SubAgentDefinition,
    ToolDefinition,
)
from src.orchestrator.graph import create_agent_graph
from src.orchestrator.state import create_initial_state
from src.orchestrator.unified_executor import UnifiedActionExecutor
from src.server.errors import UnifiedError
from src.server.models import HealthResponse, McpServerInput, MemoryHealthStatus, RuntimeInputState
from src.utils.logging import get_logger
from src.ws.event_emitter import EventEmitter

logger = get_logger(__name__)

router = APIRouter()

# Active task registry: session_id → asyncio.Task
_active_tasks: dict[str, asyncio.Task] = {}


def _get_skill_registry(request: Request):
    """Retrieve the skill registry stored in app state during lifespan."""
    return getattr(request.app.state, "skill_registry", None)


def _get_llm_provider(request: Request):
    """Retrieve the LLM provider stored in app state during lifespan."""
    return getattr(request.app.state, "llm_provider", None)


def _get_memory_system(request: Request):
    """Retrieve the MemorySystem stored in app state during lifespan."""
    return getattr(request.app.state, "memory_system", None)


@router.get("/health", response_model=HealthResponse)
async def health_check(request: Request) -> HealthResponse:
    """Health check endpoint with memory status."""
    memory_system = _get_memory_system(request)
    memory_status = None

    if memory_system:
        st_ok = None
        lt_ok = None
        if memory_system.short_term:
            try:
                st_ok = await memory_system.short_term.health_check()
            except Exception:
                st_ok = False
        if memory_system.long_term:
            try:
                lt_ok = await memory_system.long_term.health_check()
            except Exception:
                lt_ok = False
        memory_status = MemoryHealthStatus(short_term=st_ok, long_term=lt_ok)

    return HealthResponse(status="healthy", memory=memory_status)


@router.post("/api/v1/execute/cancel")
async def cancel_execution(request: Request):
    """Cancel a running execution by session_id."""
    from fastapi.responses import JSONResponse

    body = await request.json()
    session_id = body.get("session_id")
    if not session_id:
        return JSONResponse(status_code=400, content={"error": "session_id required"})

    task = _active_tasks.get(session_id)
    if task and not task.done():
        task.cancel()
        logger.info("Execution cancelled by user", extra={"session_id": session_id})
        return JSONResponse(content={"cancelled": True, "session_id": session_id})

    logger.info("No active task to cancel", extra={"session_id": session_id})
    return JSONResponse(content={"cancelled": False, "session_id": session_id})


@router.post("/api/v1/execute/stream")
async def execute_stream(body: RuntimeInputState, request: Request):
    """Execute the runtime orchestrator and stream SSE events."""
    emitter = EventEmitter()
    skill_registry = _get_skill_registry(request)
    llm_provider = _get_llm_provider(request)
    memory_system = _get_memory_system(request)

    async def run_graph() -> None:
        """Background task that drives the LangGraph execution."""
        mcp_client: McpClient | None = None
        trace_id = getattr(request.state, "trace_id", None)
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

            # Build MCP server definitions from input
            mcp_servers: list[McpServerDefinition] = []
            if body.available_mcp_servers:
                for srv in body.available_mcp_servers:
                    mcp_servers.append(McpServerDefinition(
                        id=srv.id,
                        name=srv.name,
                        endpoint=srv.endpoint,
                        transport=srv.transport,
                        is_connected=srv.is_connected,
                        auth_config=srv.auth_config,
                        available_tools=[
                            {"name": t.name, "description": t.description, "parameters": t.parameters}
                            for t in srv.available_tools
                        ],
                    ))

            # Build RuntimeSessionContext
            # Inject built-in tools from skill_registry into available_tools
            builtin_tools: list[ToolDefinition] = []
            if skill_registry:
                for tool_name in skill_registry.list_tools():
                    tool = skill_registry.get_tool(tool_name)
                    if tool:
                        builtin_tools.append(ToolDefinition(
                            name=tool.name,
                            description=tool.description,
                            parameters=tool.parameters,
                            metadata={"source": "builtin"},
                        ))

            runtime_context = RuntimeSessionContext(
                org_id=body.org_id,
                user_id=(body.metadata or {}).get("user_id", ""),
                agent_id=body.agent_id,
                session_id=body.session_id,
                agent_config=agent_config,
                available_tools=builtin_tools,
                available_mcp_servers=mcp_servers,
            )

            # Build SubAgent definitions from input
            sub_agents: list[SubAgentDefinition] = []
            if body.available_sub_agents:
                for sa in body.available_sub_agents:
                    sa_mcp_servers: list[McpServerDefinition] = []
                    if sa.mcp_servers:
                        for srv in sa.mcp_servers:
                            sa_mcp_servers.append(McpServerDefinition(
                                id=srv.id,
                                name=srv.name,
                                endpoint=srv.endpoint,
                                transport=srv.transport,
                                is_connected=False,
                                auth_config=srv.auth_config,
                                available_tools=[
                                    {"name": t.name, "description": t.description, "parameters": t.parameters}
                                    for t in srv.available_tools
                                ],
                            ))
                    sub_agents.append(SubAgentDefinition(
                        id=sa.id,
                        name=sa.name,
                        description=sa.description,
                        system_prompt=sa.system_prompt,
                        model=sa.model,
                        temperature=sa.temperature,
                        max_tokens=sa.max_tokens,
                        skills=sa.skills,
                        mcp_servers=sa_mcp_servers,
                    ))
                runtime_context.available_sub_agents = sub_agents

            # Build graph context dict (injected dependencies)
            context: dict[str, Any] = {
                "event_emitter": emitter,
            }
            if llm_provider:
                context["llm_provider"] = llm_provider
            if skill_registry:
                context["skill_registry"] = skill_registry
            if memory_system:
                context["memory_system"] = memory_system

            # Setup MCP client — connections run in isolated tasks to prevent
            # anyio cancel-scope leaks from poisoning this task.
            mcp_client = await setup_mcp_client(mcp_servers)

            # Update MCP server definitions with actual connection status
            if mcp_client and mcp_servers:
                for srv_def in mcp_servers:
                    srv_def.is_connected = mcp_client.is_connected(srv_def.id)

            unified_executor = UnifiedActionExecutor(
                runtime_context=runtime_context,
                skill_registry=skill_registry,
                mcp_client=mcp_client,
            )
            context["unified_executor"] = unified_executor

            # Create SubAgentDelegator if sub-agents are available
            if sub_agents:
                from src.agents.delegator import SubAgentDelegator
                delegator = SubAgentDelegator(
                    runtime_context=runtime_context,
                    llm_provider=llm_provider,
                    skill_registry=skill_registry,
                    event_emitter=emitter,
                    max_depth=2,
                )
                context["sub_agent_delegator"] = delegator

            # Create the graph
            graph = create_agent_graph(context=context, runtime_context=runtime_context)

            # Build initial state
            initial_state = create_initial_state(
                session_id=body.session_id,
                agent_id=body.agent_id,
                org_id=body.org_id,
                user_message=body.user_message,
                context=runtime_context,
                history_messages=[msg.model_dump() for msg in body.history_messages] if body.history_messages else None,
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

        except asyncio.CancelledError:
            logger.info("Execution cancelled by user", extra={
                "session_id": body.session_id,
            })
            await emitter.emit_execution_error(
                "Execution cancelled by user",
                code="EXECUTION_CANCELLED",
                http_status=499,
                trace_id=trace_id,
            )
        except asyncio.TimeoutError:
            logger.error("Execution timed out", extra={
                "session_id": body.session_id,
                "timeout": EXECUTION_STREAM_TIMEOUT,
            })
            await emitter.emit_execution_error(
                "Execution timed out",
                code="EXTERNAL_TOOL_TIMEOUT",
                http_status=504,
                trace_id=trace_id,
            )
        except UnifiedError as e:
            logger.error("Execution failed (UnifiedError): %s", str(e), extra={
                "session_id": body.session_id,
                "error_code": e.code,
            })
            await emitter.emit_execution_error(
                e.message,
                code=e.code,
                http_status=e.http_status,
                details=e.details,
                trace_id=trace_id or e.trace_id,
            )
        except BaseException as e:
            logger.error("Execution failed: %s\n%s", str(e), traceback.format_exc(), extra={
                "session_id": body.session_id,
                "error": str(e),
            })
            await emitter.emit_execution_error(
                str(e),
                code="INTERNAL_ERROR",
                http_status=500,
                trace_id=trace_id,
            )
        finally:
            _active_tasks.pop(body.session_id, None)
            if mcp_client:
                try:
                    await mcp_client.close_all()
                except Exception as e:
                    logger.error(f"Failed to close MCP connections: {e}")
            await emitter.close()

    async def ping_keepalive():
        """Send periodic ping events to prevent API-side stall timeouts."""
        try:
            while not emitter._closed:
                await asyncio.sleep(15)
                if not emitter._closed:
                    await emitter.emit_ping()
        except asyncio.CancelledError:
            pass

    # Launch graph execution and ping keepalive in background
    graph_task = asyncio.create_task(run_graph())
    _active_tasks[body.session_id] = graph_task
    ping_task = asyncio.create_task(ping_keepalive())

    async def event_generator():
        """Yield SSE events from the emitter queue."""
        try:
            async for event in emitter:
                yield {"data": json.dumps(event, ensure_ascii=False, default=str)}
            yield {"data": "[DONE]"}
        finally:
            ping_task.cancel()
            # Safety net: cancel graph task if still running (e.g. client disconnected)
            if not graph_task.done():
                graph_task.cancel()
                logger.info("graph_task cancelled by event_generator safety net", extra={
                    "session_id": body.session_id,
                })
            _active_tasks.pop(body.session_id, None)

    return EventSourceResponse(event_generator())


# Valid file_id pattern: 32 hex characters (uuid4 without dashes)
_FILE_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")


def _get_file_manager(request: Request):
    """Retrieve the FileManager stored in app state during lifespan."""
    return getattr(request.app.state, "file_manager", None)


@router.get("/api/v1/files/{file_id}")
async def download_file(file_id: str, request: Request):
    """Download a generated file by its ID."""
    from fastapi.responses import JSONResponse

    if not _FILE_ID_PATTERN.match(file_id):
        return JSONResponse(
            status_code=400,
            content={"error": "Invalid file_id format"},
        )

    file_manager = _get_file_manager(request)
    if file_manager is None:
        return JSONResponse(
            status_code=503,
            content={"error": "File manager not available"},
        )

    file_path = file_manager.get_file_path(file_id)
    if file_path is None or not file_path.exists():
        return JSONResponse(
            status_code=404,
            content={"error": "File not found"},
        )

    return FileResponse(
        path=str(file_path),
        filename=file_path.name,
        media_type=None,  # Let FastAPI guess from extension
    )
