"""MCP test fixtures."""

import pytest
from unittest.mock import AsyncMock, MagicMock
from src.mcp.models import McpServerConfig, McpConnectionStatus


@pytest.fixture
def sample_server_config():
    """Create a sample MCP server configuration."""
    return McpServerConfig(
        server_id="test-server-1",
        server_name="Test Server",
        transport_type="stdio",
        connection_params={"command": "echo", "args": ["hello"]},
        timeout=30,
        max_retries=3,
    )


@pytest.fixture
def http_server_config():
    """Create an HTTP transport MCP server configuration."""
    return McpServerConfig(
        server_id="http-server-1",
        server_name="HTTP Server",
        transport_type="http",
        connection_params={"url": "http://localhost:8080"},
        timeout=60,
    )


@pytest.fixture
def websocket_server_config():
    """Create a WebSocket transport MCP server configuration."""
    return McpServerConfig(
        server_id="ws-server-1",
        server_name="WebSocket Server",
        transport_type="websocket",
        connection_params={"url": "ws://localhost:9090"},
        timeout=30,
    )


@pytest.fixture
def mock_connection():
    """Create a mock connection object."""
    conn = AsyncMock()
    conn.close = AsyncMock()
    conn.send = AsyncMock()
    conn.receive = AsyncMock(return_value={"result": "success"})
    return conn
