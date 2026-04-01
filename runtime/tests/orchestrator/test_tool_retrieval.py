"""Tests for ACT tool shortlist retrieval."""

from src.orchestrator.context import AgentConfig, McpServerDefinition, RuntimeSessionContext, ToolDefinition
from src.orchestrator.act_tool_executor import _build_act_tool_schemas
from src.orchestrator.tool_retrieval import build_shortlist_tool_schemas, select_tool_shortlist


def _runtime_context() -> RuntimeSessionContext:
    return RuntimeSessionContext(
        user_id="user_1",
        agent_id="agent_1",
        session_id="session_1",
        agent_config=AgentConfig(id="agent_1", name="Test Agent"),
        available_tools=[
            ToolDefinition(name="file_io", description="Read and write files"),
            ToolDefinition(name="search", description="Search the web"),
            ToolDefinition(name="web_fetch", description="Fetch a web page"),
            ToolDefinition(name="code_executor", description="Run code"),
        ],
        available_mcp_servers=[
            McpServerDefinition(
                id="github",
                name="GitHub",
                endpoint="http://localhost:8080",
                transport="http",
                is_connected=True,
                available_tools=[
                    {
                        "name": "create_issue",
                        "description": "Create a GitHub issue",
                        "inputSchema": {"type": "object", "properties": {"title": {"type": "string"}}},
                    }
                ],
            )
        ],
    )


def test_select_tool_shortlist_keeps_core_builtin_tools():
    runtime_context = _runtime_context()

    shortlist = select_tool_shortlist(runtime_context, query="summarize this repository issue history", limit=4)
    shortlist_names = {entry.actual_tool_name for entry in shortlist}

    assert "file_io" in shortlist_names
    assert "search" in shortlist_names


def test_select_tool_shortlist_prefers_lexically_relevant_tool():
    runtime_context = _runtime_context()

    shortlist = select_tool_shortlist(runtime_context, query="create a github issue for this bug", limit=6)

    assert any(entry.actual_tool_name == "create_issue" for entry in shortlist)


def test_build_shortlist_tool_schemas_uses_disambiguated_prompt_names():
    runtime_context = RuntimeSessionContext(
        user_id="user_1",
        agent_id="agent_1",
        session_id="session_1",
        agent_config=AgentConfig(id="agent_1", name="Test Agent"),
        available_tools=[ToolDefinition(name="search", description="Builtin search")],
        available_mcp_servers=[
            McpServerDefinition(
                id="github",
                name="GitHub",
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

    schemas = build_shortlist_tool_schemas(runtime_context, query="search github issues", limit=8)
    names = {schema["function"]["name"] for schema in schemas}

    assert "builtin__search" in names
    assert "mcp__github__search" in names


def test_build_act_tool_schemas_records_shortlist_ids_in_runtime_metadata():
    runtime_context = RuntimeSessionContext(
        user_id="user_1",
        agent_id="agent_1",
        session_id="session_1",
        agent_config=AgentConfig(id="agent_1", name="Test Agent"),
        available_tools=[
            ToolDefinition(name="search", description="Search the web"),
            ToolDefinition(name="file_io", description="Read and write files"),
        ],
        metadata={"_current_act_tool_query": "search the web"},
    )

    schemas = _build_act_tool_schemas(runtime_context, skill_registry=None)

    assert schemas
    shortlist_ids = runtime_context.metadata.get("_current_act_tool_shortlist_ids")
    assert isinstance(shortlist_ids, list)
    assert "builtin:search" in shortlist_ids


def test_build_act_tool_schemas_projects_grouped_cli_tool_into_leaf_tools():
    runtime_context = RuntimeSessionContext(
        user_id="user_1",
        agent_id="agent_1",
        session_id="session_1",
        agent_config=AgentConfig(id="agent_1", name="Test Agent"),
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
                        },
                        {
                            "command": "user",
                            "description": "Read Xiaohongshu user profile",
                            "parameters": {
                                "type": "object",
                                "properties": {"id": {"type": "string", "minLength": 1}},
                                "required": ["id"],
                                "additionalProperties": False,
                            },
                        },
                    ],
                },
            )
        ],
        metadata={"_current_act_tool_query": "search xiaohongshu ai news"},
    )

    schemas = _build_act_tool_schemas(runtime_context, skill_registry=None)
    names = {schema["function"]["name"] for schema in schemas}

    assert "opencli_xiaohongshu_search" in names
    assert "opencli_xiaohongshu_user" in names
    assert "opencli_xiaohongshu" not in names


def test_build_act_tool_schemas_filters_group_cli_parent_reintroduced_by_registry():
    class _Registry:
        def get_tool_schemas(self) -> list[dict]:
            return [
                {
                    "type": "function",
                    "function": {
                        "name": "opencli_xiaohongshu",
                        "description": "Usage: opencli xiaohongshu [options] [command]",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "command": {"type": "string"},
                                "query": {"type": "string"},
                            },
                        },
                    },
                }
            ]

    runtime_context = RuntimeSessionContext(
        user_id="user_1",
        agent_id="agent_1",
        session_id="session_1",
        agent_config=AgentConfig(id="agent_1", name="Test Agent"),
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
        metadata={
            "_current_act_tool_query": "search xiaohongshu ai news",
            "skill_registry": _Registry(),
        },
    )

    schemas = _build_act_tool_schemas(runtime_context, skill_registry=None)
    names = {schema["function"]["name"] for schema in schemas}

    assert "opencli_xiaohongshu_search" in names
    assert "opencli_xiaohongshu" not in names


def test_select_tool_shortlist_matches_group_cli_action_metadata():
    runtime_context = RuntimeSessionContext(
        user_id="user_1",
        agent_id="agent_1",
        session_id="session_1",
        agent_config=AgentConfig(id="agent_1", name="Test Agent"),
        available_tools=[
            ToolDefinition(name="search", description="Search the web"),
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
                            "description": "搜索小红书笔记与帖子",
                            "parameters": {
                                "type": "object",
                                "properties": {"query": {"type": "string", "minLength": 1}},
                                "required": ["query"],
                                "additionalProperties": False,
                            },
                        }
                    ],
                },
            ),
        ],
        metadata={"_current_act_tool_query": "搜索小红书上最新的Claude code的笔记"},
    )

    shortlist = select_tool_shortlist(runtime_context, query="搜索小红书上最新的Claude code的笔记", limit=4)
    shortlist_names = {entry.tool_name for entry in shortlist}

    assert "search" in shortlist_names
    assert "opencli_xiaohongshu" in shortlist_names


def test_select_tool_shortlist_prefers_recently_successful_tool_usage():
    runtime_context = RuntimeSessionContext(
        user_id="user_1",
        agent_id="agent_1",
        session_id="session_1",
        agent_config=AgentConfig(id="agent_1", name="Test Agent"),
        available_tools=[
            ToolDefinition(name="file_io", description="Read and write files"),
            ToolDefinition(name="search", description="Search the web"),
            ToolDefinition(
                name="browser_search",
                description="Search in authenticated browser",
                metadata={"source_type": "cli", "package_id": "opencli-browser"},
            ),
        ],
        metadata={
            "recent_tool_usage": {
                "cli:opencli-browser:browser_search": 4,
            }
        },
    )

    shortlist = select_tool_shortlist(runtime_context, query="look up the dashboard after login", limit=4)
    ranked_ids = [entry.tool_id for entry in shortlist]

    assert "cli:opencli-browser:browser_search" in ranked_ids[:3]


def test_select_tool_shortlist_prefers_recently_used_mcp_tool_with_fallback_keys():
    runtime_context = RuntimeSessionContext(
        user_id="user_1",
        agent_id="agent_1",
        session_id="session_1",
        agent_config=AgentConfig(id="agent_1", name="Test Agent"),
        available_tools=[
            ToolDefinition(name="file_io", description="Read and write files"),
            ToolDefinition(name="search", description="Search the web"),
        ],
        available_mcp_servers=[
            McpServerDefinition(
                id="github",
                name="GitHub",
                endpoint="http://localhost:8080",
                transport="http",
                is_connected=True,
                available_tools=[
                    {
                        "name": "create_issue",
                        "description": "Create a GitHub issue",
                        "inputSchema": {"type": "object", "properties": {"title": {"type": "string"}}},
                    }
                ],
            )
        ],
        metadata={
            "recent_tool_usage": {
                "github:create_issue": 4,
            }
        },
    )

    shortlist = select_tool_shortlist(runtime_context, query="create an issue in github", limit=4)
    ranked_ids = [entry.tool_id for entry in shortlist]

    assert "mcp:github:create_issue" in ranked_ids[:3]


def test_select_tool_shortlist_expands_after_repeated_failures():
    runtime_context = RuntimeSessionContext(
        user_id="user_1",
        agent_id="agent_1",
        session_id="session_1",
        agent_config=AgentConfig(id="agent_1", name="Test Agent"),
        available_tools=[
            ToolDefinition(name="file_io", description="Read and write files"),
            ToolDefinition(name="search", description="Search the web"),
            ToolDefinition(name="web_fetch", description="Fetch a web page"),
            ToolDefinition(name="code_executor", description="Run code"),
            ToolDefinition(
                name="browser_search",
                description="Search in authenticated browser",
                metadata={"source_type": "cli", "package_id": "opencli-browser"},
            ),
        ],
        metadata={"_current_act_failure_repeat_count": 2},
    )

    shortlist = select_tool_shortlist(runtime_context, query="find records in the web app", limit=2)

    assert len(shortlist) > 2
    assert runtime_context.metadata.get("_current_act_tool_shortlist_expanded") is True
