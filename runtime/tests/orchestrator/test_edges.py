"""Tests for orchestrator edge routing logic."""

import pytest

from src.orchestrator.edges import (
    route_after_observe,
    route_after_plan,
    route_from_act,
    route_from_delegate,
    route_from_reflect,
    route_from_start,
    should_continue,
)
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
            requires_delegation=True,
            delegate_to="specialist",
        )
        state = {**sample_agent_state, "plan": plan}

        result = route_after_plan(state)

        assert result == "delegate"

    def test_route_to_act_when_steps_exist(self, sample_agent_state):
        """Test routing to act when plan has steps."""
        step = PlanStep(id="step_1", title="Do something", tool="test_tool")
        plan = ExecutionPlan(goal="Test", steps=[step])
        state = {**sample_agent_state, "plan": plan}

        result = route_after_plan(state)

        assert result == "act"

    def test_route_to_respond_when_no_steps(self, sample_agent_state):
        """Test routing to respond for simple question (no steps)."""
        plan = ExecutionPlan(goal="Answer question", steps=[])
        state = {**sample_agent_state, "plan": plan}

        result = route_after_plan(state)

        assert result == "respond"


class TestRouteAfterObserve:
    """Tests for route_after_observe function."""

    def test_route_to_plan(self, sample_agent_state):
        """Test routing to plan for replanning."""
        state = {**sample_agent_state, "current_step": "plan"}

        result = route_after_observe(state)

        assert result == "plan"

    def test_route_to_act(self, sample_agent_state):
        """Test routing to act for more steps."""
        state = {**sample_agent_state, "current_step": "act"}

        result = route_after_observe(state)

        assert result == "act"

    def test_route_to_reflect(self, sample_agent_state):
        """Test routing to reflect when done."""
        state = {**sample_agent_state, "current_step": "reflect"}

        result = route_after_observe(state)

        assert result == "reflect"

    def test_route_default_to_reflect(self, sample_agent_state):
        """Test default routing to reflect."""
        state = {**sample_agent_state, "current_step": "unknown"}

        result = route_after_observe(state)

        assert result == "reflect"


class TestShouldContinue:
    """Tests for should_continue function."""

    def test_stop_on_error(self, sample_agent_state):
        """Test stopping on error."""
        state = {**sample_agent_state, "error": "Error occurred"}

        result = should_continue(state)

        assert result is False

    def test_stop_on_iteration_limit(self, sample_agent_state):
        """Test stopping on iteration limit."""
        state = {
            **sample_agent_state,
            "iteration": 10,
            "metadata": {"max_iterations": 10},
        }

        result = should_continue(state)

        assert result is False

    def test_stop_on_respond_step(self, sample_agent_state):
        """Test stopping when reached respond step."""
        state = {**sample_agent_state, "current_step": "respond"}

        result = should_continue(state)

        assert result is False

    def test_continue_normally(self, sample_agent_state):
        """Test continuing under normal conditions."""
        state = {
            **sample_agent_state,
            "error": None,
            "iteration": 2,
            "current_step": "act",
            "metadata": {"max_iterations": 10},
        }

        result = should_continue(state)

        assert result is True


class TestFixedRoutes:
    """Tests for fixed routing functions."""

    def test_route_from_start(self, sample_agent_state):
        """Test route from start always goes to plan."""
        result = route_from_start(sample_agent_state)
        assert result == "plan"

    def test_route_from_act(self, sample_agent_state):
        """Test route from act always goes to observe."""
        result = route_from_act(sample_agent_state)
        assert result == "observe"

    def test_route_from_delegate(self, sample_agent_state):
        """Test route from delegate always goes to observe."""
        result = route_from_delegate(sample_agent_state)
        assert result == "observe"

    def test_route_from_reflect(self, sample_agent_state):
        """Test route from reflect always goes to respond."""
        result = route_from_reflect(sample_agent_state)
        assert result == "respond"
