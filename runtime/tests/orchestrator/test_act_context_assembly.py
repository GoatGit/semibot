from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from src.orchestrator.act_context_assembly import assemble_act_turn_messages
from src.orchestrator.runtime_middleware import ensure_step_runtime_state
from src.orchestrator.state import PlanStep, StepInputRef, ToolCallResult


@pytest.mark.asyncio
async def test_assemble_act_turn_messages_keeps_cross_iteration_dependency(monkeypatch, sample_agent_state):
    sample_agent_state["tool_results"] = [
        ToolCallResult(
            tool_name="search",
            params={"query": "prior"},
            result={"content": "prior"},
            success=True,
            metadata={"iteration": 1, "act_step_id": "prior-step", "act_result_type": "execution_result"},
        ),
        ToolCallResult(
            tool_name="search",
            params={"query": "current"},
            result={"content": "current"},
            success=True,
            metadata={"iteration": 2, "act_step_id": "current-step", "act_result_type": "execution_result"},
        ),
    ]
    sample_agent_state["metadata"] = {}
    ensure_step_runtime_state(sample_agent_state, "current-step", 2)

    action = PlanStep(
        id="current-step",
        title="Current step",
        input_refs=[StepInputRef(name="prior", source_step_id="prior-step")],
    )

    captured_rows: dict[str, list[str]] = {}

    def _capture_artifact_context(rows, runtime_context):
        captured_rows["step_ids"] = [
            str((row.metadata or {}).get("act_step_id") or "")
            for row in rows
            if isinstance(getattr(row, "metadata", None), dict)
        ]
        return []

    monkeypatch.setattr(
        "src.orchestrator.act_context_assembly._build_act_artifact_context",
        _capture_artifact_context,
    )
    monkeypatch.setattr(
        "src.orchestrator.act_context_assembly.build_per_turn_user_message",
        lambda **kwargs: "user prompt",
    )
    memory_system = AsyncMock()
    memory_system.format_short_term_budget_prompt = AsyncMock(return_value="")

    await assemble_act_turn_messages(
        state=sample_agent_state,
        action=action,
        runtime_context=sample_agent_state["context"],
        memory_system=memory_system,
        step_system_messages=[],
        step_transcript=[],
        step_results=[],
        prior_results=None,
        act_phase="tool",
        terminal_retry_count=0,
        current_iteration=2,
        latest_user_text="hello",
    )

    assert "prior-step" in captured_rows["step_ids"]
    assert "current-step" not in captured_rows["step_ids"]
