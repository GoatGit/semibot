"""Tests for SubAgentDelegator.

Covers:
- Normal delegation flow
- Depth limit enforcement
- Unknown sub-agent handling
- Timeout handling
- Exception handling
- MCP cleanup
- delegate_node integration
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.agents.delegator import SubAgentDelegator, SUB_AGENT_EXECUTION_TIMEOUT
from src.orchestrator.context import (
    AgentConfig,
    CapabilityDescriptor,
    McpServerDefinition,
    RuntimeSessionContext,
    SubAgentDefinition,
)
from src.orchestrator.nodes_delegate import delegate_node
from src.orchestrator.state import ExecutionPlan, PlanStep, ToolCallResult


# ── Fixtures ──────────────────────────────────────────────────────────


@pytest.fixture
def sub_agent_def():
    """A sample SubAgentDefinition."""
    return SubAgentDefinition(
        id="sub-agent-1",
        name="Research Agent",
        description="Handles research tasks",
        system_prompt="You are a research assistant.",
        model="gpt-4o",
        temperature=0.5,
        max_tokens=2048,
        mcp_servers=[],
    )


@pytest.fixture
def sub_agent_with_mcp():
    """SubAgentDefinition with MCP servers."""
    return SubAgentDefinition(
        id="sub-agent-mcp",
        name="MCP Agent",
        description="Agent with MCP tools",
        system_prompt="You are an MCP agent.",
        mcp_servers=[
            McpServerDefinition(
                id="mcp-1",
                name="test-mcp",
                endpoint="http://localhost:9000",
                transport="sse",
                is_connected=False,
                available_tools=[
                    {"name": "tool_a", "description": "Tool A", "parameters": {}},
                ],
            ),
        ],
    )


@pytest.fixture
def runtime_context(sub_agent_def):
    """RuntimeSessionContext with one sub-agent."""
    return RuntimeSessionContext(
        user_id="user-1",
        agent_id="parent-agent",
        session_id="session-1",
        agent_config=AgentConfig(id="parent-agent", name="Parent Agent"),
        available_sub_agents=[sub_agent_def],
        metadata={"org_id": "org-1"},
    )


@pytest.fixture
def runtime_context_with_mcp(sub_agent_def, sub_agent_with_mcp):
    """RuntimeSessionContext with MCP sub-agent."""
    return RuntimeSessionContext(
        user_id="user-1",
        agent_id="parent-agent",
        session_id="session-1",
        agent_config=AgentConfig(id="parent-agent", name="Parent Agent"),
        available_sub_agents=[sub_agent_def, sub_agent_with_mcp],
        metadata={"org_id": "org-1"},
    )


@pytest.fixture
def delegator(runtime_context):
    """SubAgentDelegator with mocked dependencies."""
    return SubAgentDelegator(
        runtime_context=runtime_context,
        llm_provider=AsyncMock(),
        skill_registry=MagicMock(),
        event_emitter=AsyncMock(),
        max_depth=2,
        current_depth=0,
    )


@pytest.fixture
def capability_only_runtime_context():
    return RuntimeSessionContext(
        user_id="user-1",
        agent_id="parent-agent",
        session_id="session-1",
        agent_config=AgentConfig(id="parent-agent", name="Parent Agent"),
        available_sub_agents=[],
        capabilities=[
            CapabilityDescriptor(
                id="agent:researcher",
                kind="sub_agent",
                name="subagent:researcher",
                display_name="Research Agent",
                description="Handles research tasks",
                source={"type": "agent", "agentId": "researcher"},
                constraints={"timeoutMs": 3000},
                metadata={
                    "sub_agent_id": "researcher",
                    "system_prompt": "You are a research assistant.",
                    "model": "gpt-4o",
                    "temperature": 0.5,
                    "max_tokens": 2048,
                },
            )
        ],
        metadata={"org_id": "org-1"},
    )


# ── Depth Limit Tests ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_delegate_depth_limit_reached(runtime_context):
    """Delegation should fail when depth limit is reached."""
    delegator = SubAgentDelegator(
        runtime_context=runtime_context,
        max_depth=2,
        current_depth=2,  # Already at max
    )

    result = await delegator.delegate(
        sub_agent_id="sub-agent-1",
        task="Do something",
    )

    assert "error" in result
    assert "depth limit" in result["error"].lower()
    assert result["agent_id"] == "sub-agent-1"


@pytest.mark.asyncio
async def test_delegate_depth_limit_boundary(runtime_context):
    """Delegation should succeed at depth < max_depth."""
    delegator = SubAgentDelegator(
        runtime_context=runtime_context,
        llm_provider=AsyncMock(),
        skill_registry=MagicMock(),
        event_emitter=AsyncMock(),
        max_depth=2,
        current_depth=1,  # One below max
    )

    # Mock the graph execution
    mock_graph = AsyncMock()
    mock_graph.ainvoke = AsyncMock(return_value={
        "messages": [{"role": "assistant", "content": "Done!"}],
    })

    with patch("src.agents.delegator.create_agent_graph", return_value=mock_graph):
        result = await delegator.delegate(
            sub_agent_id="sub-agent-1",
            task="Research topic X",
        )

    assert "error" not in result
    assert result["result"] == "Done!"
    assert result["agent_id"] == "sub-agent-1"


# ── Unknown Agent Tests ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_delegate_unknown_agent(delegator):
    """Delegation to unknown agent should return error."""
    result = await delegator.delegate(
        sub_agent_id="nonexistent-agent",
        task="Do something",
    )

    assert "error" in result
    assert "not found" in result["error"].lower()
    assert result["agent_id"] == "nonexistent-agent"


# ── Normal Delegation Tests ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_delegate_success(delegator):
    """Normal delegation should execute sub-agent graph and return result."""
    mock_graph = AsyncMock()
    mock_graph.ainvoke = AsyncMock(return_value={
        "messages": [
            {"role": "user", "content": "Research topic X"},
            {"role": "assistant", "content": "Here are the findings..."},
        ],
    })

    with patch("src.agents.delegator.create_agent_graph", return_value=mock_graph):
        result = await delegator.delegate(
            sub_agent_id="sub-agent-1",
            task="Research topic X",
        )

    assert result["result"] == "Here are the findings..."
    assert result["agent_id"] == "sub-agent-1"
    assert result["agent_name"] == "Research Agent"
    assert "error" not in result


@pytest.mark.asyncio
async def test_delegate_success_with_capability_only_runtime(capability_only_runtime_context):
    delegator = SubAgentDelegator(
        runtime_context=capability_only_runtime_context,
        llm_provider=AsyncMock(),
        skill_registry=MagicMock(),
        event_emitter=AsyncMock(),
    )
    mock_graph = AsyncMock()
    mock_graph.ainvoke = AsyncMock(
        return_value={
            "messages": [{"role": "assistant", "content": "Capability-only delegation works"}],
        }
    )

    with patch("src.agents.delegator.create_agent_graph", return_value=mock_graph):
        result = await delegator.delegate(sub_agent_id="researcher", task="Research topic X")

    assert result["result"] == "Capability-only delegation works"
    assert result["agent_id"] == "researcher"
    assert result["agent_name"] == "Research Agent"


@pytest.mark.asyncio
async def test_delegate_passes_context(delegator):
    """Delegation should pass extra context to sub-agent."""
    mock_graph = AsyncMock()
    mock_graph.ainvoke = AsyncMock(return_value={
        "messages": [{"role": "assistant", "content": "OK"}],
    })

    with patch("src.agents.delegator.create_agent_graph", return_value=mock_graph):
        result = await delegator.delegate(
            sub_agent_id="sub-agent-1",
            task="Do task",
            context={"memory": "some context", "parent_session_id": "session-1"},
        )

    assert result["result"] == "OK"


@pytest.mark.asyncio
async def test_delegate_empty_messages(delegator):
    """Delegation with empty messages should return empty result."""
    mock_graph = AsyncMock()
    mock_graph.ainvoke = AsyncMock(return_value={
        "messages": [],
    })

    with patch("src.agents.delegator.create_agent_graph", return_value=mock_graph):
        result = await delegator.delegate(
            sub_agent_id="sub-agent-1",
            task="Do task",
        )

    assert result["result"] == ""
    assert "error" not in result


# ── Timeout Tests ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_delegate_timeout(delegator):
    """Delegation should handle timeout gracefully."""
    mock_graph = AsyncMock()

    async def slow_invoke(*args, **kwargs):
        await asyncio.sleep(999)

    mock_graph.ainvoke = slow_invoke

    with patch("src.agents.delegator.create_agent_graph", return_value=mock_graph):
        result = await delegator.delegate(
            sub_agent_id="sub-agent-1",
            task="Slow task",
            timeout_seconds=0.01,
        )

    assert "error" in result
    assert "timed out" in result["error"].lower()


# ── Exception Handling Tests ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_delegate_graph_exception(delegator):
    """Delegation should handle graph execution exceptions."""
    mock_graph = AsyncMock()
    mock_graph.ainvoke = AsyncMock(side_effect=RuntimeError("Graph crashed"))

    with patch("src.agents.delegator.create_agent_graph", return_value=mock_graph):
        result = await delegator.delegate(
            sub_agent_id="sub-agent-1",
            task="Crash task",
        )

    assert "error" in result
    assert "Graph crashed" in result["error"]


# ── MCP Cleanup Tests ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_delegate_mcp_cleanup_on_success(runtime_context_with_mcp):
    """MCP connections should be cleaned up after successful delegation."""
    delegator = SubAgentDelegator(
        runtime_context=runtime_context_with_mcp,
        llm_provider=AsyncMock(),
        skill_registry=MagicMock(),
        event_emitter=AsyncMock(),
    )

    mock_graph = AsyncMock()
    mock_graph.ainvoke = AsyncMock(return_value={
        "messages": [{"role": "assistant", "content": "Done"}],
    })

    mock_mcp_client = AsyncMock()
    mock_mcp_client.is_connected = MagicMock(return_value=True)
    mock_mcp_client.close_all = AsyncMock()

    with (
        patch("src.agents.delegator.create_agent_graph", return_value=mock_graph),
        patch("src.agents.delegator.setup_mcp_client", new_callable=AsyncMock, return_value=mock_mcp_client),
    ):
        result = await delegator.delegate(
            sub_agent_id="sub-agent-mcp",
            task="MCP task",
        )

    # MCP close_all should have been called in the finally block
    mock_mcp_client.close_all.assert_awaited_once()


@pytest.mark.asyncio
async def test_delegate_mcp_cleanup_on_failure(runtime_context_with_mcp):
    """MCP connections should be cleaned up even after failure."""
    delegator = SubAgentDelegator(
        runtime_context=runtime_context_with_mcp,
        llm_provider=AsyncMock(),
        skill_registry=MagicMock(),
        event_emitter=AsyncMock(),
    )

    mock_graph = AsyncMock()
    mock_graph.ainvoke = AsyncMock(side_effect=RuntimeError("Boom"))

    with patch("src.agents.delegator.create_agent_graph", return_value=mock_graph):
        result = await delegator.delegate(
            sub_agent_id="sub-agent-1",
            task="Failing task",
        )

    assert "error" in result


# ── Sub-Agent Isolation Tests ────────────────────────────────────────


@pytest.mark.asyncio
async def test_sub_agent_gets_empty_sub_agents(delegator):
    """Sub-agent should not be able to delegate further (empty sub_agents)."""
    captured_context = {}

    def capture_graph(context, runtime_context):
        captured_context["runtime_context"] = runtime_context
        mock_graph = AsyncMock()
        mock_graph.ainvoke = AsyncMock(return_value={
            "messages": [{"role": "assistant", "content": "Done"}],
        })
        return mock_graph

    with patch("src.agents.delegator.create_agent_graph", side_effect=capture_graph):
        await delegator.delegate(
            sub_agent_id="sub-agent-1",
            task="Task",
        )

    # Sub-agent's context should have empty sub_agents
    assert captured_context["runtime_context"].available_sub_agents == []


@pytest.mark.asyncio
async def test_sub_agent_uses_own_config(delegator, sub_agent_def):
    """Sub-agent should use its own system_prompt and config."""
    captured_context = {}

    def capture_graph(context, runtime_context):
        captured_context["runtime_context"] = runtime_context
        mock_graph = AsyncMock()
        mock_graph.ainvoke = AsyncMock(return_value={
            "messages": [{"role": "assistant", "content": "Done"}],
        })
        return mock_graph

    with patch("src.agents.delegator.create_agent_graph", side_effect=capture_graph):
        await delegator.delegate(
            sub_agent_id="sub-agent-1",
            task="Task",
        )

    sub_config = captured_context["runtime_context"].agent_config
    assert sub_config.id == sub_agent_def.id
    assert sub_config.name == sub_agent_def.name
    assert sub_config.system_prompt == sub_agent_def.system_prompt
    assert sub_config.model == sub_agent_def.model


# ── delegate_node Integration Tests ──────────────────────────────────


@pytest.fixture
def delegation_plan():
    """Plan that requires delegation."""
    return ExecutionPlan(
        goal="Research the topic using specialist",
        steps=[],
        plan_type="delegate",
        sub_agent_id="sub-agent-1",
    )


@pytest.fixture
def delegation_state(delegation_plan):
    """Agent state ready for delegation."""
    runtime_context = RuntimeSessionContext(
        user_id="user-1",
        agent_id="parent-agent",
        session_id="session-1",
        agent_config=AgentConfig(id="parent-agent", name="Parent Agent"),
        available_sub_agents=[
            SubAgentDefinition(
                id="sub-agent-1",
                name="Research Agent",
                description="Research tasks",
            ),
        ],
        metadata={"org_id": "org-1"},
    )

    return {
        "session_id": "session-1",
        "agent_id": "parent-agent",
        "context": runtime_context,
        "messages": [{"role": "user", "content": "Research topic X"}],
        "plan": delegation_plan,
        "pending_actions": [],
        "tool_results": [],
        "reflection": None,
        "error": None,
        "current_step": "delegate",
        "iteration": 1,
        "memory_context": "some memory",
        "memory_snapshot": {
            "memory_context": "structured memory",
            "short_term": "[user] some memory",
            "long_term_results": [{"content": "saved preference"}],
            "budget": {
                "used_chars": 10,
                "budget_chars": 12000,
                "remaining_chars": 11990,
                "remaining_ratio": 0.999,
                "remaining_percent": 100,
            },
        },
        "metadata": {},
    }


@pytest.mark.asyncio
async def test_delegate_node_success(delegation_state):
    """delegate_node should call unified executor with sub-agent capability."""
    mock_executor = AsyncMock()
    mock_executor.execute = AsyncMock(return_value=ToolCallResult(
        tool_name="subagent:sub-agent-1",
        capability_id="agent:sub-agent-1",
        params={},
        result="Research findings here",
        success=True,
    ))

    context = {
        "unified_executor": mock_executor,
    }

    result = await delegate_node(delegation_state, context)

    assert len(result["tool_results"]) == 1

    tool_result = result["tool_results"][0]
    assert tool_result.tool_name == "subagent:sub-agent-1"
    assert tool_result.success is True
    assert tool_result.result == "Research findings here"
    delegated_action = mock_executor.execute.await_args.args[0]
    assert delegated_action.capability_id == "agent:sub-agent-1"
    assert delegated_action.tool == "subagent:sub-agent-1"
    assert delegated_action.params["task"] == "Research the topic using specialist"
    assert delegated_action.params["context"] == {
        "memory": "Recent context:\n[user] some memory\n\nRelevant knowledge:\nsaved preference",
        "memory_snapshot": delegation_state["memory_snapshot"],
        "parent_session_id": "session-1",
    }


@pytest.mark.asyncio
async def test_delegate_node_no_delegator(delegation_state):
    """delegate_node should handle missing unified executor gracefully."""
    context = {}

    result = await delegate_node(delegation_state, context)

    assert len(result["tool_results"]) == 1
    assert result["tool_results"][0].success is False
    assert "delegation unavailable" in (result["tool_results"][0].error or "").lower()
    assert result["error"] == "Delegation unavailable in current runtime"


@pytest.mark.asyncio
async def test_delegate_node_no_plan(delegation_state):
    """delegate_node should handle missing plan gracefully."""
    delegation_state["plan"] = None

    context = {
        "unified_executor": AsyncMock(),
    }

    result = await delegate_node(delegation_state, context)

    assert "error" in result


@pytest.mark.asyncio
async def test_delegate_node_delegator_error(delegation_state):
    """delegate_node should handle executor returning delegated failure."""
    mock_executor = AsyncMock()
    mock_executor.execute = AsyncMock(return_value=ToolCallResult(
        tool_name="subagent:sub-agent-1",
        capability_id="agent:sub-agent-1",
        params={},
        error="SubAgent crashed",
        success=False,
    ))

    context = {
        "unified_executor": mock_executor,
    }

    result = await delegate_node(delegation_state, context)

    tool_result = result["tool_results"][0]
    assert tool_result.success is False
    assert tool_result.error == "SubAgent crashed"


@pytest.mark.asyncio
async def test_delegate_node_exception(delegation_state):
    """delegate_node should handle exceptions from unified executor."""
    mock_executor = AsyncMock()
    mock_executor.execute = AsyncMock(side_effect=RuntimeError("Connection lost"))

    context = {
        "unified_executor": mock_executor,
    }

    result = await delegate_node(delegation_state, context)

    tool_result = result["tool_results"][0]
    assert tool_result.success is False
    assert "Connection lost" in tool_result.error


@pytest.mark.asyncio
async def test_delegate_node_emits_events(delegation_state):
    """delegate node should annotate delegated execution metadata."""
    mock_executor = AsyncMock()
    mock_executor.execute = AsyncMock(return_value=ToolCallResult(
        tool_name="subagent:sub-agent-1",
        capability_id="agent:sub-agent-1",
        params={},
        result="Done",
        success=True,
        metadata={},
    ))

    context = {
        "unified_executor": mock_executor,
    }

    result = await delegate_node(delegation_state, context)
    tool_result = result["tool_results"][0]
    assert tool_result.metadata["delegate"] is True
    assert tool_result.metadata["sub_agent_id"] == "sub-agent-1"
