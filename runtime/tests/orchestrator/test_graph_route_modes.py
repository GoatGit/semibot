"""Integration smoke tests for new route-driven runtime modes."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from src.orchestrator.context import AgentConfig, RuntimeSessionContext
from src.orchestrator.graph import create_agent_graph
from src.orchestrator.state import create_initial_state


def _runtime_context() -> RuntimeSessionContext:
    return RuntimeSessionContext(
        user_id="test_user",
        agent_id="test_agent",
        session_id="test_session",
        agent_config=AgentConfig(id="test_agent", name="Test Agent"),
        metadata={"org_id": "test_org"},
    )


@pytest.mark.asyncio
async def test_graph_runs_direct_answer_mode_end_to_end():
    llm_provider = SimpleNamespace(
        generate_response=AsyncMock(return_value="你好，我是 Semibot。"),
    )
    graph = create_agent_graph({"llm_provider": llm_provider}, _runtime_context())
    state = create_initial_state(
        session_id="test_session",
        agent_id="test_agent",
        user_message="你好",
        context=_runtime_context(),
    )

    result = await graph.ainvoke(state)

    assert result["messages"][-1]["role"] == "assistant"
    assert result["messages"][-1]["content"] == "你好，我是 Semibot。"
    assert result["execution_mode"] == "direct_answer"


@pytest.mark.asyncio
async def test_graph_runs_direct_reasoning_mode_end_to_end():
    llm_provider = SimpleNamespace(
        chat=AsyncMock(
            return_value=SimpleNamespace(
                content='{"status":"completed","answer":"这是文档总结结果","diagnostics":{"budget_exceeded":false}}',
                usage={"total_tokens": 128},
            )
        ),
        generate_response=AsyncMock(return_value="should not be used"),
    )
    graph = create_agent_graph({"llm_provider": llm_provider}, _runtime_context())
    state = create_initial_state(
        session_id="test_session",
        agent_id="test_agent",
        user_message="[DOCUMENT_CONTEXT_BEGIN]\nsummary\n[DOCUMENT_CONTEXT_END]\n请总结这个文档",
        context=_runtime_context(),
    )

    result = await graph.ainvoke(state)

    assert result["messages"][-1]["content"] == "这是文档总结结果"
    assert result["execution_mode"] == "direct_reasoning"
    assert result["observe_dr_outcome"]["outcome"] == "respond_success"
