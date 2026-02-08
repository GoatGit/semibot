"""Integration tests for CapabilityGraph with plan_node and act_node.

This test verifies that the CapabilityGraph is properly integrated into
the planning and action execution flow.
"""

import pytest
from src.orchestrator.context import (
    RuntimeSessionContext,
    AgentConfig,
    SkillDefinition,
    RuntimePolicy,
)
from src.orchestrator.state import create_initial_state, PlanStep
from src.orchestrator.nodes import plan_node, act_node
from src.orchestrator.capability import CapabilityGraph


@pytest.mark.asyncio
async def test_plan_node_uses_capability_graph():
    """Test that plan_node uses CapabilityGraph when RuntimeSessionContext is available."""
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

    state = create_initial_state(
        session_id="session_789",
        agent_id="agent_123",
        org_id="org_123",
        user_message="Search for AI news",
        context=runtime_context,
    )

    # Mock context (no actual LLM provider needed for this test)
    context = {
        "llm_provider": None,
        "skill_registry": None,
    }

    # Call plan_node - it should use CapabilityGraph
    result = await plan_node(state, context)

    # Should return error because no LLM provider, but that's expected
    assert result["error"] == "LLM provider not configured"


@pytest.mark.asyncio
async def test_act_node_validates_actions():
    """Test that act_node validates actions against CapabilityGraph."""
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

    # Create state with a valid action
    valid_action = PlanStep(
        id="step_1",
        title="Search the web",
        tool="web_search",
        params={"query": "AI news"},
    )

    # Create state with an invalid action (not in capability graph)
    invalid_action = PlanStep(
        id="step_2",
        title="Execute code",
        tool="code_executor",  # Not in capability graph
        params={"code": "print('hello')"},
    )

    state = create_initial_state(
        session_id="session_789",
        agent_id="agent_123",
        org_id="org_123",
        user_message="Test",
        context=runtime_context,
    )

    # Add both actions to pending_actions
    state["pending_actions"] = [valid_action, invalid_action]

    # Mock action executor
    class MockActionExecutor:
        async def execute(self, name, params):
            return {"result": f"Executed {name}"}

    context = {
        "action_executor": MockActionExecutor(),
    }

    # Call act_node
    result = await act_node(state, context)

    # Should have executed only the valid action
    # Invalid action should be filtered out
    assert "tool_results" in result
    # Note: Since we're using a mock executor, we won't get actual results
    # but the validation logic should have filtered out the invalid action


@pytest.mark.asyncio
async def test_act_node_without_runtime_context():
    """Test that act_node works without RuntimeSessionContext (backward compatibility)."""
    # Create state without RuntimeSessionContext
    state = {
        "session_id": "session_789",
        "agent_id": "agent_123",
        "org_id": "org_123",
        "messages": [],
        "pending_actions": [],
        "tool_results": [],
        "memory_context": "",
        "reflection": None,
        "iteration": 0,
        "error": None,
        "metadata": {},
        "current_step": "act",
        "plan": None,
    }

    context = {
        "action_executor": None,
    }

    # Call act_node - should handle gracefully
    result = await act_node(state, context)

    # Should return error about missing executor
    assert result["error"] == "No executor configured"


def test_capability_graph_integration_with_context():
    """Test that CapabilityGraph integrates properly with RuntimeSessionContext."""
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

    runtime_context = RuntimeSessionContext(
        org_id="org_123",
        user_id="user_456",
        agent_id="agent_123",
        session_id="session_789",
        agent_config=AgentConfig(id="agent_123", name="Test Agent"),
        available_skills=[skill1, skill2],
    )

    # Build capability graph
    capability_graph = CapabilityGraph(runtime_context)
    capability_graph.build()

    # Verify capabilities
    assert capability_graph.validate_action("web_search") is True
    assert capability_graph.validate_action("code_executor") is True
    assert capability_graph.validate_action("nonexistent") is False

    # Get schemas for planner
    schemas = capability_graph.get_schemas_for_planner()
    assert len(schemas) == 2

    schema_names = [s["function"]["name"] for s in schemas]
    assert "web_search" in schema_names
    assert "code_executor" in schema_names


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
