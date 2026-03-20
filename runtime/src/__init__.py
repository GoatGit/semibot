"""Semibot Agent Runtime - AI Agent Execution Engine."""

__version__ = "2.0.0"

__all__ = [
    "create_agent_graph",
    "AgentState",
    "RuntimeSessionContext",
    "create_initial_state",
]


def __getattr__(name: str):
    if name == "create_agent_graph":
        from src.orchestrator.graph import create_agent_graph as graph_factory

        return graph_factory
    if name == "AgentState":
        from src.orchestrator.state import AgentState as state_type

        return state_type
    if name == "RuntimeSessionContext":
        from src.orchestrator.context import RuntimeSessionContext as context_type

        return context_type
    if name == "create_initial_state":
        from src.orchestrator.state import create_initial_state as state_factory

        return state_factory
    raise AttributeError(name)
