"""Semibot Agent Runtime - AI Agent Execution Engine."""

__version__ = "0.1.0"

__all__ = [
    "create_agent_graph",
    "AgentState",
]


def __getattr__(name: str):
    if name == "create_agent_graph":
        from src.orchestrator.graph import create_agent_graph as graph_factory

        return graph_factory
    if name == "AgentState":
        from src.orchestrator.state import AgentState as state_type

        return state_type
    raise AttributeError(name)
