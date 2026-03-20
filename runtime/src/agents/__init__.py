"""Agents module - Agent implementations."""

__all__ = [
    "BaseAgent",
]


def __getattr__(name: str):
    if name == "BaseAgent":
        from src.agents.base import BaseAgent as base_agent_type

        return base_agent_type
    raise AttributeError(name)
