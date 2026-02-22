from __future__ import annotations

import asyncio
import os
import shlex
from typing import Any

from src.mcp.client import McpClient
from src.mcp.models import McpServerConfig
from src.orchestrator.context import McpServerDefinition
from src.utils.logging import get_logger

logger = get_logger(__name__)

MCP_CONNECT_TIMEOUT = 15


def _build_connection_params(server: McpServerDefinition) -> tuple[str, dict[str, Any]] | None:
    transport = (server.transport or "").lower()
    if transport in ("sse", "http", "streamable_http"):
        params: dict[str, Any] = {"url": server.endpoint}
        auth_config = server.auth_config or {}
        headers: dict[str, str] = {}
        api_key = auth_config.get("apiKey") or auth_config.get("api_key")
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        if headers:
            params["headers"] = headers
        normalized_transport = "http" if transport == "sse" else transport
        return normalized_transport, params
    if transport == "stdio":
        try:
            parts = shlex.split(server.endpoint)
        except ValueError:
            logger.warning("invalid_stdio_endpoint", extra={"server_id": server.id, "endpoint": server.endpoint})
            return None

        if not parts:
            logger.warning("empty_stdio_endpoint", extra={"server_id": server.id})
            return None

        command = parts[0]
        args = parts[1:]

        auth_config = server.auth_config or {}
        api_key = auth_config.get("apiKey") or auth_config.get("api_key")
        env_overrides = auth_config.get("env") if isinstance(auth_config.get("env"), dict) else {}
        env: dict[str, str] = {
            str(k): str(v)
            for k, v in (env_overrides or {}).items()
            if v is not None
        }
        if api_key:
            # Generic convention
            env.setdefault("MCP_API_KEY", str(api_key))
            # Common provider conventions
            marker = f"{server.name} {server.id} {server.endpoint}".lower()
            if "tavily" in marker:
                env.setdefault("TAVILY_API_KEY", str(api_key))
            if "brave" in marker:
                env.setdefault("BRAVE_API_KEY", str(api_key))
            if "github" in marker:
                env.setdefault("GITHUB_TOKEN", str(api_key))

        # Some MCP servers read keys from parent env; mirror if available.
        for key in ("TAVILY_API_KEY", "BRAVE_API_KEY", "GITHUB_TOKEN", "MCP_API_KEY"):
            if key not in env and os.getenv(key):
                env[key] = os.getenv(key, "")

        return "stdio", {"command": command, "args": args, "env": env}
    logger.warning("unsupported_mcp_transport", extra={"transport": transport, "server_id": server.id})
    return None


async def connect_single_mcp(mcp_client: McpClient, server: McpServerDefinition) -> bool:
    built = _build_connection_params(server)
    if built is None:
        return False
    transport, connection_params = built
    config = McpServerConfig(
        server_id=server.id,
        server_name=server.name,
        transport_type=transport,
        connection_params=connection_params,
    )
    try:
        await mcp_client.add_server(config)
        await mcp_client.connect(server.id)
        logger.info("mcp_connected", extra={"server_id": server.id, "server_name": server.name})
        return True
    except BaseException as exc:
        logger.error("mcp_connect_failed", extra={"server_id": server.id, "error": str(exc)})
        return False


async def setup_mcp_client(
    mcp_servers: list[McpServerDefinition],
    connect_timeout: int = MCP_CONNECT_TIMEOUT,
) -> McpClient | None:
    if not mcp_servers:
        return None

    mcp_client = McpClient()
    for server in mcp_servers:
        try:
            await asyncio.wait_for(
                connect_single_mcp(mcp_client, server),
                timeout=connect_timeout,
            )
        except (asyncio.TimeoutError, asyncio.CancelledError) as exc:
            logger.error("mcp_connect_timeout_or_cancelled", extra={"server_id": server.id, "error": str(exc)})
        except Exception as exc:
            logger.error("mcp_connect_error", extra={"server_id": server.id, "error": str(exc)})
    return mcp_client
