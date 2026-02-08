"""Orchestrator module - LangGraph state machine orchestration."""

__all__ = [
    "create_agent_graph",
    "AgentState",
    "RuntimeSessionContext",
    "create_initial_state",
    "ActionExecutor",
    "execute_single",
    "execute_parallel",
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
    if name in {"ActionExecutor", "execute_single", "execute_parallel"}:
        from src.orchestrator.executor import (
            ActionExecutor,
            execute_parallel,
            execute_single,
        )

        mapping = {
            "ActionExecutor": ActionExecutor,
            "execute_single": execute_single,
            "execute_parallel": execute_parallel,
        }
        return mapping[name]
    raise AttributeError(name)
