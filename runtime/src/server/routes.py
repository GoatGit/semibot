"""HTTP routes for the runtime server.

Endpoints:
- GET  /health                  → health check
- POST /api/v1/execute/stream   → SSE execution stream
- GET  /api/v1/files/{file_id}  → download generated file
"""

import asyncio
import json
import re
import traceback
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse
from sse_starlette.sse import EventSourceResponse

from src.constants.config import EXECUTION_STREAM_TIMEOUT
from src.mcp.client import McpClient
from src.mcp.models import McpServerConfig
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
from src.server.event_emitter import EventEmitter
from src.server.models import HealthResponse, McpServerInput, RuntimeInputState
from src.utils.logging import get_logger

logger = get_logger(__name__)

router = APIRouter()

# MCP connection timeout (seconds)
MCP_CONNECT_TIMEOUT = 15


def _get_skill_registry(request: Request):
    """Retrieve the skill registry stored in app state during lifespan."""
    return getattr(request.app.state, "skill_registry", None)


def _get_llm_provider(request: Request):
    """Retrieve the LLM provider stored in app state during lifespan."""
    return getattr(request.app.state, "llm_provider", None)


async def _connect_single_mcp(
    mcp_client: McpClient, srv_input: McpServerInput
) -> bool:
    """Connect to a single MCP server in an isolated task.

    Running in a separate asyncio.Task prevents anyio cancel-scope leaks
    from poisoning the caller's task when the MCP handshake fails.

    Returns True on success, False on failure.
    """
    transport = srv_input.transport.lower()
    if transport in ("sse", "http", "streamable_http"):
        connection_params: dict[str, Any] = {"url": srv_input.endpoint}
        if srv_input.auth_config:
            headers: dict[str, str] = {}
            api_key = srv_input.auth_config.get("apiKey") or srv_input.auth_config.get("api_key")
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            if headers:
                connection_params["headers"] = headers
    elif transport == "stdio":
        connection_params = {"command": srv_input.endpoint}
    else:
        logger.warning(f"Unsupported MCP transport: {transport}, skipping {srv_input.name}")
        return False

    config = McpServerConfig(
        server_id=srv_input.id,
        server_name=srv_input.name,
        transport_type=transport if transport != "sse" else "http",
        connection_params=connection_params,
    )
    try:
        await mcp_client.add_server(config)
        await mcp_client.connect(srv_input.id)
        logger.info(f"Connected to MCP server: {srv_input.name}")
        return True
    except BaseException as e:
        logger.error(f"Failed to connect to MCP server {srv_input.name}: {e}")
        return False


async def _setup_mcp_client(
    mcp_servers: list[McpServerInput],
) -> McpClient | None:
    """Create McpClient and connect to all servers.

    Each connection runs in its own asyncio.Task to isolate anyio cancel
    scopes.  If all connections fail the client is still returned (with no
    connected servers) so the graph can run without MCP tools.
    """
    if not mcp_servers:
        return None

    mcp_client = McpClient()
    for srv_input in mcp_servers:
        # Run each connection in a separate task to isolate cancel scopes
        try:
            task = asyncio.create_task(
                _connect_single_mcp(mcp_client, srv_input)
            )
            await asyncio.wait_for(task, timeout=MCP_CONNECT_TIMEOUT)
        except (asyncio.TimeoutError, asyncio.CancelledError) as e:
            logger.error(
                f"MCP server {srv_input.name} connection timed out or cancelled: {e}"
            )
        except Exception as e:
            logger.error(
                f"MCP server {srv_input.name} connection error: {e}"
            )

    return mcp_client


@router.get("/health", response_model=HealthResponse)
async def health_check() -> HealthResponse:
    """Health check endpoint."""
    return HealthResponse(status="healthy")


@router.post("/api/v1/execute/stream")
async def execute_stream(body: RuntimeInputState, request: Request):
    """Execute the runtime orchestrator and stream SSE events."""
    emitter = EventEmitter()
    skill_registry = _get_skill_registry(request)
    llm_provider = _get_llm_provider(request)

    async def run_graph() -> None:
        """Background task that drives the LangGraph execution."""
        mcp_client: McpClient | None = None
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

            # Setup MCP client — connections run in isolated tasks to prevent
            # anyio cancel-scope leaks from poisoning this task.
            mcp_client = await _setup_mcp_client(body.available_mcp_servers or [])

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
        except BaseException as e:
            logger.error("Execution failed: %s\n%s", str(e), traceback.format_exc(), extra={
                "session_id": body.session_id,
                "error": str(e),
            })
            await emitter.emit_execution_error(str(e))
        finally:
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
    asyncio.create_task(run_graph())
    ping_task = asyncio.create_task(ping_keepalive())

    async def event_generator():
        """Yield SSE events from the emitter queue."""
        try:
            async for event in emitter:
                yield {"data": json.dumps(event, ensure_ascii=False, default=str)}
            yield {"data": "[DONE]"}
        finally:
            ping_task.cancel()

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
