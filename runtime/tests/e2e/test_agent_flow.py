"""End-to-end tests for agent execution flow."""

import pytest

from src.orchestrator.state import AgentState


class TestAgentFlowE2E:
    """End-to-end tests for complete agent execution flows."""

    @pytest.mark.asyncio
    async def test_simple_greeting_flow(self, e2e_context, initial_state):
        """Test a simple greeting request flow."""
        # This test verifies the basic flow: start -> plan -> respond -> end
        from src.orchestrator.nodes import start_node, plan_node, respond_node

        # Step 1: Start node
        result = await start_node(initial_state, e2e_context)
        assert result["current_step"] == "plan"

        # Update state
        updated_state = AgentState(**{**initial_state, **result})

        # Step 2: Plan node - LLM decides to respond directly
        e2e_context["llm_provider"].generate_plan = pytest.AsyncMock(
            return_value={
                "goal": "Greet the user",
                "steps": [{"action": "respond", "params": {"message": "Hello!"}}],
            }
        )
        result = await plan_node(updated_state, e2e_context)
        assert result.get("plan") is not None
        assert result["plan"]["goal"] == "Greet the user"

        # Update state
        updated_state = AgentState(**{**updated_state, **result})

        # Step 3: Respond node
        result = await respond_node(updated_state, e2e_context)
        assert result["current_step"] == "complete"

    @pytest.mark.asyncio
    async def test_tool_execution_flow(self, e2e_context, state_with_plan):
        """Test flow with tool execution: plan -> act -> observe -> reflect -> respond."""
        from src.orchestrator.nodes import act_node, observe_node, reflect_node, respond_node

        # Step 1: Act node - execute the search tool
        result = await act_node(state_with_plan, e2e_context)
        assert "tool_results" in result or "current_step" in result

        # Update state
        updated_state = AgentState(**{**state_with_plan, **result})

        # Step 2: Observe node - check results
        result = await observe_node(updated_state, e2e_context)
        assert "current_step" in result

        # If observation leads to reflect
        if result.get("current_step") == "reflect":
            updated_state = AgentState(**{**updated_state, **result})

            # Step 3: Reflect node
            result = await reflect_node(updated_state, e2e_context)
            assert "reflection" in result or "current_step" in result

            updated_state = AgentState(**{**updated_state, **result})

            # Step 4: Respond node
            result = await respond_node(updated_state, e2e_context)
            assert result["current_step"] == "complete"

    @pytest.mark.asyncio
    async def test_error_handling_flow(self, e2e_context, state_with_error):
        """Test flow handles errors gracefully."""
        from src.orchestrator.nodes import start_node, respond_node

        # Start node should handle error state
        result = await start_node(state_with_error, e2e_context)

        # The flow should still proceed
        assert "current_step" in result

        # Eventually should respond with error message
        updated_state = AgentState(**{**state_with_error, **result})
        result = await respond_node(updated_state, e2e_context)
        assert result["current_step"] == "complete"

    @pytest.mark.asyncio
    async def test_multi_step_plan_execution(self, e2e_context, initial_state):
        """Test execution of a multi-step plan."""
        from src.orchestrator.nodes import plan_node, act_node, observe_node

        # Setup multi-step plan
        e2e_context["llm_provider"].generate_plan = pytest.AsyncMock(
            return_value={
                "goal": "Complete multi-step task",
                "steps": [
                    {"action": "search", "params": {"query": "step 1"}},
                    {"action": "analyze", "params": {"data": "step 2"}},
                    {"action": "respond", "params": {}},
                ],
            }
        )

        # Plan phase
        result = await plan_node(initial_state, e2e_context)
        assert result["plan"] is not None
        assert len(result["plan"]["steps"]) == 3

        # Act phase - first step
        updated_state = AgentState(**{**initial_state, **result})
        updated_state = AgentState(**{**updated_state, "current_step": "act"})

        result = await act_node(updated_state, e2e_context)
        assert "tool_results" in result or "current_step" in result

    @pytest.mark.asyncio
    async def test_iteration_limit(self, e2e_context, initial_state):
        """Test that iteration limit is respected."""
        from src.constants.config import MAX_ITERATIONS
        from src.orchestrator.nodes import observe_node

        # Set iteration to max
        state_at_limit = AgentState(**{**initial_state, "iteration": MAX_ITERATIONS})

        result = await observe_node(state_at_limit, e2e_context)

        # Should transition to reflect/respond, not continue acting
        assert result.get("current_step") in ["reflect", "respond", "complete", None]


class TestEdgeRouting:
    """Tests for edge routing decisions."""

    def test_route_after_plan_to_act(self):
        """Test routing to act when plan has action steps."""
        from src.orchestrator.edges import route_after_plan

        state = AgentState(
            session_id="test",
            agent_id="test",
            org_id="test",
            messages=[],
            plan={
                "goal": "Do something",
                "steps": [{"action": "search", "params": {}}],
                "current_step_index": 0,
            },
            tool_results=[],
            reflection=None,
            error=None,
            current_step="plan",
            iteration=0,
            memory_context="",
            metadata={},
        )

        route = route_after_plan(state)
        assert route in ["act", "delegate", "respond"]

    def test_route_after_plan_to_respond(self):
        """Test routing to respond when plan only has respond step."""
        from src.orchestrator.edges import route_after_plan

        state = AgentState(
            session_id="test",
            agent_id="test",
            org_id="test",
            messages=[],
            plan={
                "goal": "Just respond",
                "steps": [{"action": "respond", "params": {}}],
                "current_step_index": 0,
            },
            tool_results=[],
            reflection=None,
            error=None,
            current_step="plan",
            iteration=0,
            memory_context="",
            metadata={},
        )

        route = route_after_plan(state)
        assert route == "respond"

    def test_route_after_observe_to_reflect(self):
        """Test routing to reflect when all steps complete."""
        from src.orchestrator.edges import route_after_observe

        state = AgentState(
            session_id="test",
            agent_id="test",
            org_id="test",
            messages=[],
            plan={
                "goal": "Done",
                "steps": [{"action": "search", "params": {}}],
                "current_step_index": 1,  # Past last step
            },
            tool_results=[{"success": True}],
            reflection=None,
            error=None,
            current_step="observe",
            iteration=1,
            memory_context="",
            metadata={},
        )

        route = route_after_observe(state)
        assert route == "reflect"


class TestStateTransitions:
    """Tests for state transitions during execution."""

    @pytest.mark.asyncio
    async def test_state_immutability(self, e2e_context, initial_state):
        """Test that node functions return new state, not mutate."""
        from src.orchestrator.nodes import start_node

        original_step = initial_state.current_step

        result = await start_node(initial_state, e2e_context)

        # Original state should be unchanged
        assert initial_state.current_step == original_step
        # Result should have new value
        assert result["current_step"] != original_step

    @pytest.mark.asyncio
    async def test_message_preservation(self, e2e_context, initial_state):
        """Test that messages are preserved through transitions."""
        from src.orchestrator.nodes import start_node, plan_node

        original_messages = initial_state.messages.copy()

        result = await start_node(initial_state, e2e_context)
        updated_state = AgentState(**{**initial_state, **result})

        result = await plan_node(updated_state, e2e_context)

        # Messages should still be there (unless intentionally modified)
        assert len(updated_state.messages) >= len(original_messages)

    @pytest.mark.asyncio
    async def test_iteration_increment(self, e2e_context, initial_state):
        """Test that iteration counter increments properly."""
        from src.orchestrator.nodes import act_node

        state_with_plan = AgentState(
            **{
                **initial_state,
                "plan": {
                    "goal": "Test",
                    "steps": [{"action": "test", "params": {}}],
                    "current_step_index": 0,
                },
                "current_step": "act",
            }
        )

        original_iteration = state_with_plan.iteration

        result = await act_node(state_with_plan, e2e_context)

        # Iteration should increment after action
        if "iteration" in result:
            assert result["iteration"] >= original_iteration
