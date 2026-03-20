"""MCP (Model Context Protocol) client implementation.

This package provides MCP client functionality for connecting to and
interacting with MCP servers.
"""

from src.mcp.models import (
    McpConnectionStatus,
    McpServerConfig,
    McpToolCall,
    McpToolResult,
    McpError,
    McpErrorCode,
    McpTransportType,
    StdioTransportParams,
    HttpSseTransportParams,
    WebSocketTransportParams,
)
try:
    from src.mcp.client import McpClient
except ModuleNotFoundError:
    McpClient = None  # type: ignore[assignment]

__all__ = [
    "McpConnectionStatus",
    "McpServerConfig",
    "McpToolCall",
    "McpToolResult",
    "McpError",
    "McpErrorCode",
    "McpTransportType",
    "StdioTransportParams",
    "HttpSseTransportParams",
    "WebSocketTransportParams",
    "McpClient",
]
