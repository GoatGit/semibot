"""Tests for orchestrator edge routing logic."""

import pytest

from src.orchestrator.edges import (
    route_after_observe,
    route_after_observe_dr,
    route_after_plan,
    route_after_route,
)
from src.orchestrator.context import SubAgentDefinition
from src.orchestrator.state import ExecutionPlan, PlanStep


class TestRouteAfterPlan:
    """Tests for route_after_plan function."""

    def test_route_to_respond_on_error(self, sample_agent_state):
        """Test routing to respond when there's an error."""
        state = {**sample_agent_state, "error": "Something went wrong"}

        result = route_after_plan(state)

        assert result == "respond"

    def test_route_to_respond_when_no_plan(self, sample_agent_state):
        """Test routing to respond when no plan generated."""
        state = {**sample_agent_state, "plan": None}

        result = route_after_plan(state)

        assert result == "respond"

    def test_route_to_delegate_when_required(self, sample_agent_state):
        """Test routing to delegate when delegation required."""
        plan = ExecutionPlan(
            goal="Complex task",
            steps=[],
            plan_type="delegate",
            sub_agent_id="specialist",
        )
        runtime_context = sample_agent_state["context"]
        runtime_context.available_sub_agents = [
            SubAgentDefinition(
                id="specialist",
                name="Specialist Agent",
                description="Handles specialist tasks",
            )
        ]
        state = {**sample_agent_state, "plan": plan, "context": runtime_context}

        result = route_after_plan(state)

        assert result == "delegate"

    def test_route_to_act_when_steps_exist(self, sample_agent_state):
        """Test routing to act when plan has steps."""
        step = PlanStep(id="step_1", title="Do something", tool="test_tool")
        plan = ExecutionPlan(goal="Test", steps=[step])
        state = {**sample_agent_state, "plan": plan}

        result = route_after_plan(state)

        assert result == "act"

    def test_route_to_respond_when_plan_terminates(self, sample_agent_state):
        plan = ExecutionPlan(
            goal="Done",
            steps=[],
            plan_type="terminate",
            terminate_reason="Already complete",
            terminate_status="completed",
            summary_for_act="已完成。",
        )
        state = {**sample_agent_state, "plan": plan}

        result = route_after_plan(state)

        assert result == "respond"

    def test_route_to_respond_when_no_steps(self, sample_agent_state):
        """Test routing to respond for simple question (no steps)."""
        plan = ExecutionPlan(goal="Answer question", steps=[])
        state = {**sample_agent_state, "plan": plan}

        result = route_after_plan(state)

        assert result == "respond"


class TestRouteAfterRoute:
    """Tests for route_after_route function."""

    def test_route_to_respond_for_direct_answer(self, sample_agent_state):
        state = {**sample_agent_state, "execution_mode": "direct_answer"}

        result = route_after_route(state)

        assert result == "respond"

    def test_route_to_dr_for_direct_reasoning(self, sample_agent_state):
        state = {**sample_agent_state, "execution_mode": "direct_reasoning"}

        result = route_after_route(state)

        assert result == "dr"

    def test_route_to_delegate(self, sample_agent_state):
        state = {**sample_agent_state, "execution_mode": "delegate"}

        result = route_after_route(state)

        assert result == "delegate"

    def test_route_defaults_to_plan(self, sample_agent_state):
        state = {**sample_agent_state, "execution_mode": "plan_act"}

        result = route_after_route(state)

        assert result == "plan"


class TestRouteAfterObserve:
    """Tests for route_after_observe function."""

    def test_route_to_plan(self, sample_agent_state):
        """Test routing to plan for replanning."""
        state = {**sample_agent_state, "observe_outcome": "replan_current_round"}

        result = route_after_observe(state)

        assert result == "plan"

    def test_route_to_act_for_continue_execution(self, sample_agent_state):
        """Test routing to act for continued execution within the same plan."""
        state = {**sample_agent_state, "observe_outcome": "continue_execution"}

        result = route_after_observe(state)

        assert result == "act"

    def test_route_to_reflect(self, sample_agent_state):
        """Test routing to respond when done."""
        state = {**sample_agent_state, "observe_outcome": "task_completed"}

        result = route_after_observe(state)

        assert result == "respond"

    def test_route_to_respond_when_awaiting_approval(self, sample_agent_state):
        state = {**sample_agent_state, "observe_outcome": "awaiting_approval"}

        result = route_after_observe(state)

        assert result == "respond"

    def test_route_default_to_reflect(self, sample_agent_state):
        """Test default routing to reflect."""
        state = {**sample_agent_state, "current_step": "unknown"}

        result = route_after_observe(state)

        assert result == "reflect"


class TestRouteAfterObserveDr:
    """Tests for DR observe routing."""

    def test_upgrade_routes_to_plan(self, sample_agent_state):
        state = {
            **sample_agent_state,
            "observe_dr_outcome": {
                "outcome": "upgrade_to_plan_act",
                "reason": "task became multi-stage",
            },
        }

        result = route_after_observe_dr(state)

        assert result == "plan"

    def test_success_routes_to_respond(self, sample_agent_state):
        state = {
            **sample_agent_state,
            "observe_dr_outcome": {
                "outcome": "respond_success",
                "reason": "direct reasoning completed",
            },
        }

        result = route_after_observe_dr(state)

        assert result == "respond"
