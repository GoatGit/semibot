"""MCP Client tests."""

import os
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.mcp.client import McpClient
from src.mcp.models import (
    McpConnectionStatus,
    McpError,
    McpErrorCode,
)


@asynccontextmanager
async def _fake_transport():
    yield ("read_stream", "write_stream")


class _FakeTool:
    def __init__(self, name: str, description: str = "", input_schema: dict | None = None):
        self.name = name
        self.description = description
        self.inputSchema = input_schema or {}


class _FakeListToolsResult:
    def __init__(self, tools: list[_FakeTool] | None = None):
        self.tools = tools or []


class TestMcpClientInit:
    def test_init_creates_empty_collections(self):
        client = McpClient()
        assert len(client._servers) == 0
        assert len(client._sessions) == 0
        assert len(client._connection_status) == 0


class TestMcpClientAddServer:
    @pytest.mark.asyncio
    async def test_add_server_success(self, sample_server_config):
        client = McpClient()
        await client.add_server(sample_server_config)
        assert sample_server_config.server_id in client._servers
        assert client._connection_status[sample_server_config.server_id] == McpConnectionStatus.DISCONNECTED

    @pytest.mark.asyncio
    async def test_add_duplicate_server_raises_error(self, sample_server_config):
        client = McpClient()
        await client.add_server(sample_server_config)
        with pytest.raises(McpError) as exc_info:
            await client.add_server(sample_server_config)
        assert exc_info.value.code == McpErrorCode.SERVER_ERROR


class TestMcpClientConnect:
    @pytest.mark.asyncio
    async def test_connect_server_not_found(self):
        client = McpClient()
        with pytest.raises(McpError) as exc_info:
            await client.connect("non-existent")
        assert exc_info.value.code == McpErrorCode.SERVER_ERROR

    @pytest.mark.asyncio
    async def test_connect_when_disabled(self, sample_server_config):
        client = McpClient()
        await client.add_server(sample_server_config)

        with patch("src.mcp.client.MCP_ENABLED", False):
            with pytest.raises(McpError) as exc_info:
                await client.connect(sample_server_config.server_id)

        assert exc_info.value.code == McpErrorCode.CONNECTION_FAILED

    @pytest.mark.asyncio
    async def test_connect_success_stdio(self, sample_server_config):
        client = McpClient()
        await client.add_server(sample_server_config)

        session = AsyncMock()
        session_cm = AsyncMock()
        session_cm.__aenter__.return_value = session
        with (
            patch("src.mcp.client.MCP_ENABLED", True),
            patch("src.mcp.client.stdio_client", return_value=_fake_transport()),
            patch("src.mcp.client.ClientSession", return_value=session_cm),
        ):
            await client.connect(sample_server_config.server_id)

        assert client._connection_status[sample_server_config.server_id] == McpConnectionStatus.CONNECTED
        session.initialize.assert_awaited()


class TestMcpClientDisconnect:
    @pytest.mark.asyncio
    async def test_disconnect_not_found(self):
        client = McpClient()
        await client.disconnect("non-existent")

    @pytest.mark.asyncio
    async def test_disconnect_success(self, sample_server_config):
        client = McpClient()
        await client.add_server(sample_server_config)

        session = AsyncMock()
        with (
            patch("src.mcp.client.MCP_ENABLED", True),
            patch("src.mcp.client.stdio_client", return_value=_fake_transport()),
            patch("src.mcp.client.ClientSession", return_value=session),
        ):
            await client.connect(sample_server_config.server_id)

        await client.disconnect(sample_server_config.server_id)
        assert client._connection_status[sample_server_config.server_id] == McpConnectionStatus.DISCONNECTED


class TestMcpClientStatus:
    def test_get_connection_status_not_found(self):
        client = McpClient()
        assert client.get_connection_status("non-existent") == McpConnectionStatus.DISCONNECTED

    def test_is_connected_false(self):
        client = McpClient()
        assert client.is_connected("non-existent") is False

    @pytest.mark.asyncio
    async def test_is_connected_true(self, sample_server_config):
        client = McpClient()
        await client.add_server(sample_server_config)

        session = AsyncMock()
        with (
            patch("src.mcp.client.MCP_ENABLED", True),
            patch("src.mcp.client.stdio_client", return_value=_fake_transport()),
            patch("src.mcp.client.ClientSession", return_value=session),
        ):
            await client.connect(sample_server_config.server_id)

        assert client.is_connected(sample_server_config.server_id) is True


class TestMcpClientCallTool:
    @pytest.mark.asyncio
    async def test_call_tool_not_connected(self):
        client = McpClient()
        with pytest.raises(McpError) as exc_info:
            await client.call_tool("server-1", "test_tool", {})
        assert exc_info.value.code == McpErrorCode.CONNECTION_FAILED

    @pytest.mark.asyncio
    async def test_call_tool_success(self, sample_server_config):
        client = McpClient()
        await client.add_server(sample_server_config)
        client._connection_status[sample_server_config.server_id] = McpConnectionStatus.CONNECTED
        client._sessions[sample_server_config.server_id] = AsyncMock()
        client._call_tool_with_retry = AsyncMock(return_value={"status": "success", "message": "called test_tool"})  # type: ignore[method-assign]

        result = await client.call_tool(sample_server_config.server_id, "test_tool", {"arg1": "value1"})

        assert result["status"] == "success"
        assert "test_tool" in result["message"]


class TestMcpClientListTools:
    @pytest.mark.asyncio
    async def test_list_tools_not_connected(self):
        client = McpClient()
        with pytest.raises(McpError) as exc_info:
            await client.list_tools("server-1")
        assert exc_info.value.code == McpErrorCode.CONNECTION_FAILED

    @pytest.mark.asyncio
    async def test_list_tools_returns_items(self, sample_server_config):
        client = McpClient()
        await client.add_server(sample_server_config)
        client._connection_status[sample_server_config.server_id] = McpConnectionStatus.CONNECTED
        session = AsyncMock()
        session.list_tools.return_value = _FakeListToolsResult([_FakeTool("test_tool", "desc", {"type": "object"})])
        client._sessions[sample_server_config.server_id] = session

        tools = await client.list_tools(sample_server_config.server_id)

        assert tools == [{"name": "test_tool", "description": "desc", "inputSchema": {"type": "object"}}]


class TestMcpClientCloseAll:
    @pytest.mark.asyncio
    async def test_close_all_empty(self):
        client = McpClient()
        await client.close_all()
        assert len(client._servers) == 0

    @pytest.mark.asyncio
    async def test_close_all_clears_resources(self, sample_server_config, http_server_config):
        client = McpClient()
        await client.add_server(sample_server_config)
        await client.add_server(http_server_config)
        client._connection_status[sample_server_config.server_id] = McpConnectionStatus.CONNECTED
        client._connection_status[http_server_config.server_id] = McpConnectionStatus.CONNECTED
        client._sessions[sample_server_config.server_id] = AsyncMock()
        client._sessions[http_server_config.server_id] = AsyncMock()

        await client.close_all()

        assert len(client._servers) == 0
        assert len(client._sessions) == 0
        assert len(client._connection_status) == 0

    @pytest.mark.asyncio
    async def test_close_all_handles_errors(self, sample_server_config):
        client = McpClient()
        await client.add_server(sample_server_config)
        client._connection_status[sample_server_config.server_id] = McpConnectionStatus.CONNECTED

        with patch.object(client, "disconnect", side_effect=RuntimeError("boom")):
            await client.close_all()

        assert len(client._servers) == 0
