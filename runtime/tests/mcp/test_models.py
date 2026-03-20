"""MCP Models tests."""

import pytest
from src.mcp.models import (
    McpConnectionStatus,
    McpErrorCode,
    McpServerConfig,
    McpToolCall,
    McpToolResult,
    McpError,
)


class TestMcpConnectionStatus:
    """Test McpConnectionStatus enum."""

    def test_disconnected_value(self):
        """Test DISCONNECTED status value."""
        assert McpConnectionStatus.DISCONNECTED.value == "disconnected"

    def test_connecting_value(self):
        """Test CONNECTING status value."""
        assert McpConnectionStatus.CONNECTING.value == "connecting"

    def test_connected_value(self):
        """Test CONNECTED status value."""
        assert McpConnectionStatus.CONNECTED.value == "connected"

    def test_error_value(self):
        """Test ERROR status value."""
        assert McpConnectionStatus.ERROR.value == "error"


class TestMcpErrorCode:
    """Test McpErrorCode enum."""

    def test_all_error_codes_exist(self):
        """Test all expected error codes exist."""
        expected_codes = [
            "CONNECTION_FAILED",
            "CONNECTION_TIMEOUT",
            "TOOL_NOT_FOUND",
            "TOOL_EXECUTION_FAILED",
            "INVALID_PARAMS",
            "SERVER_ERROR",
            "UNKNOWN_ERROR",
        ]

        for code in expected_codes:
            assert hasattr(McpErrorCode, code)


class TestMcpServerConfig:
    """Test McpServerConfig dataclass."""

    def test_create_with_required_fields(self):
        """Test creating config with required fields only."""
        config = McpServerConfig(
            server_id="server-1",
            server_name="Test Server",
            transport_type="stdio",
            connection_params={"command": "echo"},
        )

        assert config.server_id == "server-1"
        assert config.server_name == "Test Server"
        assert config.transport_type == "stdio"
        assert config.connection_params == {"command": "echo"}
        assert config.timeout == 30  # default
        assert config.max_retries == 3  # default
        assert config.metadata == {}  # default

    def test_create_with_all_fields(self):
        """Test creating config with all fields."""
        config = McpServerConfig(
            server_id="server-1",
            server_name="Test Server",
            transport_type="http",
            connection_params={"url": "http://localhost:8080"},
            timeout=60,
            max_retries=5,
            metadata={"version": "1.0"},
        )

        assert config.timeout == 60
        assert config.max_retries == 5
        assert config.metadata == {"version": "1.0"}


class TestMcpToolCall:
    """Test McpToolCall dataclass."""

    def test_create_with_required_fields(self):
        """Test creating tool call with required fields."""
        call = McpToolCall(
            server_id="server-1",
            tool_name="calculator",
            arguments={"x": 1, "y": 2},
        )

        assert call.server_id == "server-1"
        assert call.tool_name == "calculator"
        assert call.arguments == {"x": 1, "y": 2}
        assert call.timeout is None

    def test_create_with_timeout(self):
        """Test creating tool call with custom timeout."""
        call = McpToolCall(
            server_id="server-1",
            tool_name="calculator",
            arguments={},
            timeout=120,
        )

        assert call.timeout == 120


class TestMcpToolResult:
    """Test McpToolResult dataclass."""

    def test_create_success_result(self):
        """Test creating a successful result."""
        result = McpToolResult(
            tool_name="calculator",
            result={"answer": 42},
        )

        assert result.tool_name == "calculator"
        assert result.result == {"answer": 42}
        assert result.error is None
        assert result.error_code is None
        assert result.success is True

    def test_create_error_result(self):
        """Test creating an error result."""
        result = McpToolResult(
            tool_name="calculator",
            error="Division by zero",
            error_code=McpErrorCode.TOOL_EXECUTION_FAILED,
            success=False,
        )

        assert result.success is False
        assert result.error == "Division by zero"
        assert result.error_code == McpErrorCode.TOOL_EXECUTION_FAILED


class TestMcpError:
    """Test McpError exception."""

    def test_create_error(self):
        """Test creating an error."""
        error = McpError(
            code=McpErrorCode.CONNECTION_FAILED,
            message="Failed to connect to server",
        )

        assert error.code == McpErrorCode.CONNECTION_FAILED
        assert error.message == "Failed to connect to server"
        assert error.details == {}

    def test_create_error_with_details(self):
        """Test creating an error with details."""
        error = McpError(
            code=McpErrorCode.TOOL_EXECUTION_FAILED,
            message="Tool failed",
            details={"tool_name": "calculator", "reason": "timeout"},
        )

        assert error.details == {"tool_name": "calculator", "reason": "timeout"}

    def test_error_string_representation(self):
        """Test error string representation."""
        error = McpError(
            code=McpErrorCode.SERVER_ERROR,
            message="Internal server error",
        )

        assert str(error) == "[server_error] Internal server error"

    def test_error_is_exception(self):
        """Test that McpError can be raised as exception."""
        error = McpError(
            code=McpErrorCode.UNKNOWN_ERROR,
            message="Unknown error occurred",
        )

        with pytest.raises(McpError):
            raise error
