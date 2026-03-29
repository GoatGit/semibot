from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from src.orchestrator.act_heartbeat import maybe_emit_act_heartbeat
from src.orchestrator.act_loop_guard import compute_tool_call_hash
from src.orchestrator.act_tool_error_handler import runtime_failure_from_tool_result
from src.orchestrator.nodes_act import _execute_llm_act_step
from src.orchestrator.runtime_middleware import ensure_step_runtime_state, get_step_runtime_state
from src.orchestrator.state import PlanStep, ToolCallResult


def _mock_event_emitter():
    emitter = SimpleNamespace(
        emit=AsyncMock(),
        emit_plan_step_start=AsyncMock(),
        emit_tool_call_start=AsyncMock(),
        emit_tool_call_complete=AsyncMock(),
        emit_plan_step_complete=AsyncMock(),
        emit_plan_step_failed=AsyncMock(),
        emit_file_created=AsyncMock(),
    )
    return emitter


def _act_result_json(summary: str = "完成当前步骤") -> str:
    return (
        '{"observations":[{"summary":"%s","evidence":[],"artifacts_produced":[],"constraints_encountered":[]}],'
        '"artifacts_produced":[],"artifact_result_text":"%s 结果已经完成并可继续推进。"}'
    ) % (summary, summary)


def test_loop_guard_hash_normalizes_file_io_content_noise():
    h1 = compute_tool_call_hash(
        "file_io",
        {"action": "write", "path": "reports/out.md", "content": "hello world"},
    )
    h2 = compute_tool_call_hash(
        "file_io",
        {"action": "write", "path": "reports/out.md", "content": "hello   world\n\n"},
    )
    assert h1 == h2


def test_runtime_failure_from_tool_result_classifies_timeout():
    failure = runtime_failure_from_tool_result(
        ToolCallResult(
            tool_name="web_fetch",
            params={"url": "https://example.com"},
            error="ReadTimeout: request timed out",
            success=False,
        )
    )
    assert failure is not None
    assert failure.family == "tool"
    assert failure.kind == "timeout"
    assert failure.retryable is True


@pytest.mark.asyncio
async def test_execute_llm_act_step_records_runtime_usage(mock_context, sample_agent_state, monkeypatch):
    sample_agent_state["metadata"] = {}
    sample_agent_state["iteration"] = 1
    action = PlanStep(id="step-usage", title="执行当前步骤")

    mock_context["llm_provider"].chat = AsyncMock(
        return_value=SimpleNamespace(
            content=_act_result_json("usage"),
            tool_calls=[],
            usage={"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18},
            finish_reason="stop",
        )
    )
    monkeypatch.setattr("src.orchestrator.nodes_act._build_act_tool_schemas", lambda runtime_context, skill_registry: [])
    monkeypatch.setattr(
        "src.orchestrator.nodes_act.resolve_act_execution_strategy",
        lambda **kw: SimpleNamespace(
            two_phase=False,
            tool_phase_response_format=kw.get("terminal_response_format"),
            terminal_phase_response_format=kw.get("terminal_response_format"),
        ),
    )

    results = await _execute_llm_act_step(
        state=sample_agent_state,
        context=mock_context,
        action=action,
        unified_executor=mock_context["action_executor"],
        event_emitter=None,
        prior_results=[],
    )

    assert results[-1].success is True
    step_meta = get_step_runtime_state(sample_agent_state, "step-usage", 1)
    assert step_meta["usage"]["llm_call_count"] == 1
    assert step_meta["usage"]["total_tokens"] == 18
    assert step_meta["budget"]["total_tokens"] == 18


@pytest.mark.asyncio
async def test_execute_llm_act_step_hard_stops_on_repeated_tool_loop(mock_context, sample_agent_state, monkeypatch):
    sample_agent_state["metadata"] = {}
    sample_agent_state["iteration"] = 1
    action = PlanStep(id="step-loop", title="读取报告")

    repeated_call = {
        "id": "call_1",
        "function": {
            "name": "file_io",
            "arguments": '{"action":"read","scope":"session","path":"report.md"}',
        },
    }
    mock_context["llm_provider"].chat = AsyncMock(
        side_effect=[
            SimpleNamespace(content="", tool_calls=[repeated_call], usage={}, finish_reason="stop"),
            SimpleNamespace(content="", tool_calls=[repeated_call], usage={}, finish_reason="stop"),
            SimpleNamespace(content="", tool_calls=[repeated_call], usage={}, finish_reason="stop"),
            SimpleNamespace(content="", tool_calls=[repeated_call], usage={}, finish_reason="stop"),
            SimpleNamespace(content="", tool_calls=[repeated_call], usage={}, finish_reason="stop"),
        ]
    )
    monkeypatch.setattr("src.orchestrator.nodes_act._build_act_tool_schemas", lambda runtime_context, skill_registry: [])
    monkeypatch.setattr(
        "src.orchestrator.nodes_act.resolve_act_execution_strategy",
        lambda **kw: SimpleNamespace(
            two_phase=False,
            tool_phase_response_format=kw.get("terminal_response_format"),
            terminal_phase_response_format=kw.get("terminal_response_format"),
        ),
    )
    mock_context["action_executor"].execute = AsyncMock(
        return_value=ToolCallResult(
            tool_name="file_io",
            params={"action": "read", "scope": "session", "path": "report.md"},
            result={"content": "ok"},
            success=True,
        )
    )

    results = await _execute_llm_act_step(
        state=sample_agent_state,
        context=mock_context,
        action=action,
        unified_executor=mock_context["action_executor"],
        event_emitter=None,
        prior_results=[],
    )

    assert results[-1].success is False
    assert results[-1].metadata["guard"] == "act_loop_guard"
    step_meta = get_step_runtime_state(sample_agent_state, "step-loop", 1)
    assert step_meta["loop_guard"]["last_loop_signal"]["reason"] == "repeated_tool_call"


def test_runtime_middleware_state_is_partitioned_by_iteration(sample_agent_state):
    sample_agent_state["metadata"] = {}
    first = ensure_step_runtime_state(sample_agent_state, "step-a", 1)
    first["usage"]["llm_call_count"] = 3

    second = ensure_step_runtime_state(sample_agent_state, "step-a", 2)
    second["usage"]["llm_call_count"] = 1

    first_loaded = get_step_runtime_state(sample_agent_state, "step-a", 1)
    second_loaded = get_step_runtime_state(sample_agent_state, "step-a", 2)

    assert first_loaded["iteration"] == 1
    assert second_loaded["iteration"] == 2
    assert first_loaded["usage"]["llm_call_count"] == 3
    assert second_loaded["usage"]["llm_call_count"] == 1


@pytest.mark.asyncio
async def test_backend_heartbeat_emits_once_per_interval(sample_agent_state):
    emitter = _mock_event_emitter()
    await maybe_emit_act_heartbeat(
        state=sample_agent_state,
        action_id="step-heartbeat",
        iteration=1,
        act_phase="tool",
        event_emitter=emitter,
        turn_count=1,
    )
    await maybe_emit_act_heartbeat(
        state=sample_agent_state,
        action_id="step-heartbeat",
        iteration=1,
        act_phase="tool",
        event_emitter=emitter,
        turn_count=2,
    )
    assert emitter.emit.await_count == 1


@pytest.mark.asyncio
async def test_execute_llm_act_step_emits_runtime_signal_events(mock_context, sample_agent_state, monkeypatch):
    sample_agent_state["metadata"] = {}
    sample_agent_state["iteration"] = 1
    action = PlanStep(id="step-loop-events", title="读取报告")
    repeated_call = {
        "id": "call_1",
        "function": {
            "name": "file_io",
            "arguments": '{"action":"read","scope":"session","path":"report.md"}',
        },
    }
    mock_context["llm_provider"].chat = AsyncMock(
        side_effect=[
            SimpleNamespace(content="", tool_calls=[repeated_call], usage={}, finish_reason="stop"),
            SimpleNamespace(content="", tool_calls=[repeated_call], usage={}, finish_reason="stop"),
            SimpleNamespace(content="", tool_calls=[repeated_call], usage={}, finish_reason="stop"),
            SimpleNamespace(content="", tool_calls=[repeated_call], usage={}, finish_reason="stop"),
            SimpleNamespace(content="", tool_calls=[repeated_call], usage={}, finish_reason="stop"),
        ]
    )
    monkeypatch.setattr("src.orchestrator.nodes_act._build_act_tool_schemas", lambda runtime_context, skill_registry: [])
    monkeypatch.setattr(
        "src.orchestrator.nodes_act.resolve_act_execution_strategy",
        lambda **kw: SimpleNamespace(
            two_phase=False,
            tool_phase_response_format=kw.get("terminal_response_format"),
            terminal_phase_response_format=kw.get("terminal_response_format"),
        ),
    )
    mock_context["action_executor"].execute = AsyncMock(
        return_value=ToolCallResult(
            tool_name="file_io",
            params={"action": "read", "scope": "session", "path": "report.md"},
            result={"content": "ok"},
            success=True,
        )
    )
    emitter = _mock_event_emitter()

    await _execute_llm_act_step(
        state=sample_agent_state,
        context=mock_context,
        action=action,
        unified_executor=mock_context["action_executor"],
        event_emitter=emitter,
        prior_results=[],
    )

    emitted_types = [call.args[0] for call in emitter.emit.await_args_list]
    assert "runtime.signal" in emitted_types


@pytest.mark.asyncio
async def test_execute_llm_act_step_emits_runtime_failure_events(mock_context, sample_agent_state, monkeypatch):
    sample_agent_state["metadata"] = {}
    sample_agent_state["iteration"] = 1
    action = PlanStep(id="step-failure-events", title="抓取页面")
    tool_call = {
        "id": "call_1",
        "function": {
            "name": "web_fetch",
            "arguments": '{"url":"https://example.com"}',
        },
    }
    mock_context["llm_provider"].chat = AsyncMock(
        side_effect=[
            SimpleNamespace(content="", tool_calls=[tool_call], usage={}, finish_reason="stop"),
            SimpleNamespace(content=_act_result_json("fallback"), tool_calls=[], usage={}, finish_reason="stop"),
        ]
    )
    monkeypatch.setattr("src.orchestrator.nodes_act._build_act_tool_schemas", lambda runtime_context, skill_registry: [])
    monkeypatch.setattr(
        "src.orchestrator.nodes_act.resolve_act_execution_strategy",
        lambda **kw: SimpleNamespace(
            two_phase=False,
            tool_phase_response_format=kw.get("terminal_response_format"),
            terminal_phase_response_format=kw.get("terminal_response_format"),
        ),
    )
    mock_context["action_executor"].execute = AsyncMock(
        return_value=ToolCallResult(
            tool_name="web_fetch",
            params={"url": "https://example.com"},
            error="ReadTimeout: request timed out",
            success=False,
        )
    )
    emitter = _mock_event_emitter()

    await _execute_llm_act_step(
        state=sample_agent_state,
        context=mock_context,
        action=action,
        unified_executor=mock_context["action_executor"],
        event_emitter=emitter,
        prior_results=[],
    )

    emitted_types = [call.args[0] for call in emitter.emit.await_args_list]
    assert "runtime.failure" in emitted_types
