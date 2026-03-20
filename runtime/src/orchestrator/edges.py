"""Edge routing logic for the LangGraph state machine.

Edges define the transitions between nodes based on the current state.
These routing functions examine the state and return the name of the
next node to execute.
"""

from typing import Literal

from src.orchestrator.state import AgentState


def _can_delegate(state: AgentState) -> bool:
    """Check whether delegation is actually available in current runtime context."""
    plan = state.get("plan")
    if not plan or plan.plan_type != "delegate" or not plan.sub_agent_id:
        return False

    runtime_context = state.get("context")
    if not runtime_context:
        # Backward-compatibility: if no runtime context is attached,
        # preserve old behavior and allow delegation routing.
        return True

    policy = getattr(runtime_context, "runtime_policy", None)
    if policy is not None and getattr(policy, "enable_delegation", True) is False:
        return False

    available_sub_agents = getattr(runtime_context, "available_sub_agents", None) or []
    if not available_sub_agents:
        return False

    delegate_to = str(plan.sub_agent_id)
    return any(getattr(sub_agent, "id", None) == delegate_to for sub_agent in available_sub_agents)


def route_after_plan(
    state: AgentState,
) -> Literal["act", "delegate", "respond"]:
    """
    Route after PLAN node.

    Determines the next step based on the generated plan:
    - If plan requires delegation -> DELEGATE
    - If plan has steps to execute -> ACT
    - If no steps needed (simple question) -> RESPOND

    Args:
        state: Current agent state

    Returns:
        Name of the next node
    """
    # Check for errors
    if state.get("error"):
        return "respond"

    plan = state.get("plan")

    # No plan generated - direct response
    if not plan:
        return "respond"

    current_step = str(state.get("current_step") or "").strip().lower()

    if plan.plan_type == "delegate" and _can_delegate(state):
        return "delegate"

    if plan.plan_type == "terminate":
        return "respond"

    # PlanStep V2 is semantic-first and may not pre-bind any tool. If the
    # planner returned non-empty semantic steps, route into ACT.
    if current_step == "act":
        return "act"
    if plan.steps and any(getattr(step, "tool", None) for step in plan.steps):
        return "act"
    if plan.steps:
        return "act"

    # No steps - simple question, direct response
    return "respond"


def route_after_observe(
    state: AgentState,
) -> Literal["plan", "act", "respond", "reflect"]:
    """
    Route after OBSERVE node.

    Determines the next step based on execution results:
    - If replanning is needed -> PLAN
    - If current plan can continue directly -> ACT
    - If awaiting approval -> RESPOND
    - If all steps completed -> REFLECT (summarize)

    Args:
        state: Current agent state

    Returns:
        Name of the next node
    """
    observe_outcome = state.get("observe_outcome")
    if observe_outcome == "replan_current_round":
        return "plan"
    if observe_outcome == "continue_execution":
        return "act"
    if observe_outcome == "awaiting_approval":
        return "respond"
    if observe_outcome == "task_completed":
        return "respond"
    return "reflect"
