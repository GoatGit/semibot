"""Tests for orchestrator state definitions."""

import pytest
from datetime import datetime, timezone

from src.orchestrator.state import (
    ExecutionPlan,
    PlanStep,
    ReflectionResult,
    ToolCallResult,
    create_initial_state,
)


class TestPlanStep:
    """Tests for PlanStep dataclass."""

    def test_create_plan_step(self):
        """Test creating a plan step."""
        step = PlanStep(
            id="step_1",
            title="Search",
            description="Search for information",
            tool="web_search",
            params={"query": "test"},
        )

        assert step.id == "step_1"
        assert step.title == "Search"
        assert step.tool == "web_search"
        assert step.params == {"query": "test"}
        assert step.parallel is False  # Default

    def test_plan_step_parallel(self):
        """Test parallel plan step."""
        step = PlanStep(
            id="step_1",
            title="Parallel task",
            parallel=True,
        )

        assert step.parallel is True

    def test_plan_step_optional_fields(self):
        """Test plan step with optional fields."""
        step = PlanStep(id="step_1", title="Simple step")

        assert step.tool is None
        assert step.params == {}


class TestExecutionPlan:
    """Tests for ExecutionPlan dataclass."""

    def test_create_execution_plan(self, sample_plan_step):
        """Test creating an execution plan."""
        plan = ExecutionPlan(
            goal="Complete the task",
            analysis="User wants to do something",
            steps=[sample_plan_step],
        )

        assert plan.goal == "Complete the task"
        assert len(plan.steps) == 1
        assert plan.current_step_index == 0

    def test_execution_plan_empty_steps(self):
        """Test execution plan with no steps."""
        plan = ExecutionPlan(goal="Simple question", steps=[])

        assert len(plan.steps) == 0
        assert not plan.requires_delegation

    def test_execution_plan_delegation(self):
        """Test execution plan requiring delegation."""
        plan = ExecutionPlan(
            goal="Complex task",
            steps=[],
            requires_delegation=True,
            delegate_to="specialist_agent",
        )

        assert plan.requires_delegation is True
        assert plan.delegate_to == "specialist_agent"


class TestToolCallResult:
    """Tests for ToolCallResult dataclass."""

    def test_successful_result(self):
        """Test successful tool call result."""
        result = ToolCallResult(
            tool_name="calculator",
            params={"expression": "2+2"},
            success=True,
            result=42,
            duration_ms=50,
        )

        assert result.success is True
        assert result.result == 42
        assert result.error is None

    def test_failed_result(self):
        """Test failed tool call result."""
        result = ToolCallResult(
            tool_name="web_search",
            params={"query": "test"},
            success=False,
            error="Connection timeout",
            duration_ms=5000,
        )

        assert result.success is False
        assert result.error == "Connection timeout"


class TestReflectionResult:
    """Tests for ReflectionResult dataclass."""

    def test_create_reflection(self):
        """Test creating a reflection result."""
        reflection = ReflectionResult(
            summary="Task completed successfully",
            lessons_learned=["API was slow", "Caching helped"],
            worth_remembering=True,
            importance=0.8,
        )

        assert reflection.summary == "Task completed successfully"
        assert len(reflection.lessons_learned) == 2
        assert reflection.worth_remembering is True
        assert reflection.importance == 0.8


class TestCreateInitialState:
    """Tests for create_initial_state function."""

    def test_create_initial_state(self):
        """Test creating initial agent state."""
        from src.orchestrator.context import RuntimeSessionContext, AgentConfig

        runtime_context = RuntimeSessionContext(
            org_id="org_789",
            user_id="user_456",
            agent_id="agent_456",
            session_id="sess_123",
            agent_config=AgentConfig(id="agent_456", name="Test Agent"),
        )

        state = create_initial_state(
            session_id="sess_123",
            agent_id="agent_456",
            org_id="org_789",
            user_message="Hello, please help me.",
            context=runtime_context,
        )

        assert state["session_id"] == "sess_123"
        assert state["agent_id"] == "agent_456"
        assert state["org_id"] == "org_789"
        assert len(state["messages"]) == 1
        assert state["messages"][0]["role"] == "user"
        assert state["messages"][0]["content"] == "Hello, please help me."
        assert state["plan"] is None
        assert state["tool_results"] == []
        assert state["current_step"] == "start"
        assert state["iteration"] == 0

    def test_create_initial_state_with_history(self):
        """Test creating initial state with message history."""
        from src.orchestrator.context import RuntimeSessionContext, AgentConfig

        runtime_context = RuntimeSessionContext(
            org_id="org_789",
            user_id="user_456",
            agent_id="agent_456",
            session_id="sess_123",
            agent_config=AgentConfig(id="agent_456", name="Test Agent"),
        )

        history_messages = [
            {"role": "user", "content": "第一轮问题"},
            {"role": "assistant", "content": "第一轮回答"},
            {"role": "user", "content": "第二轮问题"},
        ]

        state = create_initial_state(
            session_id="sess_123",
            agent_id="agent_456",
            org_id="org_789",
            user_message="Second message",
            context=runtime_context,
            history_messages=history_messages,
        )

        assert len(state["messages"]) == 3
        assert state["messages"][0]["content"] == "第一轮问题"
        assert state["messages"][1]["role"] == "assistant"
        assert state["messages"][2]["content"] == "第二轮问题"

    def test_create_initial_state_with_metadata(self):
        """Test creating initial state with metadata."""
        from src.orchestrator.context import RuntimeSessionContext, AgentConfig

        runtime_context = RuntimeSessionContext(
            org_id="org_789",
            user_id="user_456",
            agent_id="agent_456",
            session_id="sess_123",
            agent_config=AgentConfig(id="agent_456", name="Test Agent"),
        )

        metadata = {"user_id": "user_123", "request_id": "req_456"}

        state = create_initial_state(
            session_id="sess_123",
            agent_id="agent_456",
            org_id="org_789",
            user_message="Hello",
            context=runtime_context,
            metadata=metadata,
        )

        assert state["metadata"]["user_id"] == "user_123"
        assert state["metadata"]["request_id"] == "req_456"
        assert state["metadata"]["request_id"] == "req_456"
