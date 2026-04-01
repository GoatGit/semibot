"""Tests for tool_search builtin tool."""

import pytest

from src.orchestrator.context import AgentConfig, McpServerDefinition, RuntimeSessionContext
from src.skills.registry import SkillMetadata, SkillRegistry
from src.skills.synthetic_output import SyntheticOutputTool
from src.skills.text_processing import TextProcessingTool
from src.skills.tool_search import ToolSearchTool


@pytest.mark.asyncio
async def test_tool_search_returns_best_matching_tool() -> None:
    registry = SkillRegistry()
    registry.register_tool(TextProcessingTool())
    registry.register_tool(ToolSearchTool(registry))

    result = await registry.get_tool("tool_search").execute(query="summary compact", limit=5)  # type: ignore[union-attr]

    assert result.success is True
    assert result.result["total_matches"] >= 1
    assert result.result["items"][0]["tool_name"] == "text_processing"


@pytest.mark.asyncio
async def test_tool_search_can_filter_cli_entries_and_include_parameters() -> None:
    registry = SkillRegistry()
    registry.register_tool(
        TextProcessingTool(),
        metadata=SkillMetadata(
            source="package",
            additional={"package_id": "pkg_text"},
        ),
    )
    registry.register_tool(ToolSearchTool(registry))

    result = await registry.get_tool("tool_search").execute(  # type: ignore[union-attr]
        query="text processing",
        source_type="cli",
        include_parameters=True,
    )

    assert result.success is True
    assert result.result["total_matches"] == 1
    item = result.result["items"][0]
    assert item["tool_name"] == "text_processing"
    assert item["source_type"] == "cli"
    assert "parameters" in item


@pytest.mark.asyncio
async def test_tool_search_excludes_itself_by_default() -> None:
    registry = SkillRegistry()
    registry.register_tool(ToolSearchTool(registry))

    result = await registry.get_tool("tool_search").execute(query="tool search", include_self=False)  # type: ignore[union-attr]

    assert result.success is True
    assert result.result["total_matches"] == 0


@pytest.mark.asyncio
async def test_tool_search_prefers_runtime_catalog_and_can_find_mcp_tools() -> None:
    registry = SkillRegistry()
    registry.register_tool(TextProcessingTool())
    registry.register_tool(ToolSearchTool(registry))
    runtime_context = RuntimeSessionContext(
        agent_id="agent-1",
        session_id="session-1",
        agent_config=AgentConfig(id="agent-1", name="agent-1"),
        metadata={},
        available_tools=[],
        available_mcp_servers=[
            McpServerDefinition(
                id="github",
                name="GitHub",
                endpoint="stdio://github",
                transport="stdio",
                is_connected=True,
                available_tools=[
                    {
                        "name": "list_issues",
                        "description": "List GitHub issues",
                        "inputSchema": {"type": "object", "properties": {"repo": {"type": "string"}}},
                    }
                ],
            )
        ],
    )

    result = await registry.get_tool("tool_search").execute(  # type: ignore[union-attr]
        query="github issues",
        source_type="mcp",
        _runtime_context=runtime_context,
    )

    assert result.success is True
    assert result.result["total_matches"] == 1
    assert result.result["items"][0]["source_type"] == "mcp"
    assert result.result["items"][0]["actual_tool_name"] == "list_issues"


@pytest.mark.asyncio
async def test_tool_search_supports_select_prefix() -> None:
    registry = SkillRegistry()
    registry.register_tool(TextProcessingTool())
    registry.register_tool(ToolSearchTool(registry))

    result = await registry.get_tool("tool_search").execute(query="select:text_processing")  # type: ignore[union-attr]

    assert result.success is True
    assert result.result["total_matches"] == 1
    assert result.result["items"][0]["tool_name"] == "text_processing"


@pytest.mark.asyncio
async def test_tool_search_uses_search_hint_for_capability_phrase_matches() -> None:
    registry = SkillRegistry()
    registry.register_tool(SyntheticOutputTool())
    registry.register_tool(ToolSearchTool(registry))

    result = await registry.get_tool("tool_search").execute(query="final response structured json")  # type: ignore[union-attr]

    assert result.success is True
    assert result.result["total_matches"] >= 1
    assert result.result["items"][0]["tool_name"] == "synthetic_output"
