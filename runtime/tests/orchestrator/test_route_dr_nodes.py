"""Tests for Route, Direct Reasoning, and Observe DR nodes."""

import json

from src.events.runtime_emitter import emit_runtime_event
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from src.orchestrator import nodes_route as route_mod
from src.orchestrator.nodes_dr import _dr_tool_phase_prompt, dr_node
from src.orchestrator.nodes_observe_dr import observe_dr_node
from src.orchestrator.nodes_route import route_node
from src.orchestrator.state import ToolCallResult
from src.ws.event_emitter import EventEmitter


@pytest.mark.asyncio
async def test_route_node_selects_direct_answer_for_greeting(sample_agent_state):
    state = {
        **sample_agent_state,
        "messages": [{"role": "user", "content": "你好", "name": None, "tool_call_id": None}],
    }

    result = await route_node(state, {"runtime_event_emitter": None})

    assert result["execution_mode"] == "direct_answer"
    assert result["routing_decision"]["mode"] == "direct_answer"


@pytest.mark.asyncio
async def test_emit_runtime_event_supports_queue_style_event_emitter():
    emitter = EventEmitter()

    await emit_runtime_event(
        emitter,
        event_type="route.mode_selected",
        source="runtime.route_node",
        subject="sess_1",
        payload={"session_id": "sess_1", "mode": "direct_reasoning"},
    )

    event = await emitter.__anext__()
    assert event["event"] == "route.mode_selected"
    assert event["data"]["session_id"] == "sess_1"
    assert event["data"]["mode"] == "direct_reasoning"


@pytest.mark.asyncio
async def test_route_node_selects_direct_reasoning_for_document_summary(sample_agent_state):
    state = {
        **sample_agent_state,
        "messages": [
            {
                "role": "user",
                "content": "[DOCUMENT_CONTEXT_BEGIN]\nsummary\n[DOCUMENT_CONTEXT_END]\n请解读并总结这个文档",
                "name": None,
                "tool_call_id": None,
            }
        ],
    }

    result = await route_node(state, {"runtime_event_emitter": None})

    assert result["execution_mode"] == "direct_reasoning"
    assert result["routing_decision"]["dr_policy"]["single_shot"] is True


async def test_route_node_selects_delegate_for_explicit_sub_agent_request(sample_agent_state):
    runtime_context = sample_agent_state["context"]
    runtime_context.available_sub_agents = [SimpleNamespace(id="researcher", name="Researcher")]
    state = {
        **sample_agent_state,
        "context": runtime_context,
        "messages": [{"role": "user", "content": "把这个任务委托给 researcher", "name": None, "tool_call_id": None}],
    }

    result = await route_node(state, {"runtime_event_emitter": None})

    assert result["execution_mode"] == "delegate"
    assert result["routing_decision"]["delegate_to"] == "researcher"


@pytest.mark.asyncio
async def test_route_node_uses_model_fallback_for_ambiguous_request(sample_agent_state):
    llm_provider = SimpleNamespace(
        chat=AsyncMock(
            return_value=SimpleNamespace(
                content='{"mode":"direct_reasoning","goal":"解释文档重点","reason":"single-turn synthesis","delegate_to":null}'
            )
        )
    )
    state = {
        **sample_agent_state,
        "messages": [
            {
                "role": "user",
                "content": "[DOCUMENT_CONTEXT_BEGIN]\nsummary\n[DOCUMENT_CONTEXT_END]\n这份材料怎么看",
                "name": None,
                "tool_call_id": None,
            }
        ],
    }

    result = await route_node(state, {"runtime_event_emitter": None, "llm_provider": llm_provider})

    assert result["execution_mode"] == "direct_reasoning"
    assert result["routing_decision"]["reason"] == "single-turn synthesis"


def test_route_prompt_includes_available_skills(sample_agent_state):
    runtime_context = sample_agent_state["context"]
    runtime_context.available_skills = [
        SimpleNamespace(
            id="deep-research",
            name="deep-research",
            description="Conducts enterprise-grade research with multi-source synthesis and citations.",
            metadata={"has_skill_md": True},
        )
    ]
    prompt = route_mod._route_model_prompt({**sample_agent_state, "context": runtime_context})

    assert "Available skills:" in prompt
    assert "deep-research" in prompt
    assert "methodology-heavy skill" in prompt


def test_route_prompt_blocks_direct_answer_for_current_data_requests(sample_agent_state):
    prompt = route_mod._route_model_prompt(
        {
            **sample_agent_state,
            "messages": [{"role": "user", "content": "今天北京的天气怎么样", "name": None, "tool_call_id": None}],
        }
    )

    assert "Do NOT choose it if the answer depends on tools, browsing, search, external retrieval," in prompt
    assert "dynamic state, or information not already available in context." in prompt
    assert "direct_reasoning is the default fallback for non-trivial single-turn tasks." in prompt
    assert "Use this whenever the task is non-trivial but still single-turn, even if it may require a small amount of tool use" in prompt
    assert "A single final deliverable does NOT automatically imply plan_act." in prompt
    assert "If no suitable sub-agent exists, do NOT choose delegate; fall back to direct_reasoning or plan_act." in prompt
    assert "requires_tools = true if the task depends on external data, files, retrieval, browsing, or system tools." in prompt


def test_dr_prompts_forbid_raw_tool_payload_output():
    tool_prompt = _dr_tool_phase_prompt("搜索最新 AI 行业动态并总结", {"max_tool_calls": 3, "max_react_iterations": 2})

    assert "Never present raw tool payloads" in tool_prompt


@pytest.mark.asyncio
async def test_route_node_falls_back_to_plan_act_on_internal_error(sample_agent_state, monkeypatch):
    def _boom(_state):
        raise RuntimeError("route exploded")

    monkeypatch.setattr(route_mod, "_try_rule_based_route", _boom)

    result = await route_node(sample_agent_state, {"runtime_event_emitter": None})

    assert result["execution_mode"] == "plan_act"
    assert result["routing_decision"]["reason"].startswith("route failed:")


@pytest.mark.asyncio
async def test_route_shadow_mode_returns_metadata_without_mutating_input(sample_agent_state, monkeypatch):
    monkeypatch.setattr(route_mod, "_ROUTE_SHADOW_MODE", True)
    state = {
        **sample_agent_state,
        "messages": [{"role": "user", "content": "你好", "name": None, "tool_call_id": None}],
        "metadata": {"existing": "value"},
    }

    result = await route_node(state, {"runtime_event_emitter": None})

    assert state["metadata"] == {"existing": "value"}
    assert result["metadata"]["existing"] == "value"
    assert result["metadata"]["route_shadow_decision"]["mode"] == "direct_answer"


@pytest.mark.asyncio
async def test_match_sub_agent_does_not_match_short_id_substrings(sample_agent_state):
    runtime_context = sample_agent_state["context"]
    runtime_context.available_sub_agents = [SimpleNamespace(id="ai", name="")]

    matched = route_mod._match_sub_agent("explain this request", {**sample_agent_state, "context": runtime_context})

    assert matched is None


@pytest.mark.asyncio
async def test_dr_node_returns_completed_result_from_structured_json(sample_agent_state):
    mock_response = SimpleNamespace(
        content='{"status":"completed","answer":"文档总结完成","evidence":[{"chunk":"c0001"}],"diagnostics":{"budget_exceeded":false}}',
        usage={"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
    )
    llm_provider = SimpleNamespace(chat=AsyncMock(return_value=mock_response))
    state = {
        **sample_agent_state,
        "routing_decision": {
            "mode": "direct_reasoning",
            "goal": "解读文档",
            "reason": "document task",
            "delegate_to": None,
            "dr_policy": {
                "single_shot": True,
                "allow_tools": True,
                "allow_skills": True,
                "max_tool_calls": 3,
                "max_wall_clock_ms": 1000,
                "max_prompt_tokens": 24000,
                "max_react_iterations": 2,
                "allow_parallel_tools": False,
            },
        },
    }

    result = await dr_node(state, {"llm_provider": llm_provider, "runtime_event_emitter": None})

    assert result["dr_result"]["status"] == "completed"
    assert result["dr_result"]["answer"] == "文档总结完成"
    assert result["dr_result"]["resource_usage"]["tokens"] == 150


@pytest.mark.asyncio
async def test_dr_node_renders_raw_business_json_to_markdown(sample_agent_state):
    mock_response = SimpleNamespace(
        content='{"executive_summary":"这是最终摘要","valuation_framework":{"method":"SOTP","price_assessment":"当前股价低估"},"key_risks":["竞争加剧","执行风险"]}',
        usage={"prompt_tokens": 120, "completion_tokens": 80, "total_tokens": 200},
    )
    llm_provider = SimpleNamespace(chat=AsyncMock(return_value=mock_response))
    state = {
        **sample_agent_state,
        "routing_decision": {
            "mode": "direct_reasoning",
            "goal": "解读文档",
            "reason": "document task",
            "delegate_to": None,
            "dr_policy": {
                "single_shot": True,
                "allow_tools": True,
                "allow_skills": True,
                "max_tool_calls": 3,
                "max_wall_clock_ms": 1000,
                "max_prompt_tokens": 24000,
                "max_react_iterations": 2,
                "allow_parallel_tools": False,
            },
        },
    }

    result = await dr_node(state, {"llm_provider": llm_provider, "runtime_event_emitter": None})

    assert result["dr_result"]["status"] == "completed"
    assert "## Executive Summary" in result["dr_result"]["answer"]
    assert "这是最终摘要" in result["dr_result"]["answer"]
    assert "## Valuation framework" in result["dr_result"]["answer"]
    assert "- Method: SOTP" in result["dr_result"]["answer"]
    assert '"executive_summary"' not in result["dr_result"]["answer"]


@pytest.mark.asyncio
async def test_dr_node_tolerates_invalid_wrapper_field_types(sample_agent_state):
    mock_response = SimpleNamespace(
        content='{"status":"completed","answer":"ok","diagnostics":"bad","resource_usage":"bad","evidence":"bad","artifacts":"bad"}',
        usage={"prompt_tokens": 30, "completion_tokens": 20, "total_tokens": 50},
    )
    llm_provider = SimpleNamespace(chat=AsyncMock(return_value=mock_response))
    state = {
        **sample_agent_state,
        "routing_decision": {
            "mode": "direct_reasoning",
            "goal": "回答问题",
            "reason": "single turn",
            "delegate_to": None,
            "dr_policy": {
                "single_shot": True,
                "allow_tools": True,
                "allow_skills": True,
                "max_tool_calls": 3,
                "max_wall_clock_ms": 1000,
                "max_prompt_tokens": 24000,
                "max_react_iterations": 2,
                "allow_parallel_tools": False,
            },
        },
    }

    result = await dr_node(state, {"llm_provider": llm_provider, "runtime_event_emitter": None})

    assert result["dr_result"]["status"] == "completed"
    assert result["dr_result"]["answer"] == "ok"
    assert result["dr_result"]["diagnostics"] == {}


@pytest.mark.asyncio
async def test_dr_node_suppresses_raw_wrapper_answer_payload(sample_agent_state):
    raw_payload = json.dumps(
        {
            "url": "https://techcrunch.com/category/artificial-intelligence/",
            "status_code": 200,
            "content_type": "text/html; charset=UTF-8",
            "title": "",
            "text": "AI news coverage and long extracted article body",
        },
        ensure_ascii=False,
    )
    mock_response = SimpleNamespace(
        content=json.dumps({"status": "completed", "answer": raw_payload}, ensure_ascii=False),
        usage={"prompt_tokens": 30, "completion_tokens": 20, "total_tokens": 50},
    )
    llm_provider = SimpleNamespace(chat=AsyncMock(return_value=mock_response))
    state = {
        **sample_agent_state,
        "routing_decision": {
            "mode": "direct_reasoning",
            "goal": "搜索并总结最新 AI 行业动态",
            "reason": "single turn",
            "delegate_to": None,
            "dr_policy": {
                "single_shot": True,
                "allow_tools": True,
                "allow_skills": True,
                "max_tool_calls": 3,
                "max_wall_clock_ms": 1000,
                "max_prompt_tokens": 24000,
                "max_react_iterations": 2,
                "allow_parallel_tools": False,
            },
        },
    }

    result = await dr_node(state, {"llm_provider": llm_provider, "runtime_event_emitter": None})

    assert result["dr_result"]["status"] == "upgrade_required"
    assert result["dr_result"]["answer"] is None
    assert result["dr_result"]["diagnostics"]["raw_payload_suppressed"] is True
    assert "raw payload" in str(result["dr_result"]["upgrade_reason"] or "").lower()


@pytest.mark.asyncio
async def test_dr_node_suppresses_concatenated_raw_wrapper_answer_payload(sample_agent_state):
    first_payload = json.dumps(
        {
            "url": "https://example.com/ai-1",
            "status_code": 200,
            "content_type": "text/html; charset=UTF-8",
            "title": "",
            "text": "first raw content",
        },
        ensure_ascii=False,
    )
    second_payload = json.dumps(
        {
            "url": "https://example.com/ai-2",
            "status_code": 200,
            "content_type": "text/html; charset=UTF-8",
            "title": "",
            "text": "second raw content",
        },
        ensure_ascii=False,
    )
    concatenated = f"{first_payload}\n\n{second_payload}"
    mock_response = SimpleNamespace(
        content=json.dumps({"status": "completed", "answer": concatenated}, ensure_ascii=False),
        usage={"prompt_tokens": 30, "completion_tokens": 20, "total_tokens": 50},
    )
    llm_provider = SimpleNamespace(chat=AsyncMock(return_value=mock_response))
    state = {
        **sample_agent_state,
        "routing_decision": {
            "mode": "direct_reasoning",
            "goal": "搜索并总结最新 AI 行业动态",
            "reason": "single turn",
            "delegate_to": None,
            "dr_policy": {
                "single_shot": True,
                "allow_tools": True,
                "allow_skills": True,
                "max_tool_calls": 3,
                "max_wall_clock_ms": 1000,
                "max_prompt_tokens": 24000,
                "max_react_iterations": 2,
                "allow_parallel_tools": False,
            },
        },
    }

    result = await dr_node(state, {"llm_provider": llm_provider, "runtime_event_emitter": None})

    assert result["dr_result"]["status"] == "upgrade_required"
    assert result["dr_result"]["answer"] is None
    assert result["dr_result"]["diagnostics"]["raw_payload_suppressed"] is True
    assert "raw payload" in str(result["dr_result"]["upgrade_reason"] or "").lower()


@pytest.mark.asyncio
async def test_dr_node_stops_on_pending_approval_and_observe_waits(sample_agent_state, monkeypatch):
    llm_provider = SimpleNamespace(
        chat=AsyncMock(
            return_value=SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "web_fetch", "arguments": '{"url":"https://example.com"}'},
                    }
                ],
                usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            )
        )
    )

    pending_result = ToolCallResult(
        tool_name="web_fetch",
        params={"url": "https://example.com"},
        success=False,
        error="pending approval",
        metadata={"approval_status": "pending", "approval_id": "appr_pending_1"},
    )

    async def _fake_execute(*args, **kwargs):
        return pending_result

    monkeypatch.setattr("src.orchestrator.nodes_dr.execute_single_act_tool_call", _fake_execute)
    monkeypatch.setattr(
        "src.orchestrator.nodes_dr._build_act_tool_schemas",
        lambda runtime_context, skill_registry: [{"type": "function", "function": {"name": "web_fetch"}}],
    )

    state = {
        **sample_agent_state,
        "routing_decision": {
            "mode": "direct_reasoning",
            "goal": "fetch latest info",
            "reason": "single turn",
            "delegate_to": None,
            "dr_policy": {
                "single_shot": True,
                "allow_tools": True,
                "allow_skills": True,
                "max_tool_calls": 3,
                "max_wall_clock_ms": 1000,
                "max_prompt_tokens": 24000,
                "max_react_iterations": 2,
                "allow_parallel_tools": False,
            },
        },
    }

    dr_state = await dr_node(
        state,
        {
            "llm_provider": llm_provider,
            "runtime_event_emitter": None,
            "unified_executor": object(),
            "skill_registry": object(),
            "event_emitter": None,
        },
    )

    assert dr_state["tool_results"][0].metadata["approval_status"] == "pending"
    assert dr_state["dr_result"]["status"] == "partial"
    assert llm_provider.chat.await_count == 1

    observed = await observe_dr_node({**state, **dr_state}, {"runtime_event_emitter": None})

    assert observed["observe_dr_outcome"]["outcome"] == "awaiting_approval"
    assert observed["metadata"]["pending_approval_ids"] == ["appr_pending_1"]
    assert dr_state["dr_result"]["artifacts"] == []


@pytest.mark.asyncio
async def test_observe_dr_waits_for_pending_approval(sample_agent_state):
    state = {
        **sample_agent_state,
        "dr_result": {
            "status": "failed",
            "upgrade_reason": "tool pending approval",
        },
        "tool_results": [
            ToolCallResult(
                tool_name="web_fetch",
                params={"url": "https://example.com"},
                success=False,
                error="pending approval",
                metadata={"approval_status": "pending", "approval_id": "appr_123"},
            )
        ],
    }

    result = await observe_dr_node(state, {"runtime_event_emitter": None})

    assert result["observe_dr_outcome"]["outcome"] == "awaiting_approval"
    assert result["metadata"]["pending_approval_ids"] == ["appr_123"]


@pytest.mark.asyncio
async def test_dr_node_executes_bounded_tool_call_then_finishes(sample_agent_state):
    llm_provider = SimpleNamespace(
        chat=AsyncMock(
            side_effect=[
                SimpleNamespace(
                    content="",
                    usage={"total_tokens": 20},
                    tool_calls=[
                        {
                            "id": "call_1",
                            "function": {
                                "name": "test_tool",
                                "arguments": '{"query":"document"}',
                            },
                        }
                    ],
                    reasoning_content=None,
                ),
                SimpleNamespace(
                    content='{"status":"completed","answer":"已基于工具结果完成总结","diagnostics":{"budget_exceeded":false}}',
                    usage={"total_tokens": 30},
                    tool_calls=[],
                    reasoning_content=None,
                ),
            ]
        )
    )
    action_executor = SimpleNamespace(
        execute=AsyncMock(
            return_value=ToolCallResult(
                tool_name="test_tool",
                params={"query": "document"},
                success=True,
                result={"summary": "tool evidence"},
                error=None,
                metadata={},
            )
        )
    )
    state = {
        **sample_agent_state,
        "routing_decision": {
            "mode": "direct_reasoning",
            "goal": "解读文档",
            "reason": "document task",
            "delegate_to": None,
            "dr_policy": {
                "single_shot": True,
                "allow_tools": True,
                "allow_skills": True,
                "max_tool_calls": 2,
                "max_wall_clock_ms": 1000,
                "max_prompt_tokens": 24000,
                "max_react_iterations": 2,
                "allow_parallel_tools": False,
            },
        },
    }

    result = await dr_node(
        state,
        {
            "llm_provider": llm_provider,
            "action_executor": action_executor,
            "runtime_event_emitter": None,
            "event_emitter": None,
        },
    )

    assert result["dr_result"]["status"] == "completed"
    assert result["dr_result"]["answer"] == "已基于工具结果完成总结"
    assert result["dr_result"]["tool_usage"]["tool_calls"] == 1
    assert result["dr_result"]["resource_usage"]["tokens"] == 50


@pytest.mark.asyncio
async def test_dr_node_does_not_force_terminal_synthesis_after_tool_phase_wrapper(sample_agent_state):
    llm_provider = SimpleNamespace(
        chat=AsyncMock(
            side_effect=[
                SimpleNamespace(
                    content="",
                    usage={"total_tokens": 10},
                    tool_calls=[
                        {
                            "id": "call_1",
                            "function": {
                                "name": "test_tool",
                                "arguments": '{"query":"latest ai"}',
                            },
                        }
                    ],
                    reasoning_content=None,
                ),
                # Tool phase LLM returns completed JSON with raw payload answer.
                SimpleNamespace(
                    content='{"status":"completed","answer":"{\\"url\\":\\"https://example.com\\",\\"status_code\\":200,\\"content_type\\":\\"text/html\\",\\"title\\":\\"\\",\\"text\\":\\"raw\\"}"}',
                    usage={"total_tokens": 15},
                    tool_calls=[],
                    reasoning_content=None,
                ),
            ]
        )
    )
    action_executor = SimpleNamespace(
        execute=AsyncMock(
            return_value=ToolCallResult(
                tool_name="test_tool",
                params={"query": "latest ai"},
                success=True,
                result={"summary": "tool evidence"},
                error=None,
                metadata={},
            )
        )
    )
    state = {
        **sample_agent_state,
        "routing_decision": {
            "mode": "direct_reasoning",
            "goal": "搜索并总结最新 AI 行业动态",
            "reason": "single turn",
            "delegate_to": None,
            "dr_policy": {
                "single_shot": True,
                "allow_tools": True,
                "allow_skills": True,
                "max_tool_calls": 3,
                "max_wall_clock_ms": 1000,
                "max_prompt_tokens": 24000,
                "max_react_iterations": 3,
                "allow_parallel_tools": False,
            },
        },
    }

    result = await dr_node(
        state,
        {
            "llm_provider": llm_provider,
            "action_executor": action_executor,
            "runtime_event_emitter": None,
            "event_emitter": None,
        },
    )

    assert llm_provider.chat.await_count == 2
    assert result["dr_result"]["status"] == "upgrade_required"
    assert result["dr_result"]["answer"] is None
    assert result["dr_result"]["diagnostics"]["raw_payload_suppressed"] is True


@pytest.mark.asyncio
async def test_observe_dr_node_upgrades_failed_dr_with_reason(sample_agent_state):
    state = {
        **sample_agent_state,
        "dr_result": {
            "status": "failed",
            "answer": None,
            "artifacts": [],
            "tool_usage": {"tool_calls": 0, "tokens": 0, "wall_clock_ms": 10},
            "evidence": [],
            "upgrade_reason": "needs multi-stage workflow",
            "failure": {"code": "dr_failed", "message": "test", "retryable": False},
            "diagnostics": {},
            "intermediate_context": None,
            "resource_usage": {"tool_calls": 0, "wall_clock_ms": 10},
        },
    }

    result = await observe_dr_node(state, {"runtime_event_emitter": None})

    assert result["observe_dr_outcome"]["outcome"] == "upgrade_to_plan_act"
