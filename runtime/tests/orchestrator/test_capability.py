"""Tests for CapabilityGraph and Capability models.

This test verifies that the CapabilityGraph correctly builds from
RuntimeSessionContext and provides proper capability management.
"""

import pytest
from src.orchestrator.capability import (
    CapabilityGraph,
    Capability,
    SkillCapability,
    ToolCapability,
    McpCapability,
)
from src.orchestrator.context import (
    RuntimeSessionContext,
    AgentConfig,
    SkillDefinition,
    ToolDefinition,
    McpServerDefinition,
    RuntimePolicy,
)


def test_skill_capability_creation():
    """Test creating a SkillCapability."""
    skill_def = SkillDefinition(
        id="skill_1",
        name="web_search",
        description="Search the web",
        version="1.0.0",
        source="local",
        schema={
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"}
                },
                "required": ["query"],
            }
        },
    )

    capability = SkillCapability(skill_definition=skill_def)

    assert capability.name == "web_search"
    assert capability.description == "Search the web"
    assert capability.capability_type == "skill"
    assert capability.metadata["version"] == "1.0.0"
    assert capability.metadata["source"] == "local"


def test_skill_capability_to_schema():
    """Test converting SkillCapability to LLM schema."""
    skill_def = SkillDefinition(
        id="skill_1",
        name="web_search",
        description="Search the web",
        version="1.0.0",
        source="anthropic",
        schema={
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"}
                },
            }
        },
    )

    capability = SkillCapability(skill_definition=skill_def)
    schema = capability.to_schema()

    assert schema["type"] == "function"
    assert schema["function"]["name"] == "web_search"
    assert schema["function"]["description"] == "Search the web"
    assert "parameters" in schema["function"]
    assert schema["metadata"]["capability_type"] == "skill"
    assert schema["metadata"]["source"] == "anthropic"
    assert schema["metadata"]["version"] == "1.0.0"


def test_tool_capability_creation():
    """Test creating a ToolCapability."""
    tool_def = ToolDefinition(
        name="calculator",
        description="Perform calculations",
        parameters={
            "type": "object",
            "properties": {
                "expression": {"type": "string"}
            },
        },
    )

    capability = ToolCapability(tool_definition=tool_def)

    assert capability.name == "calculator"
    assert capability.description == "Perform calculations"
    assert capability.capability_type == "tool"


def test_tool_capability_to_schema():
    """Test converting ToolCapability to LLM schema."""
    tool_def = ToolDefinition(
        name="calculator",
        description="Perform calculations",
        parameters={
            "type": "object",
            "properties": {
                "expression": {"type": "string"}
            },
        },
    )

    capability = ToolCapability(tool_definition=tool_def)
    schema = capability.to_schema()

    assert schema["type"] == "function"
    assert schema["function"]["name"] == "calculator"
    assert schema["function"]["parameters"]["type"] == "object"
    assert schema["metadata"]["capability_type"] == "tool"
    assert schema["metadata"]["source"] == "builtin"


def test_mcp_capability_creation():
    """Test creating an McpCapability."""
    capability = McpCapability(
        name="github_create_issue",
        description="Create a GitHub issue",
        mcp_server_id="mcp_1",
        mcp_server_name="GitHub MCP",
        tool_schema={
            "name": "github_create_issue",
            "description": "Create a GitHub issue",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "body": {"type": "string"},
                },
            },
        },
    )

    assert capability.name == "github_create_issue"
    assert capability.capability_type == "mcp"
    assert capability.mcp_server_id == "mcp_1"


def test_mcp_capability_to_schema():
    """Test converting McpCapability to LLM schema."""
    capability = McpCapability(
        name="github_create_issue",
        description="Create a GitHub issue",
        mcp_server_id="mcp_1",
        mcp_server_name="GitHub MCP",
        tool_schema={
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                },
            },
        },
    )

    schema = capability.to_schema()

    assert schema["type"] == "function"
    assert schema["function"]["name"] == "github_create_issue"
    assert "parameters" in schema["function"]
    assert schema["metadata"]["capability_type"] == "mcp"
    assert schema["metadata"]["mcp_server_id"] == "mcp_1"


def test_capability_graph_build():
    """Test building CapabilityGraph from RuntimeSessionContext."""
    skill1 = SkillDefinition(
        id="skill_1",
        name="web_search",
        description="Search the web",
    )

    skill2 = SkillDefinition(
        id="skill_2",
        name="code_executor",
        description="Execute code",
    )

    tool1 = ToolDefinition(
        name="calculator",
        description="Perform calculations",
    )

    mcp_server = McpServerDefinition(
        id="mcp_1",
        name="GitHub MCP",
        endpoint="/path/to/mcp",
        transport="stdio",
        is_connected=True,
        available_tools=[
            {
                "name": "github_create_issue",
                "description": "Create a GitHub issue",
            }
        ],
    )

    runtime_context = RuntimeSessionContext(
        org_id="org_123",
        user_id="user_456",
        agent_id="agent_123",
        session_id="session_789",
        agent_config=AgentConfig(id="agent_123", name="Test Agent"),
        available_skills=[skill1, skill2],
        available_tools=[tool1],
        available_mcp_servers=[mcp_server],
    )

    graph = CapabilityGraph(runtime_context)
    graph.build()

    # Verify capabilities were loaded
    assert len(graph.capabilities) == 4
    assert "web_search" in graph.capabilities
    assert "code_executor" in graph.capabilities
    assert "calculator" in graph.capabilities
    assert "github_create_issue" in graph.capabilities


def test_capability_graph_get_schemas_for_planner():
    """Test generating schemas for planner."""
    skill1 = SkillDefinition(
        id="skill_1",
        name="web_search",
        description="Search the web",
        schema={
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"}
                },
            }
        },
    )

    runtime_context = RuntimeSessionContext(
        org_id="org_123",
        user_id="user_456",
        agent_id="agent_123",
        session_id="session_789",
        agent_config=AgentConfig(id="agent_123", name="Test Agent"),
        available_skills=[skill1],
    )

    graph = CapabilityGraph(runtime_context)
    schemas = graph.get_schemas_for_planner()

    assert len(schemas) == 1
    assert schemas[0]["type"] == "function"
    assert schemas[0]["function"]["name"] == "web_search"
    assert "parameters" in schemas[0]["function"]


def test_capability_graph_validate_action():
    """Test validating actions against capability graph."""
    skill1 = SkillDefinition(
        id="skill_1",
        name="web_search",
        description="Search the web",
    )

    runtime_context = RuntimeSessionContext(
        org_id="org_123",
        user_id="user_456",
        agent_id="agent_123",
        session_id="session_789",
        agent_config=AgentConfig(id="agent_123", name="Test Agent"),
        available_skills=[skill1],
    )

    graph = CapabilityGraph(runtime_context)

    # Valid action
    assert graph.validate_action("web_search") is True

    # Invalid action
    assert graph.validate_action("nonexistent_tool") is False


def test_capability_graph_get_capability():
    """Test getting capability by name."""
    skill1 = SkillDefinition(
        id="skill_1",
        name="web_search",
        description="Search the web",
    )

    runtime_context = RuntimeSessionContext(
        org_id="org_123",
        user_id="user_456",
        agent_id="agent_123",
        session_id="session_789",
        agent_config=AgentConfig(id="agent_123", name="Test Agent"),
        available_skills=[skill1],
    )

    graph = CapabilityGraph(runtime_context)

    # Get existing capability
    capability = graph.get_capability("web_search")
    assert capability is not None
    assert capability.name == "web_search"
    assert isinstance(capability, SkillCapability)

    # Get non-existent capability
    capability = graph.get_capability("nonexistent")
    assert capability is None


def test_capability_graph_list_capabilities():
    """Test listing all capabilities."""
    skill1 = SkillDefinition(id="skill_1", name="web_search")
    tool1 = ToolDefinition(name="calculator")

    runtime_context = RuntimeSessionContext(
        org_id="org_123",
        user_id="user_456",
        agent_id="agent_123",
        session_id="session_789",
        agent_config=AgentConfig(id="agent_123", name="Test Agent"),
        available_skills=[skill1],
        available_tools=[tool1],
    )

    graph = CapabilityGraph(runtime_context)
    capabilities = graph.list_capabilities()

    assert len(capabilities) == 2
    assert "web_search" in capabilities
    assert "calculator" in capabilities


def test_capability_graph_get_capabilities_by_type():
    """Test getting capabilities by type."""
    skill1 = SkillDefinition(id="skill_1", name="web_search")
    skill2 = SkillDefinition(id="skill_2", name="code_executor")
    tool1 = ToolDefinition(name="calculator")

    runtime_context = RuntimeSessionContext(
        org_id="org_123",
        user_id="user_456",
        agent_id="agent_123",
        session_id="session_789",
        agent_config=AgentConfig(id="agent_123", name="Test Agent"),
        available_skills=[skill1, skill2],
        available_tools=[tool1],
    )

    graph = CapabilityGraph(runtime_context)

    # Get skills
    skills = graph.get_capabilities_by_type("skill")
    assert len(skills) == 2
    assert all(c.capability_type == "skill" for c in skills)

    # Get tools
    tools = graph.get_capabilities_by_type("tool")
    assert len(tools) == 1
    assert all(c.capability_type == "tool" for c in tools)

    # Get MCP tools
    mcp_tools = graph.get_capabilities_by_type("mcp")
    assert len(mcp_tools) == 0


def test_capability_graph_only_connected_mcp_servers():
    """Test that only connected MCP servers are included."""
    mcp_connected = McpServerDefinition(
        id="mcp_1",
        name="GitHub MCP",
        endpoint="/path/to/mcp",
        transport="stdio",
        is_connected=True,
        available_tools=[
            {"name": "github_create_issue", "description": "Create issue"}
        ],
    )

    mcp_disconnected = McpServerDefinition(
        id="mcp_2",
        name="Slack MCP",
        endpoint="/path/to/slack",
        transport="stdio",
        is_connected=False,
        available_tools=[
            {"name": "slack_send_message", "description": "Send message"}
        ],
    )

    runtime_context = RuntimeSessionContext(
        org_id="org_123",
        user_id="user_456",
        agent_id="agent_123",
        session_id="session_789",
        agent_config=AgentConfig(id="agent_123", name="Test Agent"),
        available_mcp_servers=[mcp_connected, mcp_disconnected],
    )

    graph = CapabilityGraph(runtime_context)
    graph.build()

    # Only connected MCP tools should be included
    assert "github_create_issue" in graph.capabilities
    assert "slack_send_message" not in graph.capabilities


def test_capability_graph_auto_build():
    """Test that capability graph auto-builds when needed."""
    skill1 = SkillDefinition(id="skill_1", name="web_search")

    runtime_context = RuntimeSessionContext(
        org_id="org_123",
        user_id="user_456",
        agent_id="agent_123",
        session_id="session_789",
        agent_config=AgentConfig(id="agent_123", name="Test Agent"),
        available_skills=[skill1],
    )

    graph = CapabilityGraph(runtime_context)

    # Graph should auto-build when calling methods
    assert graph._built is False

    # Call validate_action - should trigger build
    graph.validate_action("web_search")
    assert graph._built is True

    # Subsequent calls should not rebuild
    graph.validate_action("web_search")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
