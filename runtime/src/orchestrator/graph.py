"""LangGraph state graph construction.

This module builds the complete Agent execution state graph using LangGraph.
The graph defines the flow of execution through various nodes (states) and
edges (transitions).
"""

from typing import Any, TYPE_CHECKING

from langgraph.graph import END, StateGraph

from src.orchestrator.edges import (
    route_after_observe_dr,
    route_after_observe_workflow,
    route_after_route,
    route_after_plan,
)
from src.orchestrator.nodes_act import act_node
from src.orchestrator.nodes_delegate import delegate_node
from src.orchestrator.nodes_dr import dr_node
from src.orchestrator.nodes_observe import observe_node
from src.orchestrator.nodes_observe_dr import observe_dr_node
from src.orchestrator.nodes_plan import plan_node
from src.orchestrator.nodes_reflect import reflect_node
from src.orchestrator.nodes_respond import respond_node
from src.orchestrator.nodes_route import route_node
from src.orchestrator.nodes_start import start_node
from src.orchestrator.state import AgentState

if TYPE_CHECKING:
    from src.orchestrator.context import RuntimeSessionContext


def create_agent_graph(
    context: dict[str, Any] | None = None,
    runtime_context: "RuntimeSessionContext | None" = None,
) -> StateGraph:
    """
    Create the Agent execution state graph.

    This builds a LangGraph StateGraph that orchestrates the Agent's
    execution flow through the following states:

    START -> ROUTE -> RESPOND
                 ├-> DR -> OBSERVE_DR -> RESPOND
                 │                  └-> PLAN
                 ├-> PLAN -> ACT/DELEGATE -> OBSERVE -> REFLECT/RESPOND
                 └-> DELEGATE -> RESPOND

    Args:
        context: Injected dependencies for nodes (llm_provider, etc.)
        runtime_context: Runtime session context with agent config and capabilities

    Returns:
        Compiled LangGraph StateGraph ready for execution

    Example:
        ```python
        from src.orchestrator import create_agent_graph
        from src.orchestrator.state import create_initial_state
        from src.orchestrator.context import RuntimeSessionContext

        # Create runtime context
        runtime_context = RuntimeSessionContext(
            user_id="user_456",
            agent_id="agent_789",
            session_id="sess_abc",
            agent_config=agent_config,
            available_skills=skills,
        )

        # Create graph with dependencies
        context = {
            "llm_provider": my_llm_provider,
            "skill_registry": my_skill_registry,
            "memory_system": my_memory_system,
        }
        graph = create_agent_graph(context, runtime_context)

        # Create initial state
        state = create_initial_state(
            session_id="sess_123",
            agent_id="agent_456",
            user_message="Help me analyze this data",
            context=runtime_context,
        )

        # Execute
        result = await graph.ainvoke(state)
        ```
    """
    context = context or {}

    # Create the state graph with AgentState as the state type
    graph = StateGraph(AgentState)

    # Create node wrappers that inject context and runtime_context
    async def _start(state: AgentState) -> dict[str, Any]:
        return await start_node(state, context)

    async def _route(state: AgentState) -> dict[str, Any]:
        return await route_node(state, context)

    async def _dr(state: AgentState) -> dict[str, Any]:
        return await dr_node(state, context)

    async def _observe_dr(state: AgentState) -> dict[str, Any]:
        return await observe_dr_node(state, context)

    async def _plan(state: AgentState) -> dict[str, Any]:
        return await plan_node(state, context)

    async def _act(state: AgentState) -> dict[str, Any]:
        return await act_node(state, context)

    async def _delegate(state: AgentState) -> dict[str, Any]:
        return await delegate_node(state, context)

    async def _observe(state: AgentState) -> dict[str, Any]:
        return await observe_node(state, context)

    async def _reflect(state: AgentState) -> dict[str, Any]:
        return await reflect_node(state, context)

    async def _respond(state: AgentState) -> dict[str, Any]:
        return await respond_node(state, context)

    # Add nodes to the graph
    graph.add_node("start", _start)
    graph.add_node("route", _route)
    graph.add_node("dr", _dr)
    graph.add_node("observe_dr", _observe_dr)
    graph.add_node("plan", _plan)
    graph.add_node("act", _act)
    graph.add_node("delegate", _delegate)
    graph.add_node("observe", _observe)
    graph.add_node("reflect", _reflect)
    graph.add_node("respond", _respond)

    # Set the entry point
    graph.set_entry_point("start")

    # Add edges
    # START always goes to ROUTE
    graph.add_edge("start", "route")

    # ROUTE selects one of the four execution modes.
    graph.add_conditional_edges(
        "route",
        route_after_route,
        {
            "respond": "respond",
            "dr": "dr",
            "plan": "plan",
            "delegate": "delegate",
        },
    )

    # Direct Reasoning is a single-shot bounded execution path.
    graph.add_edge("dr", "observe_dr")
    graph.add_conditional_edges(
        "observe_dr",
        route_after_observe_dr,
        {
            "respond": "respond",
            "plan": "plan",
        },
    )

    # PLAN conditionally routes to ACT, DELEGATE, or RESPOND
    graph.add_conditional_edges(
        "plan",
        route_after_plan,
        {
            "act": "act",
            "delegate": "delegate",
            "respond": "respond",
        },
    )

    # ACT always goes to OBSERVE
    graph.add_edge("act", "observe")

    # DELEGATE returns directly to RESPOND.
    graph.add_edge("delegate", "respond")

    # OBSERVE conditionally routes to PLAN (replan), ACT (continue current plan), RESPOND, or REFLECT.
    graph.add_conditional_edges(
        "observe",
        route_after_observe_workflow,
        {
            "plan": "plan",
            "act": "act",
            "reflect": "reflect",
            "respond": "respond",
        },
    )

    # REFLECT always goes to RESPOND
    graph.add_edge("reflect", "respond")

    # RESPOND is the terminal node
    graph.add_edge("respond", END)

    # Compile and return the graph
    return graph.compile()


def create_agent_graph_with_checkpointer(
    context: dict[str, Any] | None = None,
    runtime_context: "RuntimeSessionContext | None" = None,
    checkpointer: Any = None,
) -> StateGraph:
    """
    Create the Agent execution state graph with checkpointing support.

    This version supports state persistence and resumption, useful for:
    - Long-running tasks
    - Fault tolerance
    - Human-in-the-loop workflows

    Args:
        context: Injected dependencies for nodes
        runtime_context: Runtime session context with agent config and capabilities
        checkpointer: LangGraph checkpointer for state persistence

    Returns:
        Compiled LangGraph StateGraph with checkpointing
    """
    context = context or {}

    graph = StateGraph(AgentState)

    # Create node wrappers (same as above)
    async def _start(state: AgentState) -> dict[str, Any]:
        return await start_node(state, context)

    async def _route(state: AgentState) -> dict[str, Any]:
        return await route_node(state, context)

    async def _dr(state: AgentState) -> dict[str, Any]:
        return await dr_node(state, context)

    async def _observe_dr(state: AgentState) -> dict[str, Any]:
        return await observe_dr_node(state, context)

    async def _plan(state: AgentState) -> dict[str, Any]:
        return await plan_node(state, context)

    async def _act(state: AgentState) -> dict[str, Any]:
        return await act_node(state, context)

    async def _delegate(state: AgentState) -> dict[str, Any]:
        return await delegate_node(state, context)

    async def _observe(state: AgentState) -> dict[str, Any]:
        return await observe_node(state, context)

    async def _reflect(state: AgentState) -> dict[str, Any]:
        return await reflect_node(state, context)

    async def _respond(state: AgentState) -> dict[str, Any]:
        return await respond_node(state, context)

    # Add nodes
    graph.add_node("start", _start)
    graph.add_node("route", _route)
    graph.add_node("dr", _dr)
    graph.add_node("observe_dr", _observe_dr)
    graph.add_node("plan", _plan)
    graph.add_node("act", _act)
    graph.add_node("delegate", _delegate)
    graph.add_node("observe", _observe)
    graph.add_node("reflect", _reflect)
    graph.add_node("respond", _respond)

    # Set entry point
    graph.set_entry_point("start")

    # Add edges (same as above)
    graph.add_edge("start", "route")
    graph.add_conditional_edges(
        "route",
        route_after_route,
        {"respond": "respond", "dr": "dr", "plan": "plan", "delegate": "delegate"},
    )
    graph.add_edge("dr", "observe_dr")
    graph.add_conditional_edges(
        "observe_dr",
        route_after_observe_dr,
        {"respond": "respond", "plan": "plan"},
    )
    graph.add_conditional_edges(
        "plan",
        route_after_plan,
        {"act": "act", "delegate": "delegate", "respond": "respond"},
    )
    graph.add_edge("act", "observe")
    graph.add_edge("delegate", "respond")
    graph.add_conditional_edges(
        "observe",
        route_after_observe_workflow,
        {"plan": "plan", "act": "act", "reflect": "reflect", "respond": "respond"},
    )
    graph.add_edge("reflect", "respond")
    graph.add_edge("respond", END)

    # Compile with checkpointer
    if checkpointer:
        return graph.compile(checkpointer=checkpointer)
    return graph.compile()
