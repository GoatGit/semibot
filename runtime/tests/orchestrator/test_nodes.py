"""Tests for orchestrator nodes (plan_node, act_node, observe_node, etc.)."""

from unittest.mock import AsyncMock, MagicMock
import pytest

from src.orchestrator.nodes import plan_node, act_node, observe_node, reflect_node
from src.orchestrator.state import AgentState, ExecutionPlan, PlanStep


@pytest.fixture
def mock_context():
    """Create mock context with dependencies."""
    return {
        "llm_provider": AsyncMock(),
        "skill_registry": AsyncMock(),
        "memory": AsyncMock(),
        "capability_graph": MagicMock(),
    }


@pytest.fixture
def base_state():
    """Create base agent state."""
    return {
        "session_id": "test-session",
        "user_id": "test-user",
        "org_id": "test-org",
        "messages": [{"role": "user", "content": "test query"}],
        "plan": None,
        "pending_actions": [],
        "tool_results": [],
        "iteration": 0,
        "current_step": "plan",
        "final_response": None,
    }


@pytest.mark.asyncio
async def test_plan_node_creates_execution_plan(mock_context, base_state):
    """Test that plan_node creates a valid execution plan."""
    # Mock LLM response
    mock_context["llm_provider"].chat.return_value = MagicMock(
        content='{"goal": "test goal", "steps": [{"id": "1", "title": "step 1", "tool": "search", "params": {}}]}'
    )

    result = await plan_node(base_state, mock_context)

    assert "plan" in result
    assert result["plan"] is not None
    assert result["plan"].goal == "test goal"
    assert len(result["plan"].steps) == 1
    assert result["current_step"] == "act"


@pytest.mark.asyncio
async def test_act_node_executes_pending_actions(mock_context, base_state):
    """Test that act_node executes pending actions."""
    # Setup state with pending action
    base_state["pending_actions"] = [
        PlanStep(id="1", title="search", tool="search", params={"query": "test"})
    ]

    # Mock skill execution
    mock_result = MagicMock(success=True, result="search result")
    mock_context["skill_registry"].execute.return_value = mock_result

    result = await act_node(base_state, mock_context)

    assert result["current_step"] == "observe"
    assert mock_context["skill_registry"].execute.await_count == 1


@pytest.mark.asyncio
async def test_observe_node_with_empty_plan_steps(mock_context, base_state):
    """Test observe_node handles empty plan.steps gracefully."""
    # Create plan with empty steps
    base_state["plan"] = ExecutionPlan(
        goal="test goal",
        steps=[],
        current_step_index=0,
        requires_delegation=False,
        delegate_to=None,
    )
    base_state["tool_results"] = []

    result = await observe_node(base_state, mock_context)

    # Should move to reflect when no more steps
    assert result["current_step"] == "reflect"


@pytest.mark.asyncio
async def test_observe_node_continues_to_next_step(mock_context, base_state):
    """Test observe_node moves to next step when available."""
    # Create plan with multiple steps
    base_state["plan"] = ExecutionPlan(
        goal="test goal",
        steps=[
            PlanStep(id="1", title="step 1", tool="search", params={}),
            PlanStep(id="2", title="step 2", tool="search", params={}),
        ],
        current_step_index=0,
        requires_delegation=False,
        delegate_to=None,
    )
    base_state["tool_results"] = [{"success": True, "result": "result 1"}]

    result = await observe_node(base_state, mock_context)

    # Should move to next step
    assert result["current_step"] == "act"
    assert result["plan"].current_step_index == 1


@pytest.mark.asyncio
async def test_observe_node_replans_on_all_failures(mock_context, base_state):
    """Test observe_node triggers replan when all actions fail."""
    base_state["plan"] = ExecutionPlan(
        goal="test goal",
        steps=[PlanStep(id="1", title="step 1", tool="search", params={})],
        current_step_index=0,
        requires_delegation=False,
        delegate_to=None,
    )
    base_state["tool_results"] = [{"success": False, "error": "failed"}]
    base_state["iteration"] = 1

    result = await observe_node(base_state, mock_context)

    # Should trigger replan
    assert result["current_step"] == "plan"


@pytest.mark.asyncio
async def test_reflect_node_generates_final_response(mock_context, base_state):
    """Test reflect_node generates final response."""
    base_state["plan"] = ExecutionPlan(
        goal="test goal",
        steps=[PlanStep(id="1", title="step 1", tool="search", params={})],
        current_step_index=0,
        requires_delegation=False,
        delegate_to=None,
    )
    base_state["tool_results"] = [{"success": True, "result": "result"}]

    # Mock LLM response
    mock_context["llm_provider"].chat.return_value = MagicMock(
        content="Final answer based on results"
    )

    result = await reflect_node(base_state, mock_context)

    assert "final_response" in result
    assert result["final_response"] is not None
    assert result["current_step"] == "end"


@pytest.mark.asyncio
async def test_plan_node_handles_invalid_json(mock_context, base_state):
    """Test plan_node handles invalid JSON from LLM."""
    # Mock LLM returning invalid JSON
    mock_context["llm_provider"].chat.return_value = MagicMock(
        content="not valid json"
    )

    with pytest.raises(Exception):
        await plan_node(base_state, mock_context)


@pytest.mark.asyncio
async def test_act_node_handles_execution_failure(mock_context, base_state):
    """Test act_node handles skill execution failures."""
    base_state["pending_actions"] = [
        PlanStep(id="1", title="search", tool="search", params={"query": "test"})
    ]

    # Mock skill execution failure
    mock_result = MagicMock(success=False, error="execution failed")
    mock_context["skill_registry"].execute.return_value = mock_result

    result = await act_node(base_state, mock_context)

    # Should still move to observe to handle failure
    assert result["current_step"] == "observe"
