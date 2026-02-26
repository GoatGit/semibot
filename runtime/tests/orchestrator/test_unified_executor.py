"""Tests for UnifiedActionExecutor."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from src.orchestrator.unified_executor import UnifiedActionExecutor, ExecutionMetadata
from src.orchestrator.context import (
    RuntimeSessionContext,
    AgentConfig,
    SkillDefinition,
    ToolDefinition,
    McpServerDefinition,
    RuntimePolicy,
)
from src.orchestrator.state import PlanStep, ToolCallResult
from src.orchestrator.capability import CapabilityGraph
from src.skills.base import ToolResult


@pytest.fixture
def runtime_context():
    """Create a test runtime context."""
    return RuntimeSessionContext(
        org_id="org_123",
        user_id="user_456",
        agent_id="agent_789",
        session_id="session_abc",
        agent_config=AgentConfig(
            id="agent_789",
            name="Test Agent",
            description="Test agent",
        ),
        available_skills=[
            SkillDefinition(
                id="skill_1",
                name="test_skill",
                description="Test skill",
                version="1.0.0",
                source="local",
            ),
        ],
        available_tools=[
            ToolDefinition(
                name="test_tool",
                description="Test tool",
            ),
        ],
        available_mcp_servers=[
            McpServerDefinition(
                id="mcp_1",
                name="test_mcp",
                endpoint="http://localhost:8080",
                transport="http",
                is_connected=True,
                available_tools=[
                    {
                        "name": "mcp_tool",
                        "description": "MCP tool",
                        "inputSchema": {},
                    }
                ],
            ),
        ],
        runtime_policy=RuntimePolicy(
            require_approval_for_high_risk=True,
            high_risk_tools=["dangerous_tool"],
        ),
    )


@pytest.fixture
def mock_skill_registry():
    """Create a mock skill registry."""
    registry = MagicMock()
    registry.execute = AsyncMock(
        return_value=ToolResult(
            result="skill result",
            success=True,
        )
    )
    return registry


@pytest.fixture
def mock_mcp_client():
    """Create a mock MCP client."""
    client = MagicMock()
    client.call_tool = AsyncMock(return_value={"status": "success"})
    return client


@pytest.fixture
def executor(runtime_context, mock_skill_registry, mock_mcp_client):
    """Create a test executor."""
    return UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
        mcp_client=mock_mcp_client,
    )


@pytest.mark.asyncio
async def test_execute_skill(executor, mock_skill_registry):
    """Test executing a skill."""
    action = PlanStep(
        id="step_1",
        title="Test action",
        tool="test_skill",
        params={"input": "test"},
    )

    result = await executor.execute(action)

    assert result.success is True
    assert result.tool_name == "test_skill"
    assert result.result == "skill result"
    assert result.metadata["capability_type"] == "skill"
    assert result.metadata["source"] == "local"
    assert result.metadata["version"] == "1.0.0"

    mock_skill_registry.execute.assert_called_once_with("test_skill", {"input": "test"})


@pytest.mark.asyncio
async def test_execute_tool(executor, mock_skill_registry):
    """Test executing a built-in tool."""
    action = PlanStep(
        id="step_1",
        title="Test action",
        tool="test_tool",
        params={"input": "test"},
    )

    result = await executor.execute(action)

    assert result.success is True
    assert result.tool_name == "test_tool"
    assert result.metadata["capability_type"] == "tool"

    mock_skill_registry.execute.assert_called_once_with("test_tool", {"input": "test"})


@pytest.mark.asyncio
async def test_execute_mcp_tool(executor, mock_mcp_client):
    """Test executing an MCP tool."""
    action = PlanStep(
        id="step_1",
        title="Test action",
        tool="mcp_tool",
        params={"input": "test"},
    )

    result = await executor.execute(action)

    assert result.success is True
    assert result.tool_name == "mcp_tool"
    assert result.metadata["capability_type"] == "mcp"
    assert result.metadata["mcp_server_id"] == "mcp_1"
    assert result.metadata["mcp_server_name"] == "test_mcp"

    mock_mcp_client.call_tool.assert_called_once_with(
        server_id="mcp_1",
        tool_name="mcp_tool",
        arguments={"input": "test"},
    )


@pytest.mark.asyncio
async def test_execute_invalid_action(executor):
    """Test executing an action not in capability graph."""
    action = PlanStep(
        id="step_1",
        title="Test action",
        tool="unknown_tool",
        params={},
    )

    result = await executor.execute(action)

    assert result.success is False
    assert "not in capability graph" in result.error


@pytest.mark.asyncio
async def test_execute_no_tool_name(executor):
    """Test executing an action without tool name."""
    action = PlanStep(
        id="step_1",
        title="Test action",
        tool=None,
        params={},
    )

    result = await executor.execute(action)

    assert result.success is False
    assert "No tool name specified" in result.error


@pytest.mark.asyncio
async def test_approval_hook_approved(runtime_context, mock_skill_registry):
    """Test approval hook approves action."""
    approval_hook = AsyncMock(return_value=True)

    # Add high-risk tool to context
    runtime_context.available_tools.append(
        ToolDefinition(
            name="dangerous_tool",
            description="Dangerous tool",
        )
    )

    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
        approval_hook=approval_hook,
    )

    action = PlanStep(
        id="step_1",
        title="Test action",
        tool="dangerous_tool",
        params={"input": "test"},
    )

    result = await executor.execute(action)

    assert result.success is True
    approval_hook.assert_called_once()

    # Check approval hook was called with correct arguments
    call_args = approval_hook.call_args
    assert call_args[0][0] == "dangerous_tool"
    assert call_args[0][1] == {"input": "test"}
    assert isinstance(call_args[0][2], ExecutionMetadata)
    assert call_args[0][2].is_high_risk is True


@pytest.mark.asyncio
async def test_approval_hook_rejected(runtime_context, mock_skill_registry):
    """Test approval hook rejects action."""
    approval_hook = AsyncMock(return_value=False)

    # Add high-risk tool to context
    runtime_context.available_tools.append(
        ToolDefinition(
            name="dangerous_tool",
            description="Dangerous tool",
        )
    )

    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
        approval_hook=approval_hook,
    )

    action = PlanStep(
        id="step_1",
        title="Test action",
        tool="dangerous_tool",
        params={"input": "test"},
    )

    result = await executor.execute(action)

    assert result.success is False
    assert "rejected by approval hook" in result.error
    approval_hook.assert_called_once()

    # Skill should not be executed
    mock_skill_registry.execute.assert_not_called()


@pytest.mark.asyncio
async def test_approval_hook_error(runtime_context, mock_skill_registry):
    """Test approval hook raises error."""
    approval_hook = AsyncMock(side_effect=Exception("Approval failed"))

    # Add high-risk tool to context
    runtime_context.available_tools.append(
        ToolDefinition(
            name="dangerous_tool",
            description="Dangerous tool",
        )
    )

    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
        approval_hook=approval_hook,
    )

    action = PlanStep(
        id="step_1",
        title="Test action",
        tool="dangerous_tool",
        params={"input": "test"},
    )

    result = await executor.execute(action)

    assert result.success is False
    assert "Approval hook failed" in result.error


@pytest.mark.asyncio
async def test_no_approval_for_non_high_risk(runtime_context, mock_skill_registry):
    """Test no approval needed for non-high-risk tools."""
    approval_hook = AsyncMock(return_value=True)

    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
        approval_hook=approval_hook,
    )

    action = PlanStep(
        id="step_1",
        title="Test action",
        tool="test_skill",
        params={"input": "test"},
    )

    result = await executor.execute(action)

    assert result.success is True
    # Approval hook should not be called for non-high-risk tools
    approval_hook.assert_not_called()


@pytest.mark.asyncio
async def test_execution_metadata(executor):
    """Test execution metadata is correctly built."""
    action = PlanStep(
        id="step_1",
        title="Test action",
        tool="test_skill",
        params={"input": "test"},
    )

    result = await executor.execute(action)

    assert result.metadata is not None
    assert result.metadata["capability_type"] == "skill"
    assert result.metadata["source"] == "local"
    assert result.metadata["version"] == "1.0.0"
    assert result.metadata["is_high_risk"] is False
    assert result.duration_ms is not None
    assert result.duration_ms >= 0


@pytest.mark.asyncio
async def test_skill_execution_error(runtime_context, mock_mcp_client):
    """Test skill execution error handling."""
    mock_skill_registry = MagicMock()
    mock_skill_registry.execute = AsyncMock(
        side_effect=Exception("Skill execution failed")
    )

    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
        mcp_client=mock_mcp_client,
    )

    action = PlanStep(
        id="step_1",
        title="Test action",
        tool="test_skill",
        params={"input": "test"},
    )

    result = await executor.execute(action)

    assert result.success is False
    assert "Skill execution failed" in result.error


@pytest.mark.asyncio
async def test_mcp_execution_error(runtime_context, mock_skill_registry):
    """Test MCP execution error handling."""
    mock_mcp_client = MagicMock()
    mock_mcp_client.call_tool = AsyncMock(
        side_effect=Exception("MCP call failed")
    )

    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
        mcp_client=mock_mcp_client,
    )

    action = PlanStep(
        id="step_1",
        title="Test action",
        tool="mcp_tool",
        params={"input": "test"},
    )

    result = await executor.execute(action)

    assert result.success is False
    assert "MCP execution failed" in result.error


@pytest.mark.asyncio
async def test_no_skill_registry(runtime_context, mock_mcp_client):
    """Test execution without skill registry."""
    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=None,
        mcp_client=mock_mcp_client,
    )

    action = PlanStep(
        id="step_1",
        title="Test action",
        tool="test_skill",
        params={"input": "test"},
    )

    result = await executor.execute(action)

    assert result.success is False
    assert "Skill registry not configured" in result.error


@pytest.mark.asyncio
async def test_no_mcp_client(runtime_context, mock_skill_registry):
    """Test execution without MCP client."""
    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
        mcp_client=None,
    )

    action = PlanStep(
        id="step_1",
        title="Test action",
        tool="mcp_tool",
        params={"input": "test"},
    )

    result = await executor.execute(action)

    assert result.success is False
    assert "MCP client not configured" in result.error


@pytest.mark.asyncio
async def test_disconnected_mcp_server(runtime_context, mock_skill_registry, mock_mcp_client):
    """Test MCP tool from disconnected server is not available."""
    # Mark MCP server as disconnected
    runtime_context.available_mcp_servers[0].is_connected = False

    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
        mcp_client=mock_mcp_client,
    )

    action = PlanStep(
        id="step_1",
        title="Test action",
        tool="mcp_tool",
        params={"input": "test"},
    )

    result = await executor.execute(action)

    assert result.success is False
    assert "not in capability graph" in result.error


@pytest.mark.asyncio
async def test_emits_tool_exec_events(runtime_context, mock_skill_registry):
    """Test tool execution emits started/completed runtime events."""

    class DummyEmitter:
        def __init__(self):
            self.events = []

        async def emit(self, event):
            self.events.append(event)

    emitter = DummyEmitter()
    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
        event_emitter=emitter,
    )

    action = PlanStep(
        id="step_emit",
        title="Emit test",
        tool="test_skill",
        params={"input": "ping"},
    )
    result = await executor.execute(action)

    assert result.success is True
    assert len(emitter.events) >= 2
    event_types = [event.event_type for event in emitter.events]
    assert "tool.exec.started" in event_types
    assert "tool.exec.completed" in event_types
