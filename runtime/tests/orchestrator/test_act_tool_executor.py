from __future__ import annotations

from types import SimpleNamespace

import pytest

from src.orchestrator.act_tool_executor import _build_act_tool_schemas, execute_single_act_tool_call
from src.orchestrator.state import PlanStep


class _DummyExecutor:
    def __init__(self) -> None:
        self.called = False
        self.capability_graph = None

    async def execute(self, _action):  # pragma: no cover - should not be called in guard test
        self.called = True
        raise AssertionError("executor.execute should not be called")


@pytest.mark.asyncio
async def test_execute_single_act_tool_call_rejects_tool_not_in_skill_allowlist() -> None:
    runtime_context = SimpleNamespace(
        metadata={
            "skill_index": [
                {
                    "skill_id": "deep-research",
                    "allowed_tools": ["search", "web_fetch"],
                }
            ]
        }
    )
    executor = _DummyExecutor()

    result = await execute_single_act_tool_call(
        {
            "id": "call-1",
            "function": {
                "name": "file_io",
                "arguments": '{"action":"read","path":"README.md"}',
            },
        },
        state={"session_id": "sess-1", "tool_results": []},
        action=PlanStep(id="step-1", title="Read docs"),
        current_skill_id="deep-research",
        runtime_context=runtime_context,
        prior_results=[],
        pipeline=None,
        step_results=[],
        latest_user_text="read the file",
        unified_executor=executor,
        event_emitter=None,
        current_step_snapshot=[],
    )

    assert result.success is False
    assert "not allowed by selected skill" in str(result.error or "")
    assert result.metadata["guard"] == "skill_allowed_tools"
    assert executor.called is False


def test_build_act_tool_schemas_filters_to_skill_allowlist() -> None:
    runtime_context = SimpleNamespace(
        metadata={
            "skill_index": [
                {
                    "skill_id": "deep-research",
                    "allowed_tools": ["search"],
                }
            ]
        }
    )
    registry = SimpleNamespace(
        get_tool_schemas=lambda: [
            {"type": "function", "function": {"name": "search"}},
            {"type": "function", "function": {"name": "file_io"}},
        ]
    )

    schemas = _build_act_tool_schemas(runtime_context, registry, current_skill_id="deep-research")

    assert [item["function"]["name"] for item in schemas] == ["search"]
