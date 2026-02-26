"""Bridge contracts between Event Engine and Orchestrator."""

from __future__ import annotations

from typing import Any, Protocol


class OrchestratorBridge(Protocol):
    """Minimal boundary contract from Event Engine to Orchestrator."""

    async def run_agent(self, agent_id: str, payload: dict[str, Any], trace_id: str) -> dict[str, Any]:
        """Run a target agent with payload and trace context."""

    async def execute_plan(self, plan: dict[str, Any], trace_id: str) -> dict[str, Any]:
        """Execute a plan object and return execution summary."""
