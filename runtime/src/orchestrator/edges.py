"""Edge routing logic for the LangGraph state machine.

Edges define the transitions between nodes based on the current state.
These routing functions examine the state and return the name of the
next node to execute.
"""

from typing import Literal

from src.orchestrator.state import AgentState


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

    # Check if delegation is required
    if plan.requires_delegation and plan.delegate_to:
        return "delegate"

    # Check if there are steps to execute
    if plan.steps:
        return "act"

    # No steps - simple question, direct response
    return "respond"


def route_after_observe(
    state: AgentState,
) -> Literal["plan", "act", "reflect"]:
    """
    Route after OBSERVE node.

    Determines the next step based on execution results:
    - If errors occurred and retries available -> PLAN (replan)
    - If more steps to execute -> ACT (continue)
    - If all steps completed -> REFLECT (summarize)

    Args:
        state: Current agent state

    Returns:
        Name of the next node
    """
    # Check current step indicator set by observe_node
    current_step = state.get("current_step", "reflect")

    # Map current_step to valid transitions
    if current_step == "plan":
        return "plan"
    elif current_step == "act":
        return "act"
    else:
        return "reflect"


def should_continue(state: AgentState) -> bool:
    """
    Check if execution should continue.

    Used as a guard condition to prevent infinite loops.

    Args:
        state: Current agent state

    Returns:
        True if execution should continue
    """
    # Check for terminal error
    if state.get("error"):
        return False

    # Check iteration limit
    max_iterations = state.get("metadata", {}).get("max_iterations", 10)
    if state.get("iteration", 0) >= max_iterations:
        return False

    # Check if we've reached respond step
    if state.get("current_step") == "respond":
        return False

    return True


def route_from_start(state: AgentState) -> Literal["plan"]:
    """
    Route from START node.

    Always proceeds to PLAN.

    Args:
        state: Current agent state

    Returns:
        Always "plan"
    """
    return "plan"


def route_from_act(state: AgentState) -> Literal["observe"]:
    """
    Route from ACT node.

    Always proceeds to OBSERVE.

    Args:
        state: Current agent state

    Returns:
        Always "observe"
    """
    return "observe"


def route_from_delegate(state: AgentState) -> Literal["observe"]:
    """
    Route from DELEGATE node.

    Always proceeds to OBSERVE.

    Args:
        state: Current agent state

    Returns:
        Always "observe"
    """
    return "observe"


def route_from_reflect(state: AgentState) -> Literal["respond"]:
    """
    Route from REFLECT node.

    Always proceeds to RESPOND.

    Args:
        state: Current agent state

    Returns:
        Always "respond"
    """
    return "respond"
