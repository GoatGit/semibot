"""MCP Client tests."""

import pytest
from unittest.mock import AsyncMock, patch, MagicMock
import os

from src.mcp.client import McpClient
from src.mcp.models import (
    McpConnectionStatus,
    McpServerConfig,
    McpError,
    McpErrorCode,
)


class TestMcpClientInit:
    """Test McpClient initialization."""

    def test_init_creates_empty_collections(self):
        """Test that client initializes with empty collections."""
        client = McpClient()

        assert len(client._servers) == 0
        assert len(client._connections) == 0
        assert len(client._connection_status) == 0


class TestMcpClientAddServer:
    """Test McpClient.add_server method."""

    @pytest.mark.asyncio
    async def test_add_server_success(self, sample_server_config):
        """Test adding a server successfully."""
        client = McpClient()

        await client.add_server(sample_server_config)

        assert sample_server_config.server_id in client._servers
        assert client._connection_status[sample_server_config.server_id] == McpConnectionStatus.DISCONNECTED

    @pytest.mark.asyncio
    async def test_add_duplicate_server_raises_error(self, sample_server_config):
        """Test that adding a duplicate server raises an error."""
        client = McpClient()

        await client.add_server(sample_server_config)

        with pytest.raises(McpError) as exc_info:
            await client.add_server(sample_server_config)

        assert exc_info.value.code == McpErrorCode.SERVER_ERROR


class TestMcpClientConnect:
    """Test McpClient.connect method."""

    @pytest.mark.asyncio
    async def test_connect_server_not_found(self):
        """Test connecting to a non-existent server."""
        client = McpClient()

        with pytest.raises(McpError) as exc_info:
            await client.connect("non-existent")

        assert exc_info.value.code == McpErrorCode.SERVER_ERROR

    @pytest.mark.asyncio
    async def test_connect_when_disabled(self, sample_server_config):
        """Test connecting when MCP is disabled."""
        client = McpClient()
        await client.add_server(sample_server_config)

        with patch.dict(os.environ, {"MCP_ENABLED": "false"}):
            with pytest.raises(McpError) as exc_info:
                await client.connect(sample_server_config.server_id)

            assert exc_info.value.code == McpErrorCode.CONNECTION_FAILED

    @pytest.mark.asyncio
    async def test_connect_success_mock_mode(self, sample_server_config):
        """Test successful connection in mock mode."""
        client = McpClient()
        await client.add_server(sample_server_config)

        with patch.dict(os.environ, {"MCP_ENABLED": "true"}):
            await client.connect(sample_server_config.server_id)

        assert client._connection_status[sample_server_config.server_id] == McpConnectionStatus.CONNECTED


class TestMcpClientDisconnect:
    """Test McpClient.disconnect method."""

    @pytest.mark.asyncio
    async def test_disconnect_not_found(self):
        """Test disconnecting from a non-existent server."""
        client = McpClient()

        # Should not raise, just log warning
        await client.disconnect("non-existent")

    @pytest.mark.asyncio
    async def test_disconnect_success(self, sample_server_config):
        """Test successful disconnection."""
        client = McpClient()
        await client.add_server(sample_server_config)

        with patch.dict(os.environ, {"MCP_ENABLED": "true"}):
            await client.connect(sample_server_config.server_id)

        await client.disconnect(sample_server_config.server_id)

        assert client._connection_status[sample_server_config.server_id] == McpConnectionStatus.DISCONNECTED


class TestMcpClientStatus:
    """Test McpClient status methods."""

    def test_get_connection_status_not_found(self):
        """Test getting status for non-existent server."""
        client = McpClient()

        status = client.get_connection_status("non-existent")

        assert status == McpConnectionStatus.DISCONNECTED

    def test_is_connected_false(self):
        """Test is_connected returns false for disconnected server."""
        client = McpClient()

        assert client.is_connected("non-existent") is False

    @pytest.mark.asyncio
    async def test_is_connected_true(self, sample_server_config):
        """Test is_connected returns true for connected server."""
        client = McpClient()
        await client.add_server(sample_server_config)

        with patch.dict(os.environ, {"MCP_ENABLED": "true"}):
            await client.connect(sample_server_config.server_id)

        assert client.is_connected(sample_server_config.server_id) is True


class TestMcpClientCallTool:
    """Test McpClient.call_tool method."""

    @pytest.mark.asyncio
    async def test_call_tool_not_connected(self):
        """Test calling tool on disconnected server."""
        client = McpClient()

        with pytest.raises(McpError) as exc_info:
            await client.call_tool("server-1", "test_tool", {})

        assert exc_info.value.code == McpErrorCode.CONNECTION_FAILED

    @pytest.mark.asyncio
    async def test_call_tool_success_mock(self, sample_server_config):
        """Test successful tool call in mock mode."""
        client = McpClient()
        await client.add_server(sample_server_config)

        with patch.dict(os.environ, {"MCP_ENABLED": "true"}):
            await client.connect(sample_server_config.server_id)
            result = await client.call_tool(
                sample_server_config.server_id,
                "test_tool",
                {"arg1": "value1"},
            )

        assert result["status"] == "success"
        assert "test_tool" in result["message"]


class TestMcpClientListTools:
    """Test McpClient.list_tools method."""

    @pytest.mark.asyncio
    async def test_list_tools_not_connected(self):
        """Test listing tools on disconnected server."""
        client = McpClient()

        with pytest.raises(McpError) as exc_info:
            await client.list_tools("server-1")

        assert exc_info.value.code == McpErrorCode.CONNECTION_FAILED

    @pytest.mark.asyncio
    async def test_list_tools_returns_empty(self, sample_server_config):
        """Test list_tools returns empty list in mock mode."""
        client = McpClient()
        await client.add_server(sample_server_config)

        with patch.dict(os.environ, {"MCP_ENABLED": "true"}):
            await client.connect(sample_server_config.server_id)
            tools = await client.list_tools(sample_server_config.server_id)

        assert tools == []


class TestMcpClientCloseAll:
    """Test McpClient.close_all method."""

    @pytest.mark.asyncio
    async def test_close_all_empty(self):
        """Test close_all with no servers."""
        client = McpClient()

        await client.close_all()

        assert len(client._servers) == 0

    @pytest.mark.asyncio
    async def test_close_all_clears_resources(self, sample_server_config, http_server_config):
        """Test close_all clears all resources."""
        client = McpClient()
        await client.add_server(sample_server_config)
        await client.add_server(http_server_config)

        with patch.dict(os.environ, {"MCP_ENABLED": "true"}):
            await client.connect(sample_server_config.server_id)
            await client.connect(http_server_config.server_id)

        await client.close_all()

        assert len(client._servers) == 0
        assert len(client._connections) == 0
        assert len(client._connection_status) == 0

    @pytest.mark.asyncio
    async def test_close_all_handles_errors(self, sample_server_config):
        """Test close_all handles errors gracefully."""
        client = McpClient()
        await client.add_server(sample_server_config)

        # Manually set status to trigger disconnect logic
        client._connection_status[sample_server_config.server_id] = McpConnectionStatus.CONNECTED

        # Should not raise even if internal disconnect has issues
        await client.close_all()

        assert len(client._servers) == 0
