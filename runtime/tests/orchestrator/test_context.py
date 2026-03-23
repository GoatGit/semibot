"""Tests for RuntimeSessionContext and AgentState integration.

This test verifies that the RuntimeSessionContext is properly integrated
into the AgentState and can be accessed by nodes.
"""

import pytest
from src.orchestrator.context import (
    RuntimeSessionContext,
    AgentConfig,
    SkillDefinition,
    ToolDefinition,
    McpServerDefinition,
    RuntimePolicy,
)
from src.orchestrator.state import create_initial_state, AgentState


def test_runtime_session_context_creation():
    """Test creating a RuntimeSessionContext."""
    agent_config = AgentConfig(
        id="agent_123",
        name="Test Agent",
        description="A test agent",
        system_prompt="You are a helpful assistant",
        model="gpt-4o",
        temperature=0.7,
        max_tokens=4096,
    )

    skill1 = SkillDefinition(
        id="skill_1",
        name="web_search",
        description="Search the web",
        version="1.0.0",
        source="local",
    )

    skill2 = SkillDefinition(
        id="skill_2",
        name="code_executor",
        description="Execute code",
        version="1.0.0",
        source="anthropic",
    )

    runtime_context = RuntimeSessionContext(
        user_id="user_456",
        agent_id="agent_123",
        session_id="session_789",
        agent_config=agent_config,
        available_skills=[skill1, skill2],
        available_tools=[],
        available_mcp_servers=[],
        runtime_policy=RuntimePolicy(),
    )

    assert runtime_context.user_id == "user_456"
    assert runtime_context.agent_id == "agent_123"
    assert runtime_context.session_id == "session_789"
    assert len(runtime_context.available_skills) == 2
    assert runtime_context.agent_config.name == "Test Agent"


def test_runtime_context_capability_methods():
    """Test RuntimeSessionContext capability helper methods."""
    skill1 = SkillDefinition(
        id="skill_1",
        name="web_search",
        description="Search the web",
    )

    tool1 = ToolDefinition(
        name="calculator",
        description="Perform calculations",
    )

    runtime_context = RuntimeSessionContext(
        user_id="user_456",
        agent_id="agent_123",
        session_id="session_789",
        agent_config=AgentConfig(id="agent_123", name="Test Agent"),
        available_skills=[skill1],
        available_tools=[tool1],
    )

    # Test get_all_capability_names
    capability_names = runtime_context.get_all_capability_names()
    assert "web_search" in capability_names
    assert "calculator" in capability_names

    # Test has_capability
    assert runtime_context.has_capability("web_search") is True
    assert runtime_context.has_capability("calculator") is True
    assert runtime_context.has_capability("nonexistent") is False

    # Test get_skill_by_name
    skill = runtime_context.get_skill_by_name("web_search")
    assert skill is not None
    assert skill.name == "web_search"

    # Test get_tool_by_name
    tool = runtime_context.get_tool_by_name("calculator")
    assert tool is not None
    assert tool.name == "calculator"


def test_runtime_context_builds_unified_tool_catalog_with_collision_safe_names():
    """Builtin and MCP tools with the same actual name should get distinct prompt names."""
    runtime_context = RuntimeSessionContext(
        user_id="user_456",
        agent_id="agent_123",
        session_id="session_789",
        agent_config=AgentConfig(id="agent_123", name="Test Agent"),
        available_tools=[
            ToolDefinition(name="search", description="Builtin search"),
        ],
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
                        "inputSchema": {"type": "object", "properties": {}},
                    }
                ],
            )
        ],
    )

    catalog = runtime_context.get_tool_catalog()

    assert len(catalog) == 2
    assert {entry.tool_id for entry in catalog} == {"builtin:search", "mcp:mcp_1:search"}
    assert len({entry.tool_name for entry in catalog}) == 2
    assert all(entry.actual_tool_name == "search" for entry in catalog)


def test_runtime_context_includes_registry_cli_tools_in_catalog():
    runtime_context = RuntimeSessionContext(
        user_id="user_456",
        agent_id="agent_123",
        session_id="session_789",
        agent_config=AgentConfig(id="agent_123", name="Test Agent"),
        available_tools=[
            ToolDefinition(
                name="browser_search",
                description="Search via local browser harness",
                parameters={"type": "object", "properties": {"query": {"type": "string"}}},
                metadata={"source": "opencli", "package_id": "opencli-browser"},
            )
        ],
    )

    catalog = runtime_context.get_tool_catalog()

    assert len(catalog) == 1
    assert catalog[0].tool_id == "cli:opencli-browser:browser_search"
    assert catalog[0].source_type == "cli"
    assert catalog[0].provider_id == "opencli-browser"
    assert catalog[0].tool_name == "browser_search"


def test_create_initial_state_with_context():
    """Test creating initial state with RuntimeSessionContext."""
    runtime_context = RuntimeSessionContext(
        user_id="user_456",
        agent_id="agent_123",
        session_id="session_789",
        agent_config=AgentConfig(id="agent_123", name="Test Agent"),
    )

    state = create_initial_state(
        session_id="session_789",
        agent_id="agent_123",
        user_message="Hello, world!",
        context=runtime_context,
    )

    assert state["session_id"] == "session_789"
    assert state["agent_id"] == "agent_123"
    assert state["context"] == runtime_context
    assert len(state["messages"]) == 1
    assert state["messages"][0]["content"] == "Hello, world!"
    assert state["current_step"] == "start"


def test_agent_state_context_access():
    """Test accessing context from AgentState."""
    skill1 = SkillDefinition(
        id="skill_1",
        name="web_search",
        description="Search the web",
    )

    runtime_context = RuntimeSessionContext(
        user_id="user_456",
        agent_id="agent_123",
        session_id="session_789",
        agent_config=AgentConfig(id="agent_123", name="Test Agent"),
        available_skills=[skill1],
    )

    state = create_initial_state(
        session_id="session_789",
        agent_id="agent_123",
        user_message="Test message",
        context=runtime_context,
    )

    # Access context from state
    context = state["context"]
    assert context.user_id == "user_456"
    assert len(context.available_skills) == 1
    assert context.available_skills[0].name == "web_search"

    # Test capability methods through state
    assert context.has_capability("web_search") is True
    assert context.has_capability("nonexistent") is False


def test_runtime_policy_defaults():
    """Test RuntimePolicy default values."""
    policy = RuntimePolicy()

    assert policy.max_iterations == 15
    assert policy.max_replan_attempts == 3
    assert policy.enable_parallel_execution is True
    assert policy.enable_delegation is True
    assert policy.require_approval_for_high_risk is True
    assert isinstance(policy.high_risk_tools, list)


def test_runtime_policy_custom():
    """Test RuntimePolicy with custom values."""
    policy = RuntimePolicy(
        max_iterations=20,
        max_replan_attempts=5,
        enable_parallel_execution=False,
        high_risk_tools=["code_run", "shell_exec"],
    )

    assert policy.max_iterations == 20
    assert policy.max_replan_attempts == 5
    assert policy.enable_parallel_execution is False
    assert "code_run" in policy.high_risk_tools
    assert "shell_exec" in policy.high_risk_tools


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
