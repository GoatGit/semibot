"""MCP data models and types."""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class McpConnectionStatus(str, Enum):
    """MCP server connection status."""

    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    ERROR = "error"


class McpErrorCode(str, Enum):
    """MCP error codes."""

    CONNECTION_FAILED = "connection_failed"
    CONNECTION_TIMEOUT = "connection_timeout"
    TOOL_NOT_FOUND = "tool_not_found"
    TOOL_EXECUTION_FAILED = "tool_execution_failed"
    INVALID_PARAMS = "invalid_params"
    SERVER_ERROR = "server_error"
    UNKNOWN_ERROR = "unknown_error"


class McpTransportType(str, Enum):
    """MCP transport types."""

    STDIO = "stdio"
    HTTP_SSE = "http"
    STREAMABLE_HTTP = "streamable_http"
    WEBSOCKET = "websocket"


@dataclass
class StdioTransportParams:
    """Parameters for stdio transport."""

    command: str
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)


@dataclass
class HttpSseTransportParams:
    """Parameters for HTTP/SSE transport."""

    url: str
    headers: dict[str, str] = field(default_factory=dict)


@dataclass
class WebSocketTransportParams:
    """Parameters for WebSocket transport."""

    url: str
    headers: dict[str, str] = field(default_factory=dict)


@dataclass
class McpServerConfig:
    """MCP server configuration."""

    server_id: str
    server_name: str
    transport_type: str  # "stdio", "http", "websocket"
    connection_params: dict[str, Any]
    timeout: int = 30
    max_retries: int = 3
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class McpToolCall:
    """MCP tool call request."""

    server_id: str
    tool_name: str
    arguments: dict[str, Any]
    timeout: int | None = None


@dataclass
class McpToolResult:
    """MCP tool call result."""

    tool_name: str
    result: Any | None = None
    error: str | None = None
    error_code: McpErrorCode | None = None
    success: bool = True
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class McpError(Exception):
    """MCP error."""

    code: McpErrorCode
    message: str
    details: dict[str, Any] = field(default_factory=dict)

    def __str__(self) -> str:
        return f"[{self.code.value}] {self.message}"
