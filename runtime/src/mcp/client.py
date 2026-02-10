"""MCP client implementation using the MCP SDK.

This module provides the MCP client for connecting to and interacting with
MCP servers. It supports multiple transport types (stdio, http/sse, websocket).
"""

import asyncio
import os
from contextlib import AsyncExitStack
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.sse import sse_client
from tenacity import retry, stop_after_attempt, wait_exponential

from src.constants.config import (
    MCP_CALL_TIMEOUT,
    MCP_CONNECTION_TIMEOUT,
    MCP_MAX_RETRIES,
)
from src.mcp.models import (
    McpConnectionStatus,
    McpError,
    McpErrorCode,
    McpServerConfig,
    McpTransportType,
)
from src.utils.logging import get_logger

logger = get_logger(__name__)

# 功能开关：默认启用 MCP 功能
MCP_ENABLED = os.getenv("MCP_ENABLED", "true").lower() == "true"


class McpClient:
    """
    MCP client for connecting to and interacting with MCP servers.

    This client manages connections to multiple MCP servers and provides
    a unified interface for calling tools and accessing resources.
    """

    def __init__(self) -> None:
        """Initialize the MCP client."""
        self._servers: dict[str, McpServerConfig] = {}
        self._sessions: dict[str, ClientSession] = {}
        self._exit_stacks: dict[str, AsyncExitStack] = {}
        self._connection_status: dict[str, McpConnectionStatus] = {}

    async def add_server(self, config: McpServerConfig) -> None:
        """
        Add an MCP server configuration.

        Args:
            config: MCP server configuration

        Raises:
            McpError: If server already exists
        """
        if config.server_id in self._servers:
            raise McpError(
                code=McpErrorCode.SERVER_ERROR,
                message=f"Server {config.server_id} already exists",
            )

        self._servers[config.server_id] = config
        self._connection_status[config.server_id] = McpConnectionStatus.DISCONNECTED

        logger.info(
            f"Added MCP server: {config.server_name} ({config.server_id})",
            extra={"server_id": config.server_id, "transport": config.transport_type},
        )

    async def connect(self, server_id: str) -> None:
        """
        Connect to an MCP server.

        Args:
            server_id: Server ID to connect to

        Raises:
            McpError: If connection fails or MCP is disabled
        """
        if not MCP_ENABLED:
            logger.warning(
                "[MCP] MCP 功能已禁用，跳过连接",
                extra={"server_id": server_id},
            )
            raise McpError(
                code=McpErrorCode.CONNECTION_FAILED,
                message="MCP functionality is disabled. Set MCP_ENABLED=true to enable.",
            )

        if server_id not in self._servers:
            raise McpError(
                code=McpErrorCode.SERVER_ERROR,
                message=f"Server {server_id} not found",
            )

        config = self._servers[server_id]
        self._connection_status[server_id] = McpConnectionStatus.CONNECTING

        logger.info(
            f"Connecting to MCP server: {config.server_name}",
            extra={"server_id": server_id, "transport": config.transport_type},
        )

        try:
            exit_stack = AsyncExitStack()
            await exit_stack.__aenter__()

            transport_type = config.transport_type.lower()
            params = config.connection_params

            if transport_type == McpTransportType.STDIO.value:
                server_params = StdioServerParameters(
                    command=params["command"],
                    args=params.get("args", []),
                    env=params.get("env"),
                )
                stdio_transport = await exit_stack.enter_async_context(
                    stdio_client(server_params)
                )
                read_stream, write_stream = stdio_transport
                session = await exit_stack.enter_async_context(
                    ClientSession(read_stream, write_stream)
                )

            elif transport_type == McpTransportType.HTTP_SSE.value:
                url = params["url"]
                headers = params.get("headers", {})
                sse_transport = await exit_stack.enter_async_context(
                    sse_client(url=url, headers=headers)
                )
                read_stream, write_stream = sse_transport
                session = await exit_stack.enter_async_context(
                    ClientSession(read_stream, write_stream)
                )

            else:
                await exit_stack.aclose()
                raise McpError(
                    code=McpErrorCode.CONNECTION_FAILED,
                    message=f"Unsupported transport type: {transport_type}",
                )

            # Initialize the session (MCP handshake)
            await asyncio.wait_for(
                session.initialize(),
                timeout=MCP_CONNECTION_TIMEOUT,
            )

            self._sessions[server_id] = session
            self._exit_stacks[server_id] = exit_stack
            self._connection_status[server_id] = McpConnectionStatus.CONNECTED

            logger.info(
                f"Connected to MCP server: {config.server_name}",
                extra={"server_id": server_id},
            )

        except asyncio.TimeoutError:
            self._connection_status[server_id] = McpConnectionStatus.ERROR
            logger.error(
                "MCP connection timed out",
                extra={"server_id": server_id, "timeout": MCP_CONNECTION_TIMEOUT},
            )
            raise McpError(
                code=McpErrorCode.CONNECTION_TIMEOUT,
                message=f"Connection to server {server_id} timed out after {MCP_CONNECTION_TIMEOUT}s",
            )
        except McpError:
            self._connection_status[server_id] = McpConnectionStatus.ERROR
            raise
        except Exception as e:
            self._connection_status[server_id] = McpConnectionStatus.ERROR
            logger.error(
                f"Failed to connect to MCP server: {e}",
                extra={"server_id": server_id},
            )
            raise McpError(
                code=McpErrorCode.CONNECTION_FAILED,
                message=f"Failed to connect to server {server_id}: {str(e)}",
            )

    async def disconnect(self, server_id: str) -> None:
        """
        Disconnect from an MCP server.

        Args:
            server_id: Server ID to disconnect from
        """
        if server_id not in self._servers:
            logger.warning(f"Server {server_id} not found")
            return

        logger.info(
            f"Disconnecting from MCP server: {self._servers[server_id].server_name}",
            extra={"server_id": server_id},
        )

        # Close the exit stack which cleans up session + transport
        exit_stack = self._exit_stacks.pop(server_id, None)
        if exit_stack:
            try:
                await exit_stack.aclose()
            except Exception as e:
                logger.error(f"Error closing exit stack for {server_id}: {e}")

        self._sessions.pop(server_id, None)
        self._connection_status[server_id] = McpConnectionStatus.DISCONNECTED

    def get_connection_status(self, server_id: str) -> McpConnectionStatus:
        """
        Get connection status for a server.

        Args:
            server_id: Server ID

        Returns:
            Connection status
        """
        return self._connection_status.get(server_id, McpConnectionStatus.DISCONNECTED)

    def is_connected(self, server_id: str) -> bool:
        """
        Check if a server is connected.

        Args:
            server_id: Server ID

        Returns:
            True if connected, False otherwise
        """
        return self.get_connection_status(server_id) == McpConnectionStatus.CONNECTED

    async def call_tool(
        self,
        server_id: str,
        tool_name: str,
        arguments: dict[str, Any],
        timeout: int | None = None,
    ) -> Any:
        """
        Call a tool on an MCP server with retry.

        Args:
            server_id: Server ID
            tool_name: Tool name
            arguments: Tool arguments
            timeout: Optional timeout in seconds

        Returns:
            Tool result

        Raises:
            McpError: If tool call fails
        """
        if not self.is_connected(server_id):
            raise McpError(
                code=McpErrorCode.CONNECTION_FAILED,
                message=f"Server {server_id} is not connected",
            )

        session = self._sessions.get(server_id)
        if not session:
            raise McpError(
                code=McpErrorCode.SERVER_ERROR,
                message=f"No session for server {server_id}",
            )

        config = self._servers.get(server_id)
        effective_timeout = timeout or (config.timeout if config else MCP_CALL_TIMEOUT)

        logger.info(
            f"Calling MCP tool: {tool_name} on server {server_id}",
            extra={"server_id": server_id, "tool_name": tool_name},
        )

        try:
            result = await self._call_tool_with_retry(
                session, tool_name, arguments, effective_timeout,
            )

            logger.info(
                f"MCP tool call succeeded: {tool_name}",
                extra={"server_id": server_id, "tool_name": tool_name},
            )
            return result

        except asyncio.TimeoutError:
            logger.error(
                "MCP tool call timed out",
                extra={"server_id": server_id, "tool_name": tool_name, "timeout": effective_timeout},
            )
            raise McpError(
                code=McpErrorCode.TOOL_EXECUTION_FAILED,
                message=f"Tool call {tool_name} timed out after {effective_timeout}s",
                details={"server_id": server_id, "tool_name": tool_name},
            )
        except McpError:
            raise
        except Exception as e:
            logger.error(
                f"MCP tool call failed: {e}",
                extra={"server_id": server_id, "tool_name": tool_name},
            )
            raise McpError(
                code=McpErrorCode.TOOL_EXECUTION_FAILED,
                message=f"Tool call failed: {str(e)}",
                details={"server_id": server_id, "tool_name": tool_name},
            )

    @retry(
        stop=stop_after_attempt(MCP_MAX_RETRIES),
        wait=wait_exponential(multiplier=1, min=1, max=10),
        reraise=True,
    )
    async def _call_tool_with_retry(
        self,
        session: ClientSession,
        tool_name: str,
        arguments: dict[str, Any],
        timeout: int,
    ) -> Any:
        """Call a tool with exponential backoff retry."""
        result = await asyncio.wait_for(
            session.call_tool(tool_name, arguments),
            timeout=timeout,
        )
        # Extract content from MCP result
        if hasattr(result, "content"):
            # MCP SDK returns CallToolResult with content list
            contents = result.content
            if len(contents) == 1:
                item = contents[0]
                if hasattr(item, "text"):
                    return item.text
            return [
                {"type": getattr(c, "type", "text"), "text": getattr(c, "text", str(c))}
                for c in contents
            ]
        return result

    async def list_tools(self, server_id: str) -> list[dict[str, Any]]:
        """
        List available tools on an MCP server.

        Args:
            server_id: Server ID

        Returns:
            List of tool definitions

        Raises:
            McpError: If listing fails
        """
        if not self.is_connected(server_id):
            raise McpError(
                code=McpErrorCode.CONNECTION_FAILED,
                message=f"Server {server_id} is not connected",
            )

        session = self._sessions.get(server_id)
        if not session:
            raise McpError(
                code=McpErrorCode.SERVER_ERROR,
                message=f"No session for server {server_id}",
            )

        logger.info(
            f"Listing tools on MCP server {server_id}",
            extra={"server_id": server_id},
        )

        try:
            result = await session.list_tools()
            tools: list[dict[str, Any]] = []
            for tool in result.tools:
                tools.append({
                    "name": tool.name,
                    "description": getattr(tool, "description", ""),
                    "inputSchema": getattr(tool, "inputSchema", {}),
                })
            return tools

        except Exception as e:
            logger.error(
                f"Failed to list tools: {e}",
                extra={"server_id": server_id},
            )
            raise McpError(
                code=McpErrorCode.SERVER_ERROR,
                message=f"Failed to list tools: {str(e)}",
            )

    async def close_all(self) -> None:
        """Close all MCP connections and clean up resources."""
        logger.info("Closing all MCP connections")

        # 获取所有服务器 ID 的副本（避免在迭代时修改）
        server_ids = list(self._servers.keys())

        for server_id in server_ids:
            try:
                await self.disconnect(server_id)
            except Exception as e:
                logger.error(
                    f"Error disconnecting from server {server_id}: {e}",
                    extra={"server_id": server_id},
                )

        # 清理所有字典，防止内存泄漏
        self._servers.clear()
        self._sessions.clear()
        self._exit_stacks.clear()
        self._connection_status.clear()

        logger.info(
            "All MCP connections closed and resources cleaned up",
            extra={"closed_count": len(server_ids)},
        )
