"""Tests for UnifiedActionExecutor."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from src.orchestrator.unified_executor import UnifiedActionExecutor, ExecutionMetadata
from src.orchestrator.context import (
    RuntimeSessionContext,
    AgentConfig,
    CapabilityDescriptor,
    SkillDefinition,
    ToolDefinition,
    McpServerDefinition,
    RuntimePolicy,
    SubAgentDefinition,
)
from src.orchestrator.state import PlanStep, ToolCallResult
from src.orchestrator.capability import CapabilityGraph
from src.server.config_store import RuntimeConfigStore
from src.skills.base import ToolResult


@pytest.fixture
def runtime_context():
    """Create a test runtime context."""
    return RuntimeSessionContext(
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
            ToolDefinition(
                name="test_skill",
                description="Test skill adapter",
            ),
            ToolDefinition(
                name="dangerous_tool",
                description="Dangerous tool adapter",
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


@pytest.fixture
def sub_agent_executor(runtime_context, mock_skill_registry):
    runtime_context.available_sub_agents = [
        SubAgentDefinition(
            id="agent_research",
            name="Research Agent",
            description="Handles delegated research tasks",
        )
    ]
    mock_delegator = MagicMock()
    mock_delegator.delegate = AsyncMock(
        return_value={
            "result": "delegated result",
            "agent_id": "agent_research",
            "agent_name": "Research Agent",
        }
    )
    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
        sub_agent_delegator=mock_delegator,
    )
    return executor, mock_delegator


def test_build_sub_agent_delegator_from_capability_only_context(runtime_context, mock_skill_registry):
    runtime_context.available_sub_agents = []
    runtime_context.capabilities = [
        CapabilityDescriptor(
            id="agent:agent_research",
            kind="sub_agent",
            name="subagent:agent_research",
            display_name="Research Agent",
            description="Handles delegated research tasks",
            source={"type": "agent", "agentId": "agent_research"},
            metadata={"sub_agent_id": "agent_research"},
        )
    ]
    runtime_context._explicit_capabilities_provided = True

    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
    )

    assert executor.sub_agent_delegator is not None


@pytest.fixture
def file_io_executor(runtime_context, mock_skill_registry):
    runtime_context.available_tools.append(
        ToolDefinition(
            name="file_io",
            description="File IO",
        )
    )
    runtime_context.runtime_policy.high_risk_tools.append("file_io")
    return UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
    )


@pytest.mark.asyncio
async def test_execute_skill(executor, mock_skill_registry):
    """Test executing a skill (now treated as tool since skills are disabled in capability graph)."""
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
    # Skills are disabled in capability graph; test_skill is registered as a tool
    assert result.metadata["capability_type"] == "tool"

    mock_skill_registry.execute.assert_called_once()


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

    mock_skill_registry.execute.assert_called_once()


@pytest.mark.asyncio
async def test_execute_tool_by_capability_id(executor, mock_skill_registry):
    action = PlanStep(
        id="step_1",
        title="Test action",
        tool=None,
        capability_id="builtin:test_tool",
        params={"input": "test"},
    )

    result = await executor.execute(action)

    assert result.success is True
    assert result.tool_name == "test_tool"
    assert result.capability_id == "builtin:test_tool"
    mock_skill_registry.execute.assert_called_once()


@pytest.mark.asyncio
async def test_execute_tool_rejects_disabled_builtin(runtime_context, mock_skill_registry, tmp_path, monkeypatch):
    db_path = tmp_path / "semibot.db"
    monkeypatch.setenv("SEMIBOT_EVENTS_DB_PATH", str(db_path))
    store = RuntimeConfigStore(db_path=str(db_path))
    store.upsert_tool_by_name("test_tool", {"is_active": False, "config": {}, "type": "builtin", "is_builtin": True})

    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
    )
    action = PlanStep(
        id="step_1",
        title="Test disabled tool",
        tool="test_tool",
        params={"input": "test"},
    )

    result = await executor.execute(action)

    assert result.success is False
    assert result.metadata["error_code"] == "TOOL_DISABLED"
    mock_skill_registry.execute.assert_not_called()


@pytest.mark.asyncio
async def test_execute_caches_tool_row_lookup_per_executor(runtime_context, mock_skill_registry, monkeypatch):
    lookup_calls: list[str] = []

    class FakeStore:
        def __init__(self, db_path=None):
            self.db_path = db_path

        def get_tool_by_name(self, tool_name):
            lookup_calls.append(tool_name)
            return {"name": tool_name, "is_active": True, "config": {}}

    monkeypatch.setattr("src.orchestrator.unified_executor.RuntimeConfigStore", FakeStore)

    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
    )
    action = PlanStep(
        id="step_1",
        title="Test tool caching",
        tool="test_tool",
        params={"input": "test"},
    )

    await executor.execute(action)

    assert lookup_calls.count("test_tool") == 1


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
async def test_execute_mcp_tool_by_capability_id(executor, mock_mcp_client):
    action = PlanStep(
        id="step_1",
        title="Test action",
        tool=None,
        capability_id="mcp:mcp_1:mcp_tool",
        params={"input": "test"},
    )

    result = await executor.execute(action)

    assert result.success is True
    assert result.capability_id == "mcp:mcp_1:mcp_tool"
    mock_mcp_client.call_tool.assert_called_once_with(
        server_id="mcp_1",
        tool_name="mcp_tool",
        arguments={"input": "test"},
    )


@pytest.mark.asyncio
async def test_execute_disambiguated_mcp_tool_uses_actual_tool_name(mock_skill_registry, mock_mcp_client):
    runtime_context = RuntimeSessionContext(
        user_id="user_456",
        agent_id="agent_789",
        session_id="session_abc",
        agent_config=AgentConfig(id="agent_789", name="Test Agent"),
        available_tools=[ToolDefinition(name="search", description="Builtin search")],
        available_mcp_servers=[
            McpServerDefinition(
                id="mcp_1",
                name="remote_search",
                endpoint="http://localhost:8080",
                transport="http",
                is_connected=True,
                available_tools=[
                    {
                        "name": "search",
                        "description": "Remote search",
                        "inputSchema": {},
                    }
                ],
            )
        ],
    )
    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
        mcp_client=mock_mcp_client,
    )

    result = await executor.execute(
        PlanStep(id="step_1", title="Search remotely", tool="mcp__mcp_1__search", params={"q": "test"})
    )

    assert result.success is True
    mock_mcp_client.call_tool.assert_called_once_with(
        server_id="mcp_1",
        tool_name="search",
        arguments={"q": "test"},
    )


@pytest.mark.asyncio
async def test_execute_disambiguated_builtin_tool_uses_actual_tool_name(mock_skill_registry, mock_mcp_client):
    runtime_context = RuntimeSessionContext(
        user_id="user_456",
        agent_id="agent_789",
        session_id="session_abc",
        agent_config=AgentConfig(id="agent_789", name="Test Agent"),
        available_tools=[ToolDefinition(name="search", description="Builtin search")],
        available_mcp_servers=[
            McpServerDefinition(
                id="mcp_1",
                name="remote_search",
                endpoint="http://localhost:8080",
                transport="http",
                is_connected=True,
                available_tools=[
                    {
                        "name": "search",
                        "description": "Remote search",
                        "inputSchema": {},
                    }
                ],
            )
        ],
    )
    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
        mcp_client=mock_mcp_client,
    )

    result = await executor.execute(
        PlanStep(id="step_1", title="Search locally", tool="builtin__search", params={"query": "test"})
    )

    assert result.success is True
    mock_skill_registry.execute.assert_called_once()
    assert mock_skill_registry.execute.call_args.args[0] == "search"


@pytest.mark.asyncio
async def test_execute_projected_group_tool_maps_back_to_parent_tool(mock_skill_registry):
    runtime_context = RuntimeSessionContext(
        user_id="user_456",
        agent_id="agent_789",
        session_id="session_abc",
        agent_config=AgentConfig(id="agent_789", name="Test Agent"),
        available_tools=[
            ToolDefinition(
                name="opencli_xiaohongshu",
                description="Usage: opencli xiaohongshu [options] [command]",
                metadata={
                    "source_type": "cli",
                    "provider_id": "opencli",
                    "shape": "group",
                    "actions": [
                        {
                            "command": "search",
                            "description": "Search Xiaohongshu notes",
                            "parameters": {
                                "type": "object",
                                "properties": {"query": {"type": "string", "minLength": 1}},
                                "required": ["query"],
                                "additionalProperties": False,
                            },
                        }
                    ],
                },
            )
        ],
    )
    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
    )

    result = await executor.execute(
        PlanStep(id="step_1", title="Search locally", tool="opencli_xiaohongshu_search", params={"query": "AI新闻"})
    )

    assert result.success is True
    mock_skill_registry.execute.assert_called_once_with(
        "opencli_xiaohongshu",
        {
            "query": "AI新闻",
            "command": "search",
            "_runtime_context": runtime_context,
        },
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


def test_build_metadata_file_io_read_is_low_risk(file_io_executor):
    capability = file_io_executor.capability_graph.get_capability("file_io")

    metadata = file_io_executor._build_metadata(
        capability,
        "file_io",
        {"action": "read", "path": "report.md"},
    )

    assert metadata.is_high_risk is False
    assert metadata.requires_approval is False
    assert metadata.additional["risk_level"] == "low"


def test_build_metadata_file_io_write_stays_high_risk(file_io_executor):
    capability = file_io_executor.capability_graph.get_capability("file_io")

    metadata = file_io_executor._build_metadata(
        capability,
        "file_io",
        {"action": "write", "path": "report.md", "content": "x"},
    )

    assert metadata.is_high_risk is True
    assert metadata.requires_approval is True
    assert metadata.additional["risk_level"] == "high"


def test_build_metadata_sub_agent_includes_contract_fields(sub_agent_executor):
    executor, _ = sub_agent_executor
    capability = executor.capability_graph.get_capability("agent:agent_research")

    metadata = executor._build_metadata(
        capability,
        "subagent:agent_research",
        {"task": "Investigate"},
    )

    assert metadata.capability_type == "sub_agent"
    assert metadata.additional["risk_level"] == "medium"
    assert metadata.additional["timeout_ms"] == 120_000


@pytest.mark.asyncio
async def test_execute_sub_agent_uses_unified_executor_route(sub_agent_executor):
    executor, mock_delegator = sub_agent_executor
    action = PlanStep(
        id="step_1",
        title="Delegate research",
        tool="subagent:agent_research",
        capability_id="agent:agent_research",
        params={
            "task": "Research topic X",
            "context": {"memory": "prior notes"},
        },
    )

    result = await executor.execute(action)

    assert result.success is True
    assert result.capability_id == "agent:agent_research"
    assert result.metadata["capability_type"] == "sub_agent"
    assert result.metadata["delegate"] is True
    mock_delegator.delegate.assert_awaited_once_with(
        sub_agent_id="agent_research",
        task="Research topic X",
        context={"memory": "prior notes"},
        timeout_seconds=120.0,
    )


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
async def test_approval_hook_pending_does_not_become_denied(runtime_context, mock_skill_registry):
    """Pending approval should pause execution without emitting approval_denied."""
    approval_hook = AsyncMock(
        return_value={
            "approved": False,
            "status": "pending",
            "approval_id": "appr_test",
            "reason": "需要人工审批后才会执行",
        }
    )
    event_emitter = AsyncMock()

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
        event_emitter=event_emitter,
    )

    action = PlanStep(
        id="step_1",
        title="Test action",
        tool="dangerous_tool",
        params={"input": "test"},
    )

    result = await executor.execute(action)

    assert result.success is False
    assert result.metadata["approval_status"] == "pending"
    assert result.metadata["approval_id"] == "appr_test"
    assert "人工审批" in (result.error or "")

    emitted_types = [call.args[0].event_type for call in event_emitter.emit.await_args_list]
    assert "tool.exec.pending_approval" in emitted_types
    assert "tool.exec.failed" not in emitted_types

    mock_skill_registry.execute.assert_not_called()


@pytest.mark.asyncio
async def test_fake_ip_guard_requests_approval_and_passes_override_on_approve(
    runtime_context,
    mock_skill_registry,
    monkeypatch,
):
    approval_hook = AsyncMock(return_value=True)
    event_emitter = AsyncMock()

    runtime_context.available_tools.append(
        ToolDefinition(
            name="web_fetch",
            description="Web fetch tool",
        )
    )

    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
        approval_hook=approval_hook,
        event_emitter=event_emitter,
    )

    monkeypatch.setattr(
        "src.orchestrator.unified_executor.inspect_remote_url",
        lambda raw_url, **kwargs: (
            "approval_required",
            {
                "host": "example.com",
                "resolved_ip": "198.18.0.10",
                "blocked_reason": "reserved/test-network",
                "guard": "fake_ip_dns",
            },
        ),
    )

    action = PlanStep(
        id="step_fake_ip",
        title="Fetch fake-ip URL",
        tool="web_fetch",
        params={"url": "https://example.com/article"},
    )

    result = await executor.execute(action)

    assert result.success is True
    approval_hook.assert_called_once()
    mock_skill_registry.execute.assert_called_once()
    called_tool_name = mock_skill_registry.execute.call_args.args[0]
    called_params = mock_skill_registry.execute.call_args.args[1]
    assert called_tool_name == "web_fetch"
    assert called_params["_approved_fake_ip_override"] is True


@pytest.mark.asyncio
async def test_fake_ip_guard_keeps_session_scope_without_forcing_url_dedupe(
    runtime_context,
    mock_skill_registry,
    monkeypatch,
):
    captured: dict[str, object] = {}

    async def approval_hook(tool_name, params, metadata):
        captured["tool_name"] = tool_name
        captured["params"] = params
        captured["metadata"] = metadata
        return {"approved": False, "status": "pending", "approval_id": "appr_pending"}

    event_emitter = AsyncMock()

    runtime_context.available_tools.append(
        ToolDefinition(
            name="web_fetch",
            description="Web fetch tool",
            metadata={"approval_scope": "session", "approval_dedupe_keys": []},
        )
    )

    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
        approval_hook=approval_hook,
        event_emitter=event_emitter,
    )

    monkeypatch.setattr(
        "src.orchestrator.unified_executor.inspect_remote_url",
        lambda raw_url, **kwargs: (
            "approval_required",
            {
                "host": "example.com",
                "resolved_ip": "198.18.0.10",
                "blocked_reason": "reserved/test-network",
                "guard": "fake_ip_dns",
            },
        ),
    )

    action = PlanStep(
        id="step_fake_ip_pending",
        title="Fetch fake-ip URL",
        tool="web_fetch",
        params={"url": "https://example.com/article"},
    )

    result = await executor.execute(action)

    assert result.success is False
    assert result.metadata["approval_status"] == "pending"
    metadata = captured.get("metadata")
    additional = getattr(metadata, "additional", {}) if metadata is not None else {}
    assert additional.get("approval_scope") == "session"
    assert additional.get("approval_dedupe_keys") in (None, [])


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
    assert result.metadata["approval_status"] == "error"
    assert result.metadata["guard"] == "approval_hook_failed"


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
    # Skills are disabled in capability graph; test_skill is registered as a tool
    assert result.metadata["capability_type"] == "tool"
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
        tool="test_tool",
        params={"input": "ping"},
    )
    result = await executor.execute(action)

    assert result.success is True
    assert len(emitter.events) >= 2
    event_types = [event.event_type for event in emitter.events]
    assert "tool.exec.started" in event_types
    assert "tool.exec.completed" in event_types
    completed = next(event for event in emitter.events if event.event_type == "tool.exec.completed")
    assert completed.payload["result"] == "skill result"


@pytest.mark.asyncio
async def test_tool_exec_completed_event_includes_result_payload(runtime_context, mock_skill_registry):
    class DummyEmitter:
        def __init__(self):
            self.events = []

        async def emit(self, event):
            self.events.append(event)

    mock_skill_registry.execute = AsyncMock(
        return_value=ToolResult(
            result={"items": [{"title": "A"}], "total": 1},
            success=True,
        )
    )
    emitter = DummyEmitter()
    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
        event_emitter=emitter,
    )

    action = PlanStep(
        id="step_emit_result",
        title="Emit result",
        tool="test_tool",
        params={"input": "ping"},
    )
    await executor.execute(action)

    completed = next(event for event in emitter.events if event.event_type == "tool.exec.completed")
    assert completed.payload["result"] == {"items": [{"title": "A"}], "total": 1}


@pytest.mark.asyncio
async def test_tool_exec_completed_event_includes_generated_file_metadata(runtime_context, mock_skill_registry):
    class DummyEmitter:
        def __init__(self):
            self.events = []

        async def emit(self, event):
            self.events.append(event)

    mock_skill_registry.execute = AsyncMock(
        return_value=ToolResult(
            result={"stdout": "done"},
            success=True,
            metadata={
                "generated_files": [
                    {
                        "file_id": "file_1",
                        "filename": "report.md",
                        "path": "/tmp/persisted/report.md",
                        "source_path": "/tmp/work/report.md",
                        "artifact_role": "report_md",
                        "user_visible": True,
                    }
                ],
                "work_dir": "/tmp/work",
            },
        )
    )
    emitter = DummyEmitter()
    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
        event_emitter=emitter,
    )

    action = PlanStep(
        id="step_emit_metadata",
        title="Emit metadata",
        tool="test_tool",
        params={"input": "ping"},
    )
    await executor.execute(action)

    completed = next(event for event in emitter.events if event.event_type == "tool.exec.completed")
    assert completed.payload["metadata"]["generated_files"][0]["filename"] == "report.md"
    assert completed.payload["metadata"]["generated_files"][0]["source_path"] == "/tmp/work/report.md"
    assert completed.payload["metadata"]["work_dir"] == "/tmp/work"
