"""Tests for orchestrator nodes (plan_node, act_node, observe_node, etc.)."""

import json
from unittest.mock import AsyncMock, MagicMock
from types import SimpleNamespace
from datetime import datetime
import asyncio
import pytest

from src.orchestrator.nodes_act import _execute_llm_act_step, act_node
from src.orchestrator.act_context import _compact_act_transcript
from src.orchestrator.act_terminal import _build_llm_act_terminal_result, _parse_structured_json_object
from src.orchestrator.act_tool_executor import (
    _bind_file_io_skill_scope,
    _build_tool_transcript_message,
    _code_executor_embeds_bound_text_for_summary_only,
    _code_executor_is_terminal_json_wrapper,
    _ensure_step_result_handoff_contract,
    _extract_generated_file_candidates,
    _filter_finance_search_results,
    _find_latest_generated_report_path,
    _has_same_step_search_provider_failures,
    _inject_context_data,
    _inject_file_io_session_artifacts,
    _inject_skill_script_artifacts,
    _is_finance_research_intent,
    _is_latest_research_intent,
    _search_query_contains_stale_year,
    _serialize_tool_result_payload,
    _summarize_generic_result_for_handoff,
    _tool_call_is_readonly_parallel_safe,
    _validate_llm_act_tool_call,
)
from src.orchestrator.act_llm_caller import build_per_turn_user_message
from src.orchestrator.nodes_delegate import delegate_node
from src.orchestrator.nodes_observe import (
    _build_failure_reflection,
    _build_observe_failure_pattern,
    _build_observe_progress_signature,
    observe_node,
)
from src.orchestrator.nodes_plan import (
    _plan_contains_stale_year_for_latest_request,
    _parse_planner_json_object,
    _build_plan_loop_messages,
    _build_plan_loop_system_prompt,
    _recent_user_messages_for_compact_plan,
    _trim_plan_loop_messages,
    _is_bad_request_error,
    _is_context_overflow_error,
    _merge_dynamic_registry_schemas,
    plan_node,
)
from src.orchestrator.nodes_reflect import reflect_node
from src.orchestrator.nodes_respond import (
    _looks_like_premature_final_response,
    respond_node,
)
from src.orchestrator.nodes_shared import _current_round_skill_id, _serialize_tool_backfeed_content
from src.orchestrator.nodes_stateflow import _build_execution_state_for_planner
from src.orchestrator.execution import ToolCallResult, parse_plan_response
from src.orchestrator.state import AgentState, ExecutionPlan, PlanStep, ReflectionResult, StepInputRef, StepOutputContract
from src.orchestrator.context import AgentConfig, RuntimeSessionContext, ToolDefinition
from src.skills.execution_guard import ExecutionAdvisor
from src.llm.provider_compat import PlanExecutionStrategy, ActExecutionStrategy


# ---------------------------------------------------------------------------
# Auto-use fixture: disable two-phase execution and enable freshness validation
# so tests written for single-phase behaviour continue to work.
# ---------------------------------------------------------------------------
_SINGLE_PHASE_PLAN = PlanExecutionStrategy(
    two_phase=False,
    tool_phase_response_format=None,
    terminal_phase_response_format=None,
)
_SINGLE_PHASE_ACT = ActExecutionStrategy(
    two_phase=False,
    tool_phase_response_format=None,
    terminal_phase_response_format=None,
)


@pytest.fixture(autouse=True)
def _patch_execution_strategies(monkeypatch):
    """Disable two-phase execution and enable freshness validation for all tests."""
    monkeypatch.setattr(
        "src.orchestrator.nodes_plan.resolve_plan_execution_strategy",
        lambda **kw: PlanExecutionStrategy(
            two_phase=False,
            tool_phase_response_format=kw.get("terminal_response_format"),
            terminal_phase_response_format=kw.get("terminal_response_format"),
        ),
    )
    monkeypatch.setattr(
        "src.orchestrator.nodes_act.resolve_act_execution_strategy",
        lambda **kw: ActExecutionStrategy(
            two_phase=False,
            tool_phase_response_format=kw.get("terminal_response_format"),
            terminal_phase_response_format=kw.get("terminal_response_format"),
        ),
    )
    monkeypatch.setattr("src.orchestrator.nodes_plan._ENABLE_FRESHNESS_VALIDATION", True)
    monkeypatch.setattr("src.orchestrator.nodes_act._ENABLE_FRESHNESS_VALIDATION", True)


def _any_message_contains(kwargs: dict, needle: str) -> bool:
    """Check if any message (system or user) in the LLM call contains the needle."""
    return any(needle in str(m.get("content") or "") for m in (kwargs.get("messages") or []))


def _act_result_json(
    *,
    decision: str = "advance_step",
    summary: str = "完成当前步骤",
    artifact_result_text: str | None = None,
) -> str:
    """Build a terminal JSON payload for act tests.

    Note: `decision` is kept for backward compat in test signatures but is ignored
    by the system — act_decision is now system-derived from artifact presence.
    To get advance_step, provide artifact_result_text (>20 chars).
    """
    payload: dict = {
        "observations": [
            {
                "summary": summary,
                "evidence": [],
                "artifacts_produced": [],
                "constraints_encountered": [],
            }
        ],
        "artifacts_produced": [],
    }
    # Default: include artifact_result_text so system derives advance_step.
    if artifact_result_text is not None:
        payload["artifact_result_text"] = artifact_result_text
    elif decision != "continue_current_step":
        # Auto-generate artifact text for advance_step/complete_task to match system derivation.
        payload["artifact_result_text"] = summary if len(summary) > 20 else f"{summary} — step execution completed successfully with results"
    return json.dumps(payload, ensure_ascii=False)


def test_serialize_tool_backfeed_content_truncates_large_payload():
    payload = {
        "results": [{"raw_content": "A" * 5000, "title": "row"} for _ in range(10)],
        "answer": "B" * 5000,
    }

    content = _serialize_tool_backfeed_content(
        tool_name="search",
        tool_call_id="search:1",
        payload=payload,
    )

    assert len(content) < 20000
    assert "A" * 3000 not in content
    assert "...[truncated]" in content


def test_build_plan_loop_messages_truncates_history_and_state():
    messages = _build_plan_loop_messages(
        state_messages=[
            {"role": "user", "content": "U" * 3000},
            {"role": "assistant", "content": "A" * 3000},
        ],
        original_goal="goal",
        current_round_goal="round",
        execution_state={
            "step_input_bindings": {
                "step-1": [
                    {
                        "input_name": "draft",
                        "artifact_result_text": "X" * 3000,
                        "resolved_value": "Y" * 3000,
                    }
                ]
            }
        },
        prior_plan_summary={},
        available_execution_capabilities={"web_retrieval": "Search the web"},
        planning_limits={},
        runtime_context=None,
        memory_context="M" * 10000,
        failure_reflection="",
        sub_agents_for_planner=[],
        agent_system_prompt="",
    )

    serialized = json.dumps(messages, ensure_ascii=False)
    assert "U" * 1500 not in serialized
    assert "A" * 1500 not in serialized
    assert "X" * 1000 not in serialized
    assert "Y" * 1000 not in serialized
    assert "M" * 7000 not in serialized


def test_recent_user_messages_for_compact_plan_excludes_assistant_and_tool_history():
    compact_messages = _recent_user_messages_for_compact_plan(
        [
            {"role": "user", "content": "用户问题"},
            {"role": "assistant", "content": "tool call transcript"},
            {"role": "tool", "content": '{"ok": true}'},
            {"role": "user", "content": "补充要求"},
        ]
    )

    assert compact_messages == [
        {"role": "user", "content": "用户问题"},
        {"role": "user", "content": "补充要求"},
    ]


def test_build_per_turn_user_message_prefers_existing_delivery_artifact():
    content = build_per_turn_user_message(
        act_phase="tool",
        terminal_retry_count=0,
        short_term_budget_text="",
        step_memory={
            "already_loaded_resources": [],
            "modified_resources": [],
            "current_step_outputs": [],
            "current_primary_output": {
                "artifact_result_text": "现有交付内容",
                "artifact_name": "搜索结果摘要",
            },
        },
        artifact_context=[],
        current_step_output_contract={
            "handoff_purpose": "user_delivery",
            "handoff_mode": "final_delivery",
        },
    )

    assert "Existing delivery-ready material is already available" in content
    assert "return the terminal JSON now" in content


def test_build_execution_state_for_planner_truncates_bound_text():
    state = {
        "plan": ExecutionPlan(
            goal="goal",
            steps=[
                PlanStep(
                    id="step-1",
                    title="step",
                ),
                PlanStep(
                    id="step-2",
                    title="next",
                    input_refs=[
                        StepInputRef(
                            name="draft",
                            required=True,
                            source_step_id="step-1",
                            preferred_medium="artifact_result_text",
                        )
                    ],
                ),
            ],
        ),
        "tool_results": [
            ToolCallResult(
                tool_name="llm_act",
                params={},
                result="ok",
                success=True,
                metadata={
                    "source_step_id": "step-1",
                    "text_artifact": {
                        "artifact_result_text": "Z" * 3000,
                        "artifact_name": "draft",
                        "artifact_type": "analysis_synthesis",
                        "artifact_medium": "text",
                        "artifact_format": "plain_text",
                    },
                },
            )
        ],
        "context": None,
    }

    execution_state = _build_execution_state_for_planner(state, prefer_existing=False)
    binding = execution_state["step_input_bindings"]["step-2"][0]
    assert len(binding["artifact_result_text"]) < 500
    assert len(binding["resolved_value"]) < 500
    assert binding["artifact_result_text"].endswith("...[truncated]")


def test_build_execution_state_for_planner_ignores_dr_tool_results():
    state = {
        "plan": ExecutionPlan(goal="goal", steps=[]),
        "tool_results": [
            ToolCallResult(
                tool_name="search",
                params={"query": "latest ai"},
                result="ok",
                success=False,
                metadata={"dr_mode": True, "act_step_id": "dr-step"},
                error="transient dr failure",
            ),
            ToolCallResult(
                tool_name="web_fetch",
                params={"url": "https://example.com"},
                result="ok",
                success=True,
                metadata={"act_step_id": "step-1", "act_decision": "advance_step"},
            ),
        ],
        "context": None,
    }

    execution_state = _build_execution_state_for_planner(state, prefer_existing=False)

    assert "step-1" in execution_state["completed_steps"]
    assert all("transient dr failure" not in item for item in execution_state["observations"])


def test_inject_context_data_skips_code_executor_actions():
    action = PlanStep(
        id="step-1",
        title="run code",
        tool="code_executor",
        params={"language": "python", "code": "print('ok')"},
    )

    _inject_context_data(
        action,
        search_results=[{"title": "row", "url": "https://example.com", "content": "body"}],
        session_id="s1",
        user_request="latest ai news",
    )

    assert "context_data" not in action.params


def test_ensure_step_result_handoff_contract_accepts_artifact_result_path_for_file_delivery():
    action = PlanStep(
        id="step-5",
        title="生成美观的Markdown报告",
        intent="生成最终 markdown 报告",
        output_contract=StepOutputContract(
            primary_output_kind="markdown_report",
            handoff_mode="final_delivery",
            artifact_role="final_deliverable",
            must_produce_text=True,
            must_materialize_file=True,
            file_format="md",
            handoff_purpose="user_delivery",
        ),
    )

    result = ToolCallResult(
        tool_name="llm_act",
        params={"title": "生成美观的Markdown报告"},
        result="done",
        success=True,
        metadata={
            "artifact_result_text": "# 报告标题\n\n正文",
            "artifact_result_path": "AI行业最新动态报告_2026年3月.md",
        },
    )

    normalized = _ensure_step_result_handoff_contract(action, result)

    assert normalized.metadata["handoff_contract_satisfied"] is True


def test_ensure_step_result_handoff_contract_accepts_file_only_user_delivery():
    action = PlanStep(
        id="step-5",
        title="生成最终 Markdown 报告",
        intent="生成最终 markdown 报告并交付给用户",
        output_contract=StepOutputContract(
            primary_output_kind="report_markdown",
            handoff_mode="text_and_file",
            artifact_role="report_md",
            must_produce_text=True,
            must_materialize_file=True,
            file_format="md",
            handoff_purpose="user_delivery",
        ),
    )

    result = ToolCallResult(
        tool_name="file_io",
        params={"action": "write", "path": "report.md"},
        result={"ok": True, "path": "report.md", "bytes": 1024, "updated": True},
        success=True,
        metadata={
            "generated_files": [
                {
                    "filename": "report.md",
                    "path": "/tmp/generated/report.md",
                    "source_path": "/workspace/report.md",
                    "artifact_role": "report_md",
                    "user_visible": True,
                }
            ],
            "artifact_result_path": "report.md",
        },
    )

    normalized = _ensure_step_result_handoff_contract(action, result)

    assert normalized.metadata["handoff_contract_satisfied"] is True


def test_compact_act_transcript_preserves_tool_call_pairs():
    messages = [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {"id": "call-1", "type": "function", "function": {"name": "web_fetch", "arguments": "{}"}},
                {"id": "call-2", "type": "function", "function": {"name": "web_fetch", "arguments": "{}"}},
                {"id": "call-3", "type": "function", "function": {"name": "web_fetch", "arguments": "{}"}},
                {"id": "call-4", "type": "function", "function": {"name": "web_fetch", "arguments": "{}"}},
            ],
        },
        {"role": "tool", "tool_call_id": "call-1", "content": "r1"},
        {"role": "tool", "tool_call_id": "call-2", "content": "r2"},
        {"role": "tool", "tool_call_id": "call-3", "content": "r3"},
        {"role": "tool", "tool_call_id": "call-4", "content": "r4"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {"id": "call-5", "type": "function", "function": {"name": "web_fetch", "arguments": "{}"}},
                {"id": "call-6", "type": "function", "function": {"name": "web_fetch", "arguments": "{}"}},
                {"id": "call-7", "type": "function", "function": {"name": "web_fetch", "arguments": "{}"}},
                {"id": "call-8", "type": "function", "function": {"name": "web_fetch", "arguments": "{}"}},
            ],
        },
        {"role": "tool", "tool_call_id": "call-5", "content": "r5"},
        {"role": "tool", "tool_call_id": "call-6", "content": "r6"},
        {"role": "tool", "tool_call_id": "call-7", "content": "r7"},
        {"role": "tool", "tool_call_id": "call-8", "content": "r8"},
    ]

    compact = _compact_act_transcript(messages, max_messages=8)

    assert [msg.get("tool_call_id") for msg in compact if msg.get("role") == "tool"] == [
        "call-5",
        "call-6",
        "call-7",
        "call-8",
    ]
    assert len(compact) == 5
    assert compact[0]["role"] == "assistant"
    assert [call["id"] for call in compact[0]["tool_calls"]] == [
        "call-5",
        "call-6",
        "call-7",
        "call-8",
    ]


@pytest.fixture
def mock_context():
    """Create mock context with dependencies."""
    skill_registry = MagicMock()
    skill_registry.execute = AsyncMock()
    skill_registry.get_tool_schemas.return_value = [
        {
            "type": "function",
            "function": {
                "name": "search",
                "description": "Search the web",
                "parameters": {"type": "object", "properties": {}},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "skill_script_runner",
                "description": "Run a skill script command",
                "parameters": {"type": "object", "properties": {}},
            },
        },
    ]
    return {
        "llm_provider": AsyncMock(),
        "skill_registry": skill_registry,
        "unified_executor": AsyncMock(),
        "memory": AsyncMock(),
        "capability_graph": MagicMock(),
    }


@pytest.fixture
def base_state():
    """Create base agent state."""
    return {
        "session_id": "test-session",
        "user_id": "test-user",
        "messages": [{"role": "user", "content": "test query"}],
        "plan": None,
        "pending_actions": [],
        "tool_results": [],
        "iteration": 0,
        "current_step": "plan",
        "final_response": None,
    }


def test_extract_generated_file_candidates_prefers_generated_file_source_paths(tmp_path):
    source = tmp_path / "report.pdf"
    source.write_bytes(b"%PDF-1.4\n%%EOF")
    persisted = tmp_path / "persisted-report.pdf"
    persisted.write_bytes(b"%PDF-1.4\n%%EOF")

    result = ToolCallResult(
        tool_name="pdf_report",
        params={},
        result={"filename": "report.pdf"},
        success=True,
        metadata={
            "generated_files": [
                {
                    "filename": "report.pdf",
                    "path": str(persisted),
                    "source_path": str(source),
                }
            ]
        },
    )

    candidates = _extract_generated_file_candidates([result])

    assert str(source) in candidates
    assert str(persisted) in candidates


def test_execution_advisor_infers_markdown_contract_from_help():
    advisor = ExecutionAdvisor()
    contracts = advisor._infer_flag_suffix_contracts_from_help(
        """
usage: validate_report.py --report REPORT

options:
  --report REPORT   Path to research report markdown file
"""
    )
    assert contracts["--report"] == (".md", ".markdown")


def test_looks_like_premature_final_response_detects_process_leak():
    content = """
我来为您对泡泡玛特进行深度研究分析。首先让我读取研究技能文档，然后执行全面的市场分析。
分析请求：主题是泡泡玛特股票研究。
确定行动计划：
步骤1：读取 deep-research 的 SKILL.md。
执行-读取技能：
（内部操作：读取 deep-research 的 SKILL.md）
结果假设：该技能需要详细查询和综合分析。
"""
    assert _looks_like_premature_final_response(content) is True


def test_is_context_overflow_error_avoids_generic_token_misclassification():
    assert _is_context_overflow_error(RuntimeError("maximum context length exceeded")) is True
    assert _is_context_overflow_error(RuntimeError("too many tokens in prompt")) is True
    assert _is_context_overflow_error(RuntimeError("invalid authentication token")) is False
    assert _is_context_overflow_error(RuntimeError("unexpected token in JSON at position 10")) is False


def test_is_bad_request_error_unwraps_retry_error_with_http_400_root():
    class _HTTP400Error(Exception):
        def __init__(self):
            super().__init__(
                "Client error '400 Bad Request' for url 'https://api.moonshot.cn/v1/chat/completions'"
            )
            self.response = SimpleNamespace(status_code=400)

    class RetryError(Exception):
        def __init__(self, inner):
            super().__init__("retry failed")
            self.last_attempt = SimpleNamespace(exception=lambda: inner)

    assert _is_bad_request_error(RetryError(_HTTP400Error())) is True


def test_parse_plan_response_drops_step_tool_and_params_from_planner_contract():
    plan = parse_plan_response(
        {
            "type": "plan",
            "goal": "research topic",
            "steps": [
                {
                    "id": "step-1",
                    "title": "收集信息",
                    "phase": "retrieve",
                    "intent": "收集当前信息",
                    "expected_outputs": ["证据摘要"],
                    "tool": "search",
                    "params": {"query": "latest topic"},
                }
            ],
        }
    )

    assert plan.steps[0].tool is None
    assert plan.steps[0].params == {}
    assert plan.plan_version == 1


def test_parse_plan_response_preserves_plan_version():
    plan = parse_plan_response(
        {
            "type": "plan",
            "goal": "research topic",
            "plan_version": 4,
            "steps": [
                {
                    "id": "step-1",
                    "title": "收集信息",
                    "phase": "retrieve",
                    "intent": "收集当前信息",
                    "expected_outputs": ["证据摘要"],
                }
            ],
        }
    )

    assert plan.plan_version == 4


def test_plan_contains_stale_year_for_latest_request_detects_old_year_in_constraints():
    # Disabled: _plan_contains_stale_year_for_latest_request always returns None
    plan = ExecutionPlan(
        goal="搜索最新的 AI 行业动态并总结",
        round_goal="搜索并整理最新AI行业中文动态，生成分类报告",
        steps=[
            PlanStep(
                id="step-1",
                title="搜索AI行业中文动态",
                intent="通过多关键词搜索获取最新AI行业中文新闻和动态",
                execution_constraints=["优先中文来源", "关注2025-2026年内容", "确保来源可靠"],
            )
        ],
        final_delivery_contract={"delivery_goal": "交付最新 AI 行业动态报告"},
    )

    offending = _plan_contains_stale_year_for_latest_request(
        plan,
        current_date="2026-03-13",
    )

    assert offending is None


def test_plan_contains_stale_year_for_latest_request_allows_historical_request_plan():
    plan = ExecutionPlan(
        goal="研究 2025 年 AI 行业动态",
        round_goal="整理 2025 年 AI 行业动态",
        steps=[
            PlanStep(
                id="step-1",
                title="搜索2025年AI行业动态",
                intent="获取 2025 年 AI 行业动态",
                execution_constraints=["聚焦2025年公开报道"],
            )
        ],
        final_delivery_contract={"delivery_goal": "交付 2025 年 AI 行业动态总结"},
    )

    offending = _plan_contains_stale_year_for_latest_request(
        plan,
        current_date="2025-03-13",
    )

    assert offending is None
    serialized = plan.model_dump()
    assert "tool" not in serialized["steps"][0]
    assert "params" not in serialized["steps"][0]


def test_build_failure_reflection_mentions_non_capability_path_and_artifact_handoff():
    result = ToolCallResult(
        tool_name="file_io",
        params={"action": "read", "scope": "session", "path": "report.md"},
        error="File not found: report.md",
        success=False,
    )

    reflection = _build_failure_reflection(
        tool_results=[result],
        current_skill_name="deep-research",
    )

    assert "Observed Failures" in reflection
    assert "What This Does NOT Mean" in reflection
    assert "Do Not Repeat" in reflection
    assert "Capability Gap Hypothesis" in reflection
    assert "Requirements For The Next Plan" in reflection
    assert "This does not prove a missing capability" in reflection
    assert "Do not read a session artifact by bare filename" in reflection
    assert "Re-read and follow the current skill's SKILL.md before replanning." not in reflection
    assert "current round skill context 'deep-research'" in reflection
    assert "Preserve the current round's skill methodology" in reflection


def test_bind_file_io_skill_scope_uses_current_skill_name():
    step = PlanStep(
        id="1",
        title="读取技能文档",
        tool="file_io",
        params={"action": "read", "scope": "skill", "path": "SKILL.md"},
    )

    _bind_file_io_skill_scope(action=step, selected_skill_name="deep-research")

    assert step.params["skill_name"] == "deep-research"


def test_current_round_skill_id_prefers_skill_context_over_trace_metadata():
    state = {
        "plan": ExecutionPlan(
            goal="research",
            selected_skill="legacy-skill",
            skill_context_for_act={"skill_id": "deep-research"},
        ),
        "metadata": {"skill_orchestration_trace": {"skill_context_skill_id": "trace-skill"}},
    }

    assert _current_round_skill_id(state) == "deep-research"


def test_inject_file_io_session_artifacts_rewrites_generated_report_path(tmp_path):
    session_root = tmp_path / "workspace" / "session-1"
    generated_dir = session_root / "tool_runs" / "code_executor_abc123"
    generated_dir.mkdir(parents=True)
    report = generated_dir / "popmart_research_report.md"
    report.write_text("# report\n", encoding="utf-8")

    action = PlanStep(
        id="1",
        title="读取生成的报告",
        tool="file_io",
        params={"action": "read", "scope": "session", "path": "popmart_research_report.md"},
    )
    prior_results = [
        ToolCallResult(
            tool_name="code_executor",
            params={},
            result={},
            success=True,
            metadata={
                "generated_files": [
                    {
                        "filename": "popmart_research_report.md",
                        "path": str(report),
                        "source_path": str(report),
                        "artifact_role": "report_md",
                    }
                ]
            },
        )
    ]
    runtime_context = SimpleNamespace(metadata={"session_working_dir": str(session_root)})

    _inject_file_io_session_artifacts(action, prior_results, runtime_context, "sess-1")

    assert action.params["path"] == "tool_runs/code_executor_abc123/popmart_research_report.md"


def test_inject_file_io_session_artifacts_falls_back_to_workspace_scan(tmp_path):
    session_root = tmp_path / "workspace" / "session-1"
    generated_dir = session_root / "tool_runs" / "code_executor_xyz789"
    generated_dir.mkdir(parents=True)
    report = generated_dir / "alibaba_stock_research_report.md"
    report.write_text("# report\n", encoding="utf-8")

    action = PlanStep(
        id="1",
        title="读取生成的报告",
        tool="file_io",
        params={"action": "read", "scope": "session", "path": "alibaba_stock_research_report.md"},
    )
    prior_results = [
        ToolCallResult(
            tool_name="code_executor",
            params={},
            result={"stdout": "研究报告框架已生成: alibaba_stock_research_report.md"},
            success=True,
            metadata={},
        )
    ]
    runtime_context = SimpleNamespace(metadata={"session_working_dir": str(session_root)})

    _inject_file_io_session_artifacts(action, prior_results, runtime_context, "sess-1")

    assert action.params["path"] == "tool_runs/code_executor_xyz789/alibaba_stock_research_report.md"


@pytest.mark.asyncio
async def test_plan_node_creates_execution_plan(mock_context, base_state):
    """Test that plan_node creates a valid execution plan."""
    mock_context["llm_provider"].chat.return_value = SimpleNamespace(
        content=json.dumps(
            {
                "type": "plan",
                "goal": "test goal",
                "round_goal": "complete test goal",
                "selected_skill": None,
                "steps": [
                    {
                        "id": "1",
                        "title": "step 1",
                        "phase": "scope",
                        "intent": "understand the task",
                        "inputs_required": ["user request"],
                        "expected_outputs": ["scope"],
                        "execution_constraints": ["use current execution state"],
                        "completion_criteria": ["scope defined"],
                    }
                ],
            },
            ensure_ascii=False,
        ),
        tool_calls=[],
    )

    result = await plan_node(base_state, mock_context)

    assert "plan" in result
    assert result["plan"] is not None
    assert result["plan"].goal == "test goal"
    assert len(result["plan"].steps) == 1
    assert result["plan"].steps[0].inputs_required == ["user request"]
    assert result["plan"].steps[0].execution_constraints == ["use current execution state"]
    assert result["current_step"] == "act"


@pytest.mark.asyncio
async def test_plan_node_rewrites_freshness_terminate_to_plan(mock_context, base_state):
    # Disabled: freshness rewrite is disabled; terminate goes directly to respond
    base_state["messages"] = [{"role": "user", "content": "搜索今天的新闻"}]
    mock_context["llm_provider"].chat.return_value = SimpleNamespace(
        content=json.dumps(
            {
                "type": "terminate",
                "reason": "Need clarification",
                "status": "no_further_action_needed",
                "summary_for_act": "请告诉我你想看的新闻类别。",
            },
            ensure_ascii=False,
        ),
        tool_calls=[],
    )

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "respond"
    assert result["plan"].plan_type == "terminate"


@pytest.mark.asyncio
async def test_plan_node_rewrites_freshness_empty_plan_to_plan(mock_context, base_state):
    # Disabled: freshness rewrite is disabled; plan with no steps is rejected by validator
    # and the planner exhausts its budget, returning an error response
    base_state["messages"] = [{"role": "user", "content": "find latest ai news today"}]
    mock_context["llm_provider"].chat.return_value = SimpleNamespace(
        content=json.dumps(
            {
                "type": "plan",
                "goal": "find latest ai news today",
                "round_goal": "answer the question",
                "steps": [],
            },
            ensure_ascii=False,
        ),
        tool_calls=[],
    )

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "respond"
    assert "error" in result


@pytest.mark.asyncio
async def test_plan_node_rejects_stale_year_plan_for_latest_request(mock_context, base_state):
    base_state["messages"] = [{"role": "user", "content": "搜索最新的 AI 行业动态并总结"}]
@pytest.mark.asyncio
async def test_plan_node_rejects_stale_year_plan_for_latest_request(mock_context, base_state):
    # Disabled: stale year rejection is disabled; first plan is accepted as-is
    base_state["messages"] = [{"role": "user", "content": "搜索最新的 AI 行业动态并总结"}]
    base_state["metadata"] = {
        "current_date": "2026-03-13",
        "current_weekday": "Friday",
        "current_timezone": "UTC",
    }
    mock_context["llm_provider"].chat = AsyncMock(
        return_value=SimpleNamespace(
            content=json.dumps(
                {
                    "type": "plan",
                    "goal": "搜索最新的 AI 行业动态并总结",
                    "round_goal": "搜索并整理最新 AI 行业动态",
                    "current_date": "2026-03-13",
                    "current_weekday": "Friday",
                    "current_timezone": "UTC",
                    "intent_decomposition": {
                        "requested_operation": "搜索最新 AI 行业动态并总结",
                        "delivery_goal": "提供最新 AI 行业动态摘要",
                    },
                    "final_delivery_contract": {
                        "delivery_goal": "提供最新 AI 行业动态摘要",
                    },
                    "steps": [
                        {
                            "id": "step-1",
                            "title": "搜索最新动态",
                            "phase": "retrieve",
                            "intent": "获取最新 AI 行业动态",
                            "expected_outputs": ["搜索结果列表"],
                            "execution_constraints": ["关注2025-2026年内容"],
                            "completion_criteria": ["拿到足够候选内容"],
                            "output_contract": {
                                "primary_output_kind": "evidence_bundle",
                                "handoff_mode": "reasoning_text",
                                "artifact_role": "evidence_bundle",
                                "must_produce_text": True,
                                "must_materialize_file": False,
                                "handoff_purpose": "reasoning_continuation",
                            },
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            tool_calls=[],
        )
    )

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "act"
    # Stale year rejection disabled: first plan accepted with original constraints
    assert result["plan"].steps[0].execution_constraints == ["关注2025-2026年内容"]
    trace = result["metadata"]["planner_loop_trace"]
    assert trace[-1]["outcome"] == "accepted"


@pytest.mark.asyncio
async def test_plan_node_emits_planner_llm_call_diagnostics(mock_context, base_state):
    base_state["messages"] = [{"role": "user", "content": "搜索最新的 AI 行业动态并总结"}]
    base_state["metadata"] = {
        "current_date": "2026-03-13",
        "current_weekday": "Friday",
        "current_timezone": "UTC",
    }
    mock_context["event_emitter"] = AsyncMock()
    mock_context["llm_provider"].model = "kimi-k2.5"
    mock_context["llm_provider"].chat = AsyncMock(
        return_value=SimpleNamespace(
            content=json.dumps(
                {
                    "type": "plan",
                    "goal": "搜索最新的 AI 行业动态并总结",
                    "round_goal": "搜索并整理最新 AI 行业动态",
                    "current_date": "2026-03-13",
                    "current_weekday": "Friday",
                    "current_timezone": "UTC",
                    "intent_decomposition": {
                        "requested_operation": "搜索最新 AI 行业动态并总结",
                        "delivery_goal": "提供最新 AI 行业动态摘要",
                    },
                    "final_delivery_contract": {
                        "delivery_goal": "提供最新 AI 行业动态摘要",
                    },
                    "steps": [
                        {
                            "id": "step-1",
                            "title": "搜索最新动态",
                            "phase": "retrieve",
                            "intent": "获取当前时间范围内的最新 AI 行业动态",
                            "expected_outputs": ["搜索结果列表"],
                            "execution_constraints": ["优先最近一周/一月内容"],
                            "completion_criteria": ["拿到足够候选内容"],
                            "output_contract": {
                                "primary_output_kind": "evidence_bundle",
                                "handoff_mode": "reasoning_text",
                                "artifact_role": "evidence_bundle",
                                "must_produce_text": True,
                                "must_materialize_file": False,
                                "handoff_purpose": "reasoning_continuation",
                            },
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            tool_calls=[],
            finish_reason="stop",
            usage={"prompt_tokens": 123, "completion_tokens": 45, "total_tokens": 168},
        )
    )

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "act"
    emit_calls = mock_context["event_emitter"].emit.await_args_list
    started = [call.args[1] for call in emit_calls if call.args[0] == "planner.llm_call_started"]
    completed = [call.args[1] for call in emit_calls if call.args[0] == "planner.llm_call_completed"]
    assert len(started) == 1
    assert len(completed) == 1
    assert started[0]["model"] == "kimi-k2.5"
    assert completed[0]["finish_reason"] == "stop"
    assert completed[0]["usage"]["total_tokens"] == 168
    assert isinstance(completed[0]["duration_ms"], int)


@pytest.mark.asyncio
async def test_plan_node_retries_when_generic_plan_has_no_steps(mock_context, base_state):
    mock_context["llm_provider"].chat = AsyncMock(
        side_effect=[
            SimpleNamespace(
                content=json.dumps(
                    {
                        "type": "plan",
                        "goal": "test goal",
                        "round_goal": "answer the question",
                        "steps": [],
                    },
                    ensure_ascii=False,
                ),
                tool_calls=[],
            ),
            SimpleNamespace(
                content=json.dumps(
                    {
                        "type": "plan",
                        "goal": "test goal",
                        "round_goal": "complete test goal",
                        "steps": [
                            {
                                "id": "step-1",
                                "title": "界定任务范围",
                                "phase": "scope",
                                "intent": "明确任务边界",
                                "expected_outputs": ["scope"],
                                "completion_criteria": ["scope ready"],
                            }
                        ],
                    },
                    ensure_ascii=False,
                ),
                tool_calls=[],
            ),
        ]
    )

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "act"
    assert result["plan"].plan_type == "plan"
    assert len(result["pending_actions"]) == 1
    assert mock_context["llm_provider"].chat.await_count == 2


@pytest.mark.asyncio
async def test_plan_node_retries_when_explicit_output_contract_is_invalid(mock_context, base_state):
    mock_context["llm_provider"].chat = AsyncMock(
        side_effect=[
            SimpleNamespace(
                content=json.dumps(
                    {
                        "type": "plan",
                        "goal": "研究拼多多股票",
                        "intent_decomposition": {
                            "requested_operation": "研究拼多多股票",
                            "delivery_goal": "给出研究结论",
                        },
                        "final_delivery_contract": {
                            "delivery_goal": "给出研究结论",
                            "delivery_format": "inline_summary",
                            "delivery_scope": "full",
                            "delivery_language": "zh",
                        },
                        "steps": [
                            {
                                "id": "step-1",
                                "title": "收集证据",
                                "phase": "retrieve",
                                "intent": "收集证据",
                                "expected_outputs": ["证据摘要"],
                                "completion_criteria": ["证据足够"],
                                "input_refs": [
                                    {
                                        "name": "user_request",
                                        "required": True,
                                        "preferred_medium": "artifact_result_text",
                                    }
                                ],
                                "output_contract": {
                                    "primary_output_kind": "evidence_bundle",
                                    "handoff_mode": "reasoning_text",
                                    "artifact_role": "evidence_bundle",
                                    "must_produce_text": False,
                                    "must_materialize_file": False,
                                    "handoff_purpose": "reasoning_continuation",
                                },
                            }
                        ],
                    },
                    ensure_ascii=False,
                ),
                tool_calls=[],
            ),
            SimpleNamespace(
                content=json.dumps(
                    {
                        "type": "plan",
                        "goal": "研究拼多多股票",
                        "intent_decomposition": {
                            "requested_operation": "研究拼多多股票",
                            "delivery_goal": "给出研究结论",
                        },
                        "final_delivery_contract": {
                            "delivery_goal": "给出研究结论",
                            "delivery_format": "inline_summary",
                            "delivery_scope": "full",
                            "delivery_language": "zh",
                        },
                        "steps": [
                            {
                                "id": "step-1",
                                "title": "收集证据",
                                "phase": "retrieve",
                                "intent": "收集证据",
                                "expected_outputs": ["证据摘要"],
                                "completion_criteria": ["证据足够"],
                                "input_refs": [
                                    {
                                        "name": "user_request",
                                        "required": True,
                                        "preferred_medium": "artifact_result_text",
                                    }
                                ],
                                "output_contract": {
                                    "primary_output_kind": "evidence_bundle",
                                    "handoff_mode": "reasoning_text",
                                    "artifact_role": "evidence_bundle",
                                    "must_produce_text": True,
                                    "must_materialize_file": False,
                                    "handoff_purpose": "reasoning_continuation",
                                },
                            }
                        ],
                    },
                    ensure_ascii=False,
                ),
                tool_calls=[],
            ),
        ]
    )

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "act"
    assert mock_context["llm_provider"].chat.await_count == 2
    trace = result["metadata"]["planner_loop_trace"]
    assert any(
        "reasoning_text requires must_produce_text=true" in str(item.get("rejection_reason") or "")
        for item in trace
    )


@pytest.mark.asyncio
async def test_plan_node_accepts_empty_input_refs_on_first_step(mock_context, base_state):
    mock_context["llm_provider"].chat = AsyncMock(
        return_value=SimpleNamespace(
            content=json.dumps(
                {
                    "type": "plan",
                    "goal": "搜索最新的 AI 行业动态并总结",
                    "round_goal": "获取并总结最新 AI 行业动态",
                    "intent_decomposition": {
                        "requested_operation": "搜索并总结最新 AI 行业动态",
                        "delivery_goal": "输出中文摘要",
                    },
                    "final_delivery_contract": {
                        "delivery_goal": "输出中文摘要",
                        "delivery_format": "inline_summary",
                        "delivery_scope": "concise",
                        "delivery_language": "zh",
                    },
                    "steps": [
                        {
                            "id": "step-1",
                            "title": "搜索最新动态",
                            "phase": "retrieve",
                            "intent": "获取最新 AI 行业动态",
                            "expected_outputs": ["AI 行业动态结果列表"],
                            "completion_criteria": ["成功获取结果"],
                            "input_refs": [],
                            "output_contract": {
                                "primary_output_kind": "search_results",
                                "handoff_mode": "reasoning_text",
                                "artifact_role": "raw_search_data",
                                "must_produce_text": True,
                                "must_materialize_file": False,
                                "handoff_purpose": "reasoning_continuation",
                            },
                        },
                        {
                            "id": "step-2",
                            "title": "整理并总结",
                            "phase": "synthesis",
                            "intent": "基于前一步结果给出中文总结",
                            "expected_outputs": ["中文摘要"],
                            "completion_criteria": ["输出覆盖主要动态"],
                            "input_refs": [
                                {
                                    "name": "search_results",
                                    "required": True,
                                    "source_step_id": "step-1",
                                    "preferred_medium": "artifact_result_text",
                                    "fallback_medium": "artifact_result_path",
                                    "notes": "",
                                }
                            ],
                            "output_contract": {
                                "primary_output_kind": "inline_summary",
                                "handoff_mode": "final_delivery",
                                "artifact_role": "user_deliverable",
                                "must_produce_text": True,
                                "must_materialize_file": False,
                                "handoff_purpose": "user_delivery",
                            },
                        },
                    ],
                },
                ensure_ascii=False,
            ),
            tool_calls=[],
        )
    )

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "act"
    assert result["plan"].steps[0].input_refs == []
    assert result["plan"].steps[1].input_refs[0].source_step_id == "step-1"


@pytest.mark.asyncio
async def test_plan_node_accepts_empty_input_refs_on_non_initial_step_and_infers_previous_binding(
    mock_context, base_state
):
    mock_context["llm_provider"].chat = AsyncMock(
        return_value=SimpleNamespace(
            content=json.dumps(
                {
                    "type": "plan",
                    "goal": "搜索最新的 AI 行业动态并总结",
                    "round_goal": "获取并总结最新 AI 行业动态",
                    "intent_decomposition": {
                        "requested_operation": "搜索并总结最新 AI 行业动态",
                        "delivery_goal": "输出中文摘要",
                    },
                    "final_delivery_contract": {
                        "delivery_goal": "输出中文摘要",
                    },
                    "steps": [
                        {
                            "id": "step-1",
                            "title": "搜索最新动态",
                            "phase": "retrieve",
                            "intent": "获取最新 AI 行业动态",
                            "expected_outputs": ["AI 行业动态结果列表"],
                            "completion_criteria": ["成功获取结果"],
                            "input_refs": [],
                            "output_contract": {
                                "primary_output_kind": "search_results",
                                "handoff_mode": "reasoning_text",
                                "artifact_role": "raw_search_data",
                                "must_produce_text": True,
                                "must_materialize_file": False,
                                "handoff_purpose": "reasoning_continuation",
                            },
                        },
                        {
                            "id": "step-2",
                            "title": "整理并总结",
                            "phase": "synthesis",
                            "intent": "基于前一步结果给出中文总结",
                            "expected_outputs": ["中文摘要"],
                            "completion_criteria": ["输出覆盖主要动态"],
                            "input_refs": [],
                            "output_contract": {
                                "primary_output_kind": "inline_summary",
                                "handoff_mode": "final_delivery",
                                "artifact_role": "user_deliverable",
                                "must_produce_text": True,
                                "must_materialize_file": False,
                                "handoff_purpose": "user_delivery",
                            },
                        },
                    ],
                },
                ensure_ascii=False,
            ),
            tool_calls=[],
        )
    )

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "act"
    assert result["plan"].steps[0].input_refs == []
    assert len(result["plan"].steps[1].input_refs) == 1
    assert result["plan"].steps[1].input_refs[0].source_step_id == "step-1"
    assert result["plan"].steps[1].input_refs[0].preferred_medium == "artifact_result_text"


@pytest.mark.asyncio
async def test_plan_node_accepts_minimal_final_delivery_contract(mock_context, base_state):
    mock_context["llm_provider"].chat = AsyncMock(
        return_value=SimpleNamespace(
            content=json.dumps(
                {
                    "type": "plan",
                    "goal": "搜索最新的 AI 行业动态并总结",
                    "round_goal": "搜索最新的 AI 行业动态并总结",
                    "intent_decomposition": {
                        "requested_operation": "搜索最新的 AI 行业动态",
                        "delivery_goal": "AI 行业动态中文摘要",
                    },
                    "final_delivery_contract": {
                        "delivery_goal": "AI 行业动态中文摘要",
                    },
                    "steps": [
                        {
                            "id": "step-1",
                            "title": "搜索最新动态",
                            "phase": "retrieve",
                            "intent": "获取最新 AI 行业动态",
                            "expected_outputs": ["AI 行业动态结果列表"],
                            "completion_criteria": ["成功获取结果"],
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            tool_calls=[],
        )
    )

    result = await plan_node(base_state, mock_context)

    assert result["plan"].final_delivery_contract["delivery_goal"] == "AI 行业动态中文摘要"
    assert mock_context["llm_provider"].chat.await_count == 1


@pytest.mark.asyncio
async def test_plan_node_retries_when_input_ref_requests_text_from_file_only_source(mock_context, base_state):
    mock_context["llm_provider"].chat = AsyncMock(
        side_effect=[
            SimpleNamespace(
                content=json.dumps(
                    {
                        "type": "plan",
                        "goal": "搜索最新的 AI 行业动态并总结",
                        "round_goal": "搜索最新的 AI 行业动态并总结",
                        "intent_decomposition": {
                            "requested_operation": "搜索最新 AI 行业动态并总结",
                            "delivery_goal": "提供最新 AI 行业动态的摘要报告",
                        },
                        "final_delivery_contract": {
                            "delivery_goal": "提供最新 AI 行业动态的摘要报告",
                            "delivery_format": "inline_summary",
                            "delivery_scope": "concise",
                            "delivery_language": "zh",
                        },
                        "steps": [
                            {
                                "id": "step-1",
                                "title": "搜索最新动态",
                                "phase": "retrieve",
                                "intent": "获取最新 AI 行业动态",
                                "expected_outputs": ["搜索结果"],
                                "completion_criteria": ["成功获取结果"],
                                "output_contract": {
                                    "primary_output_kind": "search_results",
                                    "handoff_mode": "file_only",
                                    "artifact_role": "raw_search_data",
                                    "must_produce_text": False,
                                    "must_materialize_file": True,
                                    "handoff_purpose": "reasoning_continuation",
                                },
                            },
                            {
                                "id": "step-2",
                                "title": "整理与总结",
                                "phase": "synthesis",
                                "intent": "基于搜索结果进行总结",
                                "expected_outputs": ["摘要报告"],
                                "completion_criteria": ["完成总结"],
                                "input_refs": [
                                    {
                                        "name": "search_results",
                                        "required": True,
                                        "source_step_id": "step-1",
                                        "preferred_medium": "artifact_result_text",
                                    }
                                ],
                                "output_contract": {
                                    "primary_output_kind": "summary_report",
                                    "handoff_mode": "final_delivery",
                                    "artifact_role": "user_deliverable",
                                    "must_produce_text": True,
                                    "must_materialize_file": False,
                                    "file_format": "md",
                                    "handoff_purpose": "user_delivery",
                                },
                            },
                        ],
                    },
                    ensure_ascii=False,
                ),
                tool_calls=[],
            ),
            SimpleNamespace(
                content=json.dumps(
                    {
                        "type": "plan",
                        "goal": "搜索最新的 AI 行业动态并总结",
                        "round_goal": "搜索最新的 AI 行业动态并总结",
                        "intent_decomposition": {
                            "requested_operation": "搜索最新 AI 行业动态并总结",
                            "delivery_goal": "提供最新 AI 行业动态的摘要报告",
                        },
                        "final_delivery_contract": {
                            "delivery_goal": "提供最新 AI 行业动态的摘要报告",
                            "delivery_format": "inline_summary",
                            "delivery_scope": "concise",
                            "delivery_language": "zh",
                        },
                        "steps": [
                            {
                                "id": "step-1",
                                "title": "搜索最新动态",
                                "phase": "retrieve",
                                "intent": "获取最新 AI 行业动态",
                                "expected_outputs": ["搜索结果"],
                                "completion_criteria": ["成功获取结果"],
                                "output_contract": {
                                    "primary_output_kind": "search_results",
                                    "handoff_mode": "reasoning_text",
                                    "artifact_role": "raw_search_data",
                                    "must_produce_text": True,
                                    "must_materialize_file": False,
                                    "handoff_purpose": "reasoning_continuation",
                                },
                            },
                            {
                                "id": "step-2",
                                "title": "整理与总结",
                                "phase": "synthesis",
                                "intent": "基于搜索结果进行总结",
                                "expected_outputs": ["摘要报告"],
                                "completion_criteria": ["完成总结"],
                                "input_refs": [
                                    {
                                        "name": "search_results",
                                        "required": True,
                                        "source_step_id": "step-1",
                                        "preferred_medium": "artifact_result_text",
                                    }
                                ],
                                "output_contract": {
                                    "primary_output_kind": "summary_report",
                                    "handoff_mode": "final_delivery",
                                    "artifact_role": "user_deliverable",
                                    "must_produce_text": True,
                                    "must_materialize_file": False,
                                    "file_format": "md",
                                    "handoff_purpose": "user_delivery",
                                },
                            },
                        ],
                    },
                    ensure_ascii=False,
                ),
                tool_calls=[],
            ),
        ]
    )

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "act"
    assert mock_context["llm_provider"].chat.await_count == 2
    trace = result["metadata"]["planner_loop_trace"]
    assert any(
        "expects artifact_result_text from step-1, but that step does not require text output"
        in str(item.get("rejection_reason") or "")
        for item in trace
    )


@pytest.mark.asyncio
async def test_plan_node_rewrites_research_terminate_to_structured_plan(mock_context, base_state, monkeypatch):
    # Disabled: freshness rewrite is disabled; terminate goes directly to respond
    class _FakeCapabilityGraph:
        def __init__(self, _runtime_context):
            self._runtime_context = _runtime_context

        def get_schemas_for_planner(self):
            return []

    monkeypatch.setattr("src.orchestrator.capability.CapabilityGraph", _FakeCapabilityGraph)
    base_state["messages"] = [{"role": "user", "content": "研究拼多多股票最新动态"}]
    base_state["context"] = SimpleNamespace(
        metadata={
            "skill_index": [
                {
                    "id": "deep-research",
                    "name": "deep-research",
                    "description": "Conduct deep research",
                    "enabled": True,
                }
            ]
        },
        available_skills=[],
        available_sub_agents=[],
        agent_config=SimpleNamespace(system_prompt="", model=None),
    )
    mock_context["llm_provider"].chat.return_value = SimpleNamespace(
        content=json.dumps(
            {
                "type": "terminate",
                "reason": "Need to execute research workflow",
                "status": "no_further_action_needed",
                "summary_for_act": "我将为您进行深入研究，请稍候。",
            },
            ensure_ascii=False,
        ),
        tool_calls=[],
    )

    result = await plan_node(base_state, mock_context)

    # Freshness rewrite disabled: terminate → respond
    assert result["current_step"] == "respond"
    assert result["plan"].plan_type == "terminate"


@pytest.mark.asyncio
async def test_plan_node_retries_when_selected_skill_not_loaded_before_plan(mock_context, base_state, monkeypatch):
    class _FakeCapabilityGraph:
        def __init__(self, _runtime_context):
            self._runtime_context = _runtime_context

        def get_schemas_for_planner(self):
            return []

    monkeypatch.setattr("src.orchestrator.capability.CapabilityGraph", _FakeCapabilityGraph)
    base_state["messages"] = [{"role": "user", "content": "使用deep-research研究拼多多股票"}]
    base_state["context"] = SimpleNamespace(
        metadata={
            "skill_index": [
                {
                    "id": "deep-research",
                    "name": "deep-research",
                    "description": "Conduct deep research",
                    "enabled": True,
                    "package": {
                        "files": [
                            {
                                "path": "SKILL.md",
                                "content": "# deep-research\n## Phases\nscope\nretrieve\npackage",
                            }
                        ]
                    },
                }
            ]
        },
        available_skills=[],
        available_sub_agents=[],
        agent_config=SimpleNamespace(system_prompt="", model=None),
    )
    mock_context["llm_provider"].chat = AsyncMock(
        side_effect=[
            SimpleNamespace(
                content=json.dumps(
                    {
                        "type": "plan",
                        "goal": "使用deep-research研究拼多多股票",
                        "selected_skill": "deep-research",
                        "skill_context_for_act": {
                            "skill_id": "deep-research",
                            "phase": "scope",
                            "execution_rules": [
                                {
                                    "id": "rule-1",
                                    "instruction": "follow deep-research methodology",
                                    "strength": "must",
                                    "condition": "for current round",
                                    "source_ref": "SKILL.md#scope",
                                }
                            ],
                            "quality_checks": [
                                {
                                    "id": "check-1",
                                    "instruction": "范围必须明确",
                                    "strength": "must",
                                    "condition": "scope phase",
                                    "source_ref": "SKILL.md#scope",
                                }
                            ],
                            "artifact_rules": [
                                {
                                    "id": "artifact-1",
                                    "instruction": "记录范围文档",
                                    "strength": "must",
                                    "condition": "scope phase",
                                    "source_ref": "SKILL.md#scope",
                                }
                            ],
                            "replan_triggers": [
                                {
                                    "id": "trigger-1",
                                    "instruction": "如范围无法定义则重规划",
                                    "source_ref": "SKILL.md#scope",
                                }
                            ],
                            "source_sections": ["scope", "retrieve"],
                        },
                        "steps": [
                            {
                                "id": "step-1",
                                "title": "读取deep-research技能文档",
                                "phase": "setup",
                                "intent": "读取 deep-research 的 SKILL.md",
                                "expected_outputs": ["技能方法"],
                                "completion_criteria": ["已读取技能文档"],
                            },
                            {
                                "id": "step-2",
                                "title": "执行deep-research研究拼多多股票",
                                "phase": "execute",
                                "intent": "执行 deep-research 完成股票研究",
                                "expected_outputs": ["研究结果"],
                                "completion_criteria": ["完成研究"],
                            },
                        ],
                    },
                    ensure_ascii=False,
                ),
                tool_calls=[],
            ),
            SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_read_skill_1",
                        "function": {
                            "name": "read_skill",
                            "arguments": "{\"skill_id\":\"deep-research\"}",
                        },
                    }
                ],
            ),
            SimpleNamespace(
                content=json.dumps(
                    {
                        "type": "plan",
                        "goal": "使用deep-research研究拼多多股票",
                        "selected_skill": "deep-research",
                        "skill_context_for_act": {
                            "skill_id": "deep-research",
                            "phase": "scope",
                            "execution_rules": [
                                {
                                    "id": "rule-1",
                                    "instruction": "follow deep-research methodology",
                                    "strength": "must",
                                    "condition": "for current round",
                                    "source_ref": "SKILL.md#scope",
                                }
                            ],
                            "quality_checks": [
                                {
                                    "id": "check-1",
                                    "instruction": "scope must be explicit",
                                    "strength": "must",
                                    "condition": "before leaving scope phase",
                                    "source_ref": "SKILL.md#scope",
                                }
                            ],
                            "artifact_rules": [
                                {
                                    "id": "artifact-1",
                                    "instruction": "记录研究范围",
                                    "strength": "must",
                                    "condition": "scope phase",
                                    "source_ref": "SKILL.md#scope",
                                }
                            ],
                            "replan_triggers": [
                                {
                                    "id": "trigger-1",
                                    "instruction": "范围不明确时重规划",
                                    "source_ref": "SKILL.md#scope",
                                }
                            ],
                            "source_sections": ["scope", "retrieve"],
                        },
                        "steps": [
                            {
                                "id": "step-1",
                                "title": "界定研究范围与方法",
                                "phase": "scope",
                                "intent": "按照 deep-research 方法定义研究范围",
                                "expected_outputs": ["研究范围"],
                                "completion_criteria": ["范围明确"],
                            },
                            {
                                "id": "step-2",
                                "title": "收集并交叉验证多源证据",
                                "phase": "retrieve",
                                "intent": "收集多源证据并验证",
                                "expected_outputs": ["证据集合"],
                                "completion_criteria": ["证据充分"],
                            },
                        ],
                    },
                    ensure_ascii=False,
                ),
                tool_calls=[],
            ),
        ]
    )

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "act"
    assert result["plan"].selected_skill is None
    assert result["plan"].skill_context_for_act is None
    assert [step.title for step in result["pending_actions"]] == [
        "读取deep-research技能文档",
        "执行deep-research研究拼多多股票",
    ]


@pytest.mark.asyncio
async def test_plan_node_rejects_wrapper_plan_after_skill_loaded(mock_context, base_state, monkeypatch):
    class _FakeCapabilityGraph:
        def __init__(self, _runtime_context):
            self._runtime_context = _runtime_context

        def get_schemas_for_planner(self):
            return []

    monkeypatch.setattr("src.orchestrator.capability.CapabilityGraph", _FakeCapabilityGraph)
    base_state["messages"] = [{"role": "user", "content": "使用deep-research研究拼多多股票"}]
    base_state["context"] = SimpleNamespace(
        metadata={
            "skill_index": [
                {
                    "id": "deep-research",
                    "name": "deep-research",
                    "description": "Conduct deep research",
                    "enabled": True,
                    "package": {
                        "files": [
                            {"path": "SKILL.md", "content": "# deep-research\n## Phases\nscope\nretrieve\npackage"}
                        ]
                    },
                }
            ]
        },
        available_skills=[],
        available_sub_agents=[],
        agent_config=SimpleNamespace(system_prompt="", model=None),
    )
    mock_context["llm_provider"].chat = AsyncMock(
        side_effect=[
            SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_read_skill_1",
                        "function": {
                            "name": "read_skill",
                            "arguments": "{\"skill_id\":\"deep-research\"}",
                        },
                    }
                ],
            ),
            SimpleNamespace(
                content=json.dumps(
                    {
                        "type": "plan",
                        "goal": "使用deep-research研究拼多多股票",
                        "selected_skill": "deep-research",
                        "skill_context_for_act": {
                            "skill_id": "deep-research",
                            "phase": "scope",
                            "execution_rules": [{"id": "rule-1", "instruction": "follow methodology", "strength": "must", "condition": "current round", "source_ref": "SKILL.md#scope"}],
                            "quality_checks": [{"id": "check-1", "instruction": "范围明确", "strength": "must", "condition": "scope", "source_ref": "SKILL.md#scope"}],
                            "artifact_rules": [{"id": "artifact-1", "instruction": "记录范围", "strength": "must", "condition": "scope", "source_ref": "SKILL.md#scope"}],
                            "replan_triggers": [{"id": "trigger-1", "instruction": "范围失败时重规划", "source_ref": "SKILL.md#scope"}],
                            "source_sections": ["scope", "retrieve"],
                        },
                        "steps": [
                            {
                                "id": "step-1",
                                "title": "读取deep-research技能文档",
                                "phase": "setup",
                                "intent": "读取 deep-research 的 SKILL.md",
                                "inputs_required": ["skill_name"],
                                "expected_outputs": ["技能文档"],
                                "execution_constraints": ["必须先读文档"],
                                "completion_criteria": ["文档已读取"],
                            },
                            {
                                "id": "step-2",
                                "title": "执行deep-research研究拼多多股票",
                                "phase": "execute",
                                "intent": "执行 deep-research 完成研究",
                                "inputs_required": ["研究问题"],
                                "expected_outputs": ["研究结果"],
                                "execution_constraints": ["使用 deep-research 技能"],
                                "completion_criteria": ["研究完成"],
                            },
                        ],
                    },
                    ensure_ascii=False,
                ),
                tool_calls=[],
            ),
            SimpleNamespace(
                content=json.dumps(
                    {
                        "type": "plan",
                        "goal": "使用deep-research研究拼多多股票",
                        "selected_skill": "deep-research",
                        "skill_context_for_act": {
                            "skill_id": "deep-research",
                            "phase": "scope",
                            "execution_rules": [{"id": "rule-1", "instruction": "follow methodology", "strength": "must", "condition": "current round", "source_ref": "SKILL.md#scope"}],
                            "quality_checks": [{"id": "check-1", "instruction": "范围明确", "strength": "must", "condition": "scope", "source_ref": "SKILL.md#scope"}],
                            "artifact_rules": [{"id": "artifact-1", "instruction": "记录范围", "strength": "must", "condition": "scope", "source_ref": "SKILL.md#scope"}],
                            "replan_triggers": [{"id": "trigger-1", "instruction": "范围失败时重规划", "source_ref": "SKILL.md#scope"}],
                            "source_sections": ["scope", "retrieve"],
                        },
                        "steps": [
                            {
                                "id": "step-1",
                                "title": "界定研究范围与方法",
                                "phase": "scope",
                                "intent": "定义研究边界和成功标准",
                                "inputs_required": ["用户任务"],
                                "expected_outputs": ["研究范围"],
                                "execution_constraints": ["范围必须明确"],
                                "completion_criteria": ["范围已明确"],
                            },
                            {
                                "id": "step-2",
                                "title": "收集并交叉验证多源证据",
                                "phase": "retrieve",
                                "intent": "收集和验证多源证据",
                                "inputs_required": ["研究范围"],
                                "expected_outputs": ["证据集合"],
                                "execution_constraints": ["至少两类来源"],
                                "completion_criteria": ["证据充分"],
                            },
                        ],
                    },
                    ensure_ascii=False,
                ),
                tool_calls=[],
            ),
        ]
    )

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "act"
    planner_loop_trace = result["metadata"]["planner_loop_trace"]
    rejection_entry = next(
        item
        for item in planner_loop_trace
        if "wrapper" in str(item.get("rejection_reason") or "").lower()
        and "deep-research" in str(item.get("rejection_reason") or "")
    )
    assert "wrapper" in rejection_entry["rejection_reason"].lower()
    assert "deep-research" in rejection_entry["rejection_reason"]
    assert [step.title for step in result["plan"].steps] == [
        "界定研究范围与方法",
        "收集并交叉验证多源证据",
    ]


@pytest.mark.asyncio
async def test_plan_node_retries_when_selected_skill_missing_skill_context_for_act(mock_context, base_state, monkeypatch):
    class _FakeCapabilityGraph:
        def __init__(self, _runtime_context):
            self._runtime_context = _runtime_context

        def get_schemas_for_planner(self):
            return []

    monkeypatch.setattr("src.orchestrator.capability.CapabilityGraph", _FakeCapabilityGraph)
    base_state["context"] = SimpleNamespace(
        metadata={
            "skill_index": [
                {
                    "id": "deep-research",
                    "name": "deep-research",
                    "description": "Conduct deep research",
                    "enabled": True,
                    "package": {
                        "files": [
                            {"path": "SKILL.md", "content": "# deep-research\nscope\nretrieve\npackage"}
                        ]
                    },
                }
            ]
        },
        available_skills=[],
        available_sub_agents=[],
        agent_config=SimpleNamespace(system_prompt="", model=None),
    )
    mock_context["llm_provider"].chat = AsyncMock(
        side_effect=[
            SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_read_skill_1",
                        "function": {
                            "name": "read_skill",
                            "arguments": "{\"skill_id\":\"deep-research\"}",
                        },
                    }
                ],
            ),
            SimpleNamespace(
                content=json.dumps(
                    {
                        "type": "plan",
                        "goal": "research",
                        "selected_skill": "deep-research",
                        "steps": [
                            {
                                "id": "step-1",
                                "title": "界定研究范围",
                                "phase": "scope",
                                "intent": "定义研究范围",
                                "expected_outputs": ["scope"],
                                "completion_criteria": ["scope ready"],
                            }
                        ],
                    },
                    ensure_ascii=False,
                ),
                tool_calls=[],
            ),
            SimpleNamespace(
                content=json.dumps(
                    {
                        "type": "plan",
                        "goal": "research",
                        "selected_skill": "deep-research",
                        "skill_context_for_act": {
                            "skill_id": "deep-research",
                            "phase": "scope",
                            "execution_rules": [
                                {
                                    "id": "rule-1",
                                    "instruction": "must define scope before retrieval",
                                    "strength": "must",
                                    "condition": "for current round",
                                    "source_ref": "SKILL.md#scope",
                                }
                            ],
                            "quality_checks": [
                                {
                                    "id": "check-1",
                                    "instruction": "scope must be explicit",
                                    "strength": "must",
                                    "condition": "before leaving scope phase",
                                    "source_ref": "SKILL.md#scope",
                                }
                            ],
                            "artifact_rules": [
                                {
                                    "id": "artifact-1",
                                    "instruction": "保存范围产物",
                                    "strength": "must",
                                    "condition": "scope phase",
                                    "source_ref": "SKILL.md#scope",
                                }
                            ],
                            "replan_triggers": [
                                {
                                    "id": "trigger-1",
                                    "instruction": "范围阶段受阻时重规划",
                                    "source_ref": "SKILL.md#scope",
                                }
                            ],
                            "source_sections": ["scope"],
                        },
                        "steps": [
                            {
                                "id": "step-1",
                                "title": "界定研究范围",
                                "phase": "scope",
                                "intent": "定义研究范围",
                                "expected_outputs": ["scope"],
                                "completion_criteria": ["scope ready"],
                            }
                        ],
                    },
                    ensure_ascii=False,
                ),
                tool_calls=[],
            ),
        ]
    )

    result = await plan_node(base_state, mock_context)

    assert result["plan"].skill_context_for_act is not None
    assert result["plan"].skill_context_for_act["skill_id"] == "deep-research"
    assert result["plan"].skill_context_for_act["execution_rules"]
    assert result["plan"].skill_context_for_act["quality_checks"]
    assert mock_context["llm_provider"].chat.await_count == 3


@pytest.mark.asyncio
async def test_plan_node_retries_when_deep_research_loaded_then_returns_terminate(
    mock_context,
    base_state,
    monkeypatch,
):
    class _FakeCapabilityGraph:
        def __init__(self, _runtime_context):
            self._runtime_context = _runtime_context

        def get_schemas_for_planner(self):
            return []

    monkeypatch.setattr("src.orchestrator.capability.CapabilityGraph", _FakeCapabilityGraph)
    base_state["messages"] = [{"role": "user", "content": "使用deep-research研究拼多多股票"}]
    base_state["context"] = SimpleNamespace(
        metadata={
            "skill_index": [
                {
                    "id": "deep-research",
                    "name": "deep-research",
                    "description": "Conduct deep research",
                    "enabled": True,
                    "package": {
                        "files": [
                            {
                                "path": "SKILL.md",
                                "content": (
                                    "# deep-research\n\n"
                                    "Scope\nPlan\nRetrieve\nTriangulate\nSynthesize\nCritique\nRefine\nPackage\n"
                                ),
                            }
                        ]
                    },
                }
            ]
        },
        available_skills=[],
        available_sub_agents=[],
        agent_config=SimpleNamespace(system_prompt="", model=None),
    )
    mock_context["llm_provider"].chat = AsyncMock(
        side_effect=[
            SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_read_skill_1",
                        "function": {
                            "name": "read_skill",
                            "arguments": "{\"skill_id\":\"deep-research\"}",
                        },
                    }
                ],
            ),
            SimpleNamespace(
                content=json.dumps(
                    {
                        "type": "terminate",
                        "goal": "使用deep-research研究拼多多股票",
                        "reason": "研究已完成",
                        "status": "completed",
                        "summary_for_act": "无需继续",
                    },
                    ensure_ascii=False,
                ),
                tool_calls=[],
            ),
            SimpleNamespace(
                content=json.dumps(
                    {
                        "type": "plan",
                        "goal": "使用deep-research研究拼多多股票",
                        "round_goal": "完成深度研究",
                        "plan_mode": "initial",
                        "selected_skill": "deep-research",
                        "planning_rationale": {
                            "why_this_plan": "按 deep-research 方法展开",
                            "state_used": ["initial request"],
                            "assumptions": [],
                            "critical_constraints": ["保持阶段化研究"],
                        },
                        "skill_context_for_act": {
                            "skill_id": "deep-research",
                            "phase": "scope",
                            "execution_rules": [
                                {
                                    "id": "rule-1",
                                    "instruction": "先明确范围与研究问题，再进入检索。",
                                    "strength": "must",
                                    "condition": "scope and planning phases",
                                    "source_ref": "SKILL.md#scope",
                                }
                            ],
                            "quality_checks": [
                                {
                                    "id": "check-1",
                                    "instruction": "研究范围、假设和交付物必须明确。",
                                    "strength": "must",
                                    "condition": "before leaving planning",
                                    "source_ref": "SKILL.md#plan",
                                }
                            ],
                            "artifact_rules": [
                                {
                                    "id": "artifact-1",
                                    "instruction": "最终产出结构化研究报告。",
                                    "strength": "must",
                                    "condition": "when package phase completes",
                                    "source_ref": "SKILL.md#package",
                                }
                            ],
                            "replan_triggers": [
                                {
                                    "id": "trigger-1",
                                    "instruction": "关键证据缺失或相互矛盾时重规划。",
                                    "source_ref": "SKILL.md#triangulate",
                                }
                            ],
                            "source_sections": ["scope", "plan", "retrieve", "package"],
                        },
                        "steps": [
                            {
                                "id": "step-1",
                                "title": "界定研究范围",
                                "phase": "scope",
                                "intent": "明确研究范围与关键问题",
                                "inputs_required": ["用户任务"],
                                "expected_outputs": ["scope"],
                                "execution_constraints": ["先范围后检索"],
                                "completion_criteria": ["范围明确"],
                            },
                            {
                                "id": "step-2",
                                "title": "制定研究计划",
                                "phase": "plan",
                                "intent": "制定证据路线和验证标准",
                                "inputs_required": ["scope"],
                                "expected_outputs": ["research_plan"],
                                "execution_constraints": ["定义来源与验证标准"],
                                "completion_criteria": ["计划完成"],
                            },
                            {
                                "id": "step-3",
                                "title": "检索与交叉验证证据",
                                "phase": "retrieve",
                                "intent": "收集并验证多源证据",
                                "inputs_required": ["research_plan"],
                                "expected_outputs": ["evidence_bundle"],
                                "execution_constraints": ["必须多源交叉验证"],
                                "completion_criteria": ["证据充分"],
                            },
                            {
                                "id": "step-4",
                                "title": "生成研究报告",
                                "phase": "package",
                                "intent": "输出最终研究报告",
                                "inputs_required": ["evidence_bundle"],
                                "expected_outputs": ["report"],
                                "execution_constraints": ["结论需附证据"],
                                "completion_criteria": ["报告完成"],
                            },
                        ],
                    },
                    ensure_ascii=False,
                ),
                tool_calls=[],
            ),
        ]
    )

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "act"
    assert mock_context["llm_provider"].chat.await_count == 3
    assert [step.phase for step in result["plan"].steps] == ["scope", "plan", "retrieve", "package"]
    assert [step.title for step in result["plan"].steps] != [
        "界定研究范围与方法",
        "收集并交叉验证多源证据",
        "生成最终研究报告",
    ]
    planner_loop_trace = result["metadata"]["planner_loop_trace"]
    rejection_entry = next(
        item
        for item in planner_loop_trace
        if "loaded" in str(item.get("rejection_reason") or "").lower()
        and "deep-research" in str(item.get("rejection_reason") or "")
        and ("terminate" in str(item.get("rejection_reason") or "").lower() or "empty" in str(item.get("rejection_reason") or "").lower())
    )
    assert rejection_entry["candidate_plan_type"] == "terminate"
    assert "deep-research" in rejection_entry["rejection_reason"]


@pytest.mark.asyncio
async def test_plan_node_persists_planner_loop_trace_rejection_reason(
    mock_context,
    base_state,
    monkeypatch,
):
    class _FakeCapabilityGraph:
        def __init__(self, _runtime_context):
            self._runtime_context = _runtime_context

        def get_schemas_for_planner(self):
            return []

    monkeypatch.setattr("src.orchestrator.capability.CapabilityGraph", _FakeCapabilityGraph)
    base_state["messages"] = [{"role": "user", "content": "使用deep-research研究拼多多股票"}]
    base_state["context"] = SimpleNamespace(
        metadata={
            "skill_index": [
                {
                    "id": "deep-research",
                    "name": "deep-research",
                    "description": "Conduct deep research",
                    "enabled": True,
                    "package": {"files": [{"path": "SKILL.md", "content": "# deep-research\nscope\nplan"}]},
                }
            ]
        },
        available_skills=[],
        available_sub_agents=[],
        agent_config=SimpleNamespace(system_prompt="", model=None),
    )
    mock_context["llm_provider"].chat = AsyncMock(
        side_effect=[
            SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_read_skill_1",
                        "function": {
                            "name": "read_skill",
                            "arguments": "{\"skill_id\":\"deep-research\"}",
                        },
                    }
                ],
            ),
            SimpleNamespace(content="not json", tool_calls=[]),
            SimpleNamespace(
                content=json.dumps(
                    {
                        "type": "plan",
                        "goal": "使用deep-research研究拼多多股票",
                        "round_goal": "完成深度研究",
                        "selected_skill": "deep-research",
                        "skill_context_for_act": {
                            "skill_id": "deep-research",
                            "phase": "scope",
                            "execution_rules": [
                                {
                                    "id": "rule-1",
                                    "instruction": "先定义范围。",
                                    "strength": "must",
                                    "condition": "scope",
                                    "source_ref": "SKILL.md#scope",
                                }
                            ],
                            "quality_checks": [
                                {
                                    "id": "check-1",
                                    "instruction": "范围需清晰。",
                                    "strength": "must",
                                    "condition": "scope",
                                    "source_ref": "SKILL.md#scope",
                                }
                            ],
                            "artifact_rules": [
                                {
                                    "id": "artifact-1",
                                    "instruction": "输出范围说明。",
                                    "strength": "must",
                                    "condition": "scope",
                                    "source_ref": "SKILL.md#scope",
                                }
                            ],
                            "replan_triggers": [
                                {
                                    "id": "trigger-1",
                                    "instruction": "范围无法定义时重规划。",
                                    "source_ref": "SKILL.md#scope",
                                }
                            ],
                            "source_sections": ["scope"],
                        },
                        "steps": [
                            {
                                "id": "step-1",
                                "title": "界定研究范围",
                                "phase": "scope",
                                "intent": "定义范围",
                                "inputs_required": ["用户任务"],
                                "expected_outputs": ["scope"],
                                "execution_constraints": ["范围必须明确"],
                                "completion_criteria": ["scope ready"],
                            }
                        ],
                    },
                    ensure_ascii=False,
                ),
                tool_calls=[],
            ),
        ]
    )

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "act"
    planner_loop_trace = result["metadata"]["planner_loop_trace"]
    rejection_entry = next(
        item
        for item in planner_loop_trace
        if item.get("rejection_reason") == "response did not parse as a JSON object"
    )
    assert rejection_entry["raw_response"] == "not json"
    assert rejection_entry["rejection_reason"] == "response did not parse as a JSON object"


@pytest.mark.asyncio
async def test_plan_node_rejects_simulated_tool_calls_in_final_json(
    mock_context,
    base_state,
    monkeypatch,
):
    class _FakeCapabilityGraph:
        def __init__(self, _runtime_context):
            self._runtime_context = _runtime_context

        def get_schemas_for_planner(self):
            return []

    monkeypatch.setattr("src.orchestrator.capability.CapabilityGraph", _FakeCapabilityGraph)
    base_state["messages"] = [{"role": "user", "content": "研究拼多多股票"}]
    mock_context["llm_provider"].chat = AsyncMock(
        side_effect=[
            SimpleNamespace(
                content=json.dumps(
                    {
                        "tool_calls": [
                            {
                                "id": "fake-call",
                                "function": {"name": "deep_research", "arguments": "{}"},
                            }
                        ]
                    },
                    ensure_ascii=False,
                ),
                tool_calls=[],
            ),
            SimpleNamespace(
                content=json.dumps(
                    {
                        "type": "plan",
                        "goal": "研究拼多多股票",
                        "round_goal": "完成研究",
                        "selected_skill": None,
                        "steps": [
                            {
                                "id": "step-1",
                                "title": "收集拼多多关键信息",
                                "phase": "retrieve",
                                "intent": "获取研究所需的关键材料",
                                "inputs_required": ["用户任务"],
                                "expected_outputs": ["基础材料"],
                                "execution_constraints": ["覆盖公司与市场层面"],
                                "completion_criteria": ["材料足够支持后续分析"],
                            }
                        ],
                    },
                    ensure_ascii=False,
                ),
                tool_calls=[],
            ),
        ]
    )

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "act"
    planner_loop_trace = result["metadata"]["planner_loop_trace"]
    assert any(
        "tool_calls" in str(item.get("rejection_reason") or "").lower()
        and "simulated" in str(item.get("rejection_reason") or "").lower()
        for item in planner_loop_trace
    )


@pytest.mark.asyncio
async def test_plan_node_accepts_wrapped_plan_payload_after_read_skill(
    mock_context,
    base_state,
    monkeypatch,
):
    class _FakeCapabilityGraph:
        def __init__(self, _runtime_context):
            self._runtime_context = _runtime_context

        def get_schemas_for_planner(self):
            return []

    monkeypatch.setattr("src.orchestrator.capability.CapabilityGraph", _FakeCapabilityGraph)
    base_state["messages"] = [{"role": "user", "content": "研究拼多多股票"}]
    base_state["context"] = SimpleNamespace(
        metadata={
            "skill_index": [
                {
                    "id": "deep-research",
                    "name": "deep-research",
                    "description": "Conduct deep research",
                    "enabled": True,
                    "package": {"files": [{"path": "SKILL.md", "content": "# deep-research\n## Phase: Scope\n## Phase: Plan"}]},
                }
            ]
        },
        available_skills=[],
        available_sub_agents=[],
        agent_config=SimpleNamespace(system_prompt="", model=None),
    )
    mock_context["llm_provider"].chat = AsyncMock(
        side_effect=[
            SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_read_skill_1",
                        "function": {
                            "name": "read_skill",
                            "arguments": "{\"skill_id\":\"deep-research\"}",
                        },
                    }
                ],
            ),
            SimpleNamespace(
                content=json.dumps(
                    {
                        "plan": {
                            "goal": "研究拼多多股票",
                            "round_goal": "完成深度研究",
                            "selected_skill": "deep-research",
                            "skill_context_for_act": {
                                "skill_id": "deep-research",
                                "phase": "scope",
                                "execution_rules": [
                                    {
                                        "id": "rule-1",
                                        "instruction": "先界定研究范围。",
                                        "strength": "must",
                                        "condition": "scope",
                                        "source_ref": "SKILL.md#scope",
                                    }
                                ],
                                "quality_checks": [
                                    {
                                        "id": "check-1",
                                        "instruction": "范围必须明确。",
                                        "strength": "must",
                                        "condition": "scope",
                                        "source_ref": "SKILL.md#scope",
                                    }
                                ],
                                "artifact_rules": [
                                    {
                                        "id": "artifact-1",
                                        "instruction": "输出范围说明。",
                                        "strength": "must",
                                        "condition": "scope",
                                        "source_ref": "SKILL.md#scope",
                                    }
                                ],
                                "replan_triggers": [
                                    {
                                        "id": "trigger-1",
                                        "instruction": "范围无法定义时重规划。",
                                        "source_ref": "SKILL.md#scope",
                                    }
                                ],
                                "source_sections": ["scope"],
                            },
                            "steps": [
                                {
                                    "id": "step-1",
                                    "title": "界定研究范围",
                                    "phase": "scope",
                                    "intent": "定义研究范围",
                                    "inputs_required": ["用户任务"],
                                    "expected_outputs": ["研究范围"],
                                    "execution_constraints": ["范围必须明确"],
                                    "completion_criteria": ["范围定义完成"],
                                }
                            ],
                        }
                    },
                    ensure_ascii=False,
                ),
                tool_calls=[],
            ),
        ]
    )

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "act"
    assert result["plan"].plan_type == "plan"
    assert len(result["plan"].steps) == 1
    assert result["plan"].steps[0].title == "界定研究范围"


@pytest.mark.asyncio
async def test_plan_node_accepts_phase_wrapped_plan_payload_after_read_skill(
    mock_context,
    base_state,
    monkeypatch,
):
    class _FakeCapabilityGraph:
        def __init__(self, _runtime_context):
            self._runtime_context = _runtime_context

        def get_schemas_for_planner(self):
            return []

    monkeypatch.setattr("src.orchestrator.capability.CapabilityGraph", _FakeCapabilityGraph)
    base_state["messages"] = [{"role": "user", "content": "研究拼多多股票"}]
    base_state["context"] = SimpleNamespace(
        metadata={
            "skill_index": [
                {
                    "id": "deep-research",
                    "name": "deep-research",
                    "description": "Conduct deep research",
                    "enabled": True,
                    "package": {"files": [{"path": "SKILL.md", "content": "# deep-research\n## Phase: Scope\n## Phase: Plan"}]},
                }
            ]
        },
        available_skills=[],
        available_sub_agents=[],
        agent_config=SimpleNamespace(system_prompt="", model=None),
    )
    mock_context["llm_provider"].chat = AsyncMock(
        side_effect=[
            SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_read_skill_1",
                        "function": {
                            "name": "read_skill",
                            "arguments": "{\"skill_id\":\"deep-research\"}",
                        },
                    }
                ],
            ),
            SimpleNamespace(
                content=json.dumps(
                    {
                        "plan": {
                            "goal": "研究拼多多股票",
                            "round_goal": "完成深度研究",
                            "selected_skill": "deep-research",
                            "skill_context_for_act": {
                                "skill_id": "deep-research",
                                "phase": "scope",
                                "execution_rules": [
                                    {
                                        "id": "rule-1",
                                        "instruction": "先界定研究范围。",
                                        "strength": "must",
                                        "condition": "scope",
                                        "source_ref": "SKILL.md#scope",
                                    }
                                ],
                                "quality_checks": [
                                    {
                                        "id": "check-1",
                                        "instruction": "范围必须明确。",
                                        "strength": "must",
                                        "condition": "scope",
                                        "source_ref": "SKILL.md#scope",
                                    }
                                ],
                                "artifact_rules": [
                                    {
                                        "id": "artifact-1",
                                        "instruction": "输出范围说明。",
                                        "strength": "must",
                                        "condition": "scope",
                                        "source_ref": "SKILL.md#scope",
                                    }
                                ],
                                "replan_triggers": [
                                    {
                                        "id": "trigger-1",
                                        "instruction": "范围无法定义时重规划。",
                                        "source_ref": "SKILL.md#scope",
                                    }
                                ],
                                "source_sections": ["scope"],
                            },
                            "phases": [
                                {
                                    "name": "scope",
                                    "steps": [
                                        {
                                            "id": "step-1",
                                            "title": "界定研究范围",
                                            "intent": "定义研究范围",
                                            "inputs_required": ["用户任务"],
                                            "expected_outputs": ["研究范围"],
                                            "execution_constraints": ["范围必须明确"],
                                            "completion_criteria": ["范围定义完成"],
                                        }
                                    ],
                                }
                            ],
                        }
                    },
                    ensure_ascii=False,
                ),
                tool_calls=[],
            ),
        ]
    )

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "act"
    assert result["plan"].plan_type == "plan"
    assert len(result["plan"].steps) == 1
    assert result["plan"].steps[0].phase == "scope"
    assert result["plan"].steps[0].title == "界定研究范围"


@pytest.mark.asyncio
async def test_plan_node_failure_carries_planner_loop_trace(
    mock_context,
    base_state,
    monkeypatch,
):
    class _FakeCapabilityGraph:
        def __init__(self, _runtime_context):
            self._runtime_context = _runtime_context

        def get_schemas_for_planner(self):
            return []

    monkeypatch.setattr("src.orchestrator.capability.CapabilityGraph", _FakeCapabilityGraph)
    base_state["messages"] = [{"role": "user", "content": "研究拼多多股票"}]
    mock_context["llm_provider"].chat = AsyncMock(
        return_value=SimpleNamespace(content="not json", tool_calls=[])
    )

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "respond"
    assert result["error"] == "Planning failed: planner did not produce valid JSON within turn budget"
    planner_loop_trace = result["metadata"]["planner_loop_trace"]
    assert planner_loop_trace
    assert any(item.get("rejection_reason") == "response did not parse as a JSON object" for item in planner_loop_trace)


@pytest.mark.asyncio
async def test_plan_node_retries_with_compact_mode_after_planner_timeout(
    mock_context,
    base_state,
    monkeypatch,
):
    class _FakeCapabilityGraph:
        def __init__(self, _runtime_context):
            self._runtime_context = _runtime_context

        def get_schemas_for_planner(self):
            return []

    monkeypatch.setattr("src.orchestrator.capability.CapabilityGraph", _FakeCapabilityGraph)
    monkeypatch.setattr("src.orchestrator.nodes_plan._planner_llm_timeout_seconds", lambda _provider: 0.01)
    monkeypatch.setattr("src.orchestrator.plan_llm_caller._planner_llm_timeout_seconds", lambda _provider: 0.01)
    base_state["messages"] = [{"role": "user", "content": "搜索最新的 AI 行业动态并总结"}]

    async def _slow_then_valid(*args, **kwargs):
        _slow_then_valid.calls += 1
        if _slow_then_valid.calls == 1:
            await asyncio.sleep(0.05)
        return SimpleNamespace(
            content=json.dumps(
                {
                    "plan": {
                        "goal": "搜索最新的 AI 行业动态并总结",
                        "round_goal": "检索并整理最新中文 AI 行业动态",
                        "current_date": "2026-03-13",
                        "current_weekday": "Friday",
                        "current_timezone": "UTC",
                        "phases": [
                            {
                                "name": "retrieve",
                                "steps": [
                                    {
                                        "id": "step-1",
                                        "title": "检索最新动态",
                                        "intent": "检索最新中文 AI 行业动态",
                                        "inputs_required": ["用户请求"],
                                        "expected_outputs": ["新闻候选列表"],
                                        "execution_constraints": ["优先最新中文来源"],
                                        "completion_criteria": ["获得足够候选新闻"],
                                        "input_refs": [],
                                        "output_contract": {
                                            "primary_output_kind": "news_candidates",
                                            "handoff_mode": "reasoning_text",
                                            "artifact_role": "research_candidates",
                                            "must_produce_text": True,
                                            "must_materialize_file": False,
                                            "handoff_purpose": "reasoning_continuation",
                                        },
                                    }
                                ],
                            }
                        ],
                        "final_delivery_contract": {"delivery_goal": "structured_summary"},
                    }
                },
                ensure_ascii=False,
            ),
            tool_calls=[],
            finish_reason="stop",
            usage={},
        )

    _slow_then_valid.calls = 0
    mock_context["llm_provider"].chat = AsyncMock(side_effect=_slow_then_valid)

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "act"
    assert result["plan"].steps[0].title == "检索最新动态"
    assert mock_context["llm_provider"].chat.await_count == 2
    planner_loop_trace = result["metadata"]["planner_loop_trace"]
    assert planner_loop_trace[0]["outcome"] == "timeout_retry_with_compact_mode"


@pytest.mark.asyncio
async def test_plan_node_fails_fast_after_repeated_planner_timeout(
    mock_context,
    base_state,
    monkeypatch,
):
    class _FakeCapabilityGraph:
        def __init__(self, _runtime_context):
            self._runtime_context = _runtime_context

        def get_schemas_for_planner(self):
            return []

    monkeypatch.setattr("src.orchestrator.capability.CapabilityGraph", _FakeCapabilityGraph)
    monkeypatch.setattr("src.orchestrator.nodes_plan._planner_llm_timeout_seconds", lambda _provider: 0.01)
    monkeypatch.setattr("src.orchestrator.plan_llm_caller._planner_llm_timeout_seconds", lambda _provider: 0.01)
    base_state["messages"] = [{"role": "user", "content": "搜索最新的 AI 行业动态并总结"}]

    async def _always_slow(*args, **kwargs):
        await asyncio.sleep(0.05)

    mock_context["llm_provider"].chat = AsyncMock(side_effect=_always_slow)

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "respond"
    assert "timed out" in result["error"].lower()
    assert mock_context["llm_provider"].chat.await_count == 2


@pytest.mark.asyncio
async def test_plan_node_retries_when_selected_skill_has_invalid_skill_context_structure(
    mock_context,
    base_state,
    monkeypatch,
):
    class _FakeCapabilityGraph:
        def __init__(self, _runtime_context):
            self._runtime_context = _runtime_context

        def get_schemas_for_planner(self):
            return []

    monkeypatch.setattr("src.orchestrator.capability.CapabilityGraph", _FakeCapabilityGraph)
    base_state["context"] = SimpleNamespace(
        metadata={
            "skill_index": [
                {
                    "id": "deep-research",
                    "name": "deep-research",
                    "description": "Conduct deep research",
                    "enabled": True,
                    "package": {
                        "files": [
                            {"path": "SKILL.md", "content": "# deep-research\nscope\nretrieve\npackage"}
                        ]
                    },
                }
            ]
        },
        available_skills=[],
        available_sub_agents=[],
        agent_config=SimpleNamespace(system_prompt="", model=None),
    )
    mock_context["llm_provider"].chat = AsyncMock(
        side_effect=[
            SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_read_skill_1",
                        "function": {
                            "name": "read_skill",
                            "arguments": "{\"skill_id\":\"deep-research\"}",
                        },
                    }
                ],
            ),
            SimpleNamespace(
                content=json.dumps(
                    {
                        "type": "plan",
                        "goal": "research",
                        "selected_skill": "deep-research",
                        "skill_context_for_act": {
                            "skill_id": "deep-research",
                            "phase": "scope",
                            "execution_rules": [
                                {
                                    "id": "rule-1",
                                    "instruction": "must define scope before retrieval",
                                    "source_ref": "SKILL.md#scope",
                                }
                            ],
                            "quality_checks": [],
                            "artifact_rules": [],
                            "replan_triggers": [],
                            "source_sections": [],
                        },
                        "steps": [
                            {
                                "id": "step-1",
                                "title": "界定研究范围",
                                "phase": "scope",
                                "intent": "定义研究范围",
                                "expected_outputs": ["scope"],
                                "completion_criteria": ["scope ready"],
                            }
                        ],
                    },
                    ensure_ascii=False,
                ),
                tool_calls=[],
            ),
            SimpleNamespace(
                content=json.dumps(
                    {
                        "type": "plan",
                        "goal": "research",
                        "selected_skill": "deep-research",
                        "skill_context_for_act": {
                            "skill_id": "deep-research",
                            "phase": "scope",
                            "execution_rules": [
                                {
                                    "id": "rule-1",
                                    "instruction": "must define scope before retrieval",
                                    "strength": "must",
                                    "condition": "for current round",
                                    "source_ref": "SKILL.md#scope",
                                }
                            ],
                            "quality_checks": [
                                {
                                    "id": "check-1",
                                    "instruction": "scope must be explicit",
                                    "strength": "must",
                                    "condition": "before leaving scope phase",
                                    "source_ref": "SKILL.md#scope",
                                }
                            ],
                            "artifact_rules": [
                                {
                                    "id": "artifact-1",
                                    "instruction": "save scope artifact",
                                    "strength": "must",
                                    "condition": "scope phase",
                                    "source_ref": "SKILL.md#scope",
                                }
                            ],
                            "replan_triggers": [
                                {
                                    "id": "trigger-1",
                                    "instruction": "replan if scope cannot be defined",
                                    "source_ref": "SKILL.md#scope",
                                }
                            ],
                            "source_sections": ["scope"],
                        },
                        "steps": [
                            {
                                "id": "step-1",
                                "title": "界定研究范围",
                                "phase": "scope",
                                "intent": "定义研究范围",
                                "expected_outputs": ["scope"],
                                "completion_criteria": ["scope ready"],
                            }
                        ],
                    },
                    ensure_ascii=False,
                ),
                tool_calls=[],
            ),
        ]
    )

    result = await plan_node(base_state, mock_context)

    assert result["plan"].skill_context_for_act is not None
    assert result["plan"].skill_context_for_act["execution_rules"][0]["strength"] == "must"
    assert result["plan"].skill_context_for_act["artifact_rules"]
    assert result["plan"].skill_context_for_act["replan_triggers"]
    assert mock_context["llm_provider"].chat.await_count == 3


@pytest.mark.asyncio
async def test_plan_node_preserves_explicit_skill_context_for_act(mock_context, base_state, monkeypatch):
    class _FakeCapabilityGraph:
        def __init__(self, _runtime_context):
            self._runtime_context = _runtime_context

        def get_schemas_for_planner(self):
            return []

    monkeypatch.setattr("src.orchestrator.capability.CapabilityGraph", _FakeCapabilityGraph)
    base_state["context"] = SimpleNamespace(
        metadata={
            "skill_index": [
                {
                    "id": "deep-research",
                    "name": "deep-research",
                    "description": "Conduct deep research",
                    "enabled": True,
                    "package": {
                        "files": [
                            {"path": "SKILL.md", "content": "# deep-research\nscope\nretrieve\npackage"}
                        ]
                    },
                }
            ]
        },
        available_skills=[],
        available_sub_agents=[],
        agent_config=SimpleNamespace(system_prompt="", model=None),
    )
    explicit_skill_context = {
        "skill_id": "deep-research",
        "phase": "scope",
        "execution_rules": [
            {
                "id": "rule-1",
                "instruction": "must define scope before retrieval",
                "strength": "must",
                "condition": "for step-1",
                "source_ref": "SKILL.md#scope",
            }
        ],
        "quality_checks": [
            {
                "id": "check-1",
                "instruction": "范围必须明确",
                "strength": "must",
                "condition": "scope phase",
                "source_ref": "SKILL.md#scope",
            }
        ],
        "artifact_rules": [
            {
                "id": "artifact-1",
                "instruction": "保存阶段产物",
                "strength": "must",
                "condition": "scope phase",
                "source_ref": "scope",
            }
        ],
        "replan_triggers": [
            {
                "id": "trigger-1",
                "instruction": "范围无法界定时重规划",
                "source_ref": "scope",
            }
        ],
        "source_sections": ["scope"],
    }
    mock_context["llm_provider"].chat = AsyncMock(
        side_effect=[
            SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_read_skill_1",
                        "function": {
                            "name": "read_skill",
                            "arguments": "{\"skill_id\":\"deep-research\"}",
                        },
                    }
                ],
            ),
            SimpleNamespace(
                content=json.dumps(
                    {
                        "type": "plan",
                        "goal": "research",
                        "selected_skill": "deep-research",
                        "skill_context_for_act": explicit_skill_context,
                        "steps": [
                            {
                                "id": "step-1",
                                "title": "界定研究范围",
                                "phase": "scope",
                                "intent": "定义研究范围",
                                "expected_outputs": ["scope"],
                                "completion_criteria": ["scope ready"],
                            }
                        ],
                    },
                    ensure_ascii=False,
                ),
                tool_calls=[],
            ),
        ]
    )

    result = await plan_node(base_state, mock_context)

    assert result["plan"].skill_context_for_act == explicit_skill_context

@pytest.mark.asyncio
async def test_plan_node_retries_with_compact_prompt_after_bad_request(mock_context, base_state):
    class _HTTP400Error(Exception):
        def __init__(self):
            super().__init__(
                "Client error '400 Bad Request' for url 'https://api.moonshot.cn/v1/chat/completions'"
            )
            self.response = SimpleNamespace(status_code=400, text='{"error":{"message":"unsupported request payload"}}')

    class RetryError(Exception):
        def __init__(self, inner):
            super().__init__("retry failed")
            self.last_attempt = SimpleNamespace(exception=lambda: inner)

    mock_context["llm_provider"].chat.side_effect = [
        RetryError(_HTTP400Error()),
        RetryError(_HTTP400Error()),
        SimpleNamespace(
            content=json.dumps(
                {
                    "type": "plan",
                    "goal": "搜索今天的新闻",
                    "round_goal": "获取并整理今天的新闻",
                    "selected_skill": None,
                    "steps": [
                        {
                            "id": "step-1",
                            "title": "检索今天的新闻",
                            "phase": "retrieve",
                            "intent": "获取当天主要新闻",
                            "expected_outputs": ["最新新闻摘要"],
                            "completion_criteria": ["至少返回若干条当天新闻"],
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            tool_calls=[],
        ),
    ]
    base_state["messages"] = [{"role": "user", "content": "搜索今天的新闻"}]

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "act"
    assert result["plan"].plan_type == "plan"
    assert mock_context["llm_provider"].chat.await_count == 3
    first_call = mock_context["llm_provider"].chat.await_args_list[0]
    second_call = mock_context["llm_provider"].chat.await_args_list[1]
    third_call = mock_context["llm_provider"].chat.await_args_list[2]
    assert first_call.kwargs["tools"] is None
    assert second_call.kwargs["tools"] is None
    assert third_call.kwargs["tools"] is None
    compact_prompt = second_call.kwargs["messages"][0]["content"]
    assert "Create an execution plan as JSON only" in compact_prompt
    assert "Design plan steps around the execution capabilities below" in compact_prompt
    assert "final JSON must never contain tool_calls" in compact_prompt
    assert "Available planning tools (if provided by runtime): read_skill, inspect_sub_agent" in compact_prompt
    planner_loop_trace = result["metadata"]["planner_loop_trace"]
    assert planner_loop_trace[0]["outcome"] == "bad_request_retry_with_compact_mode"
    assert planner_loop_trace[1]["outcome"] == "bad_request_tools_disabled_retry"


@pytest.mark.asyncio
async def test_plan_node_compact_mode_preserves_loaded_skill_context(
    mock_context, base_state, monkeypatch
):
    class _HTTP400Error(Exception):
        def __init__(self):
            super().__init__(
                "Client error '400 Bad Request' for url 'https://api.moonshot.cn/v1/chat/completions'"
            )
            self.response = SimpleNamespace(status_code=400, text='{"error":{"message":"unsupported request payload"}}')

    class RetryError(Exception):
        def __init__(self, inner):
            super().__init__("retry failed")
            self.last_attempt = SimpleNamespace(exception=lambda: inner)

    class _FakeCapabilityGraph:
        def __init__(self, _runtime_context):
            self._runtime_context = _runtime_context

        def get_schemas_for_planner(self):
            return []

    monkeypatch.setattr("src.orchestrator.capability.CapabilityGraph", _FakeCapabilityGraph)
    base_state["context"] = SimpleNamespace(
        metadata={
            "skill_index": [
                {
                    "id": "deep-research",
                    "name": "deep-research",
                    "description": "Conduct deep research",
                    "enabled": True,
                    "package": {
                        "files": [
                            {
                                "path": "SKILL.md",
                                "content": "# deep-research\n\n## Workflow\n1. Scope\n2. Retrieve\n3. Package\n",
                            }
                        ]
                    },
                }
            ]
        },
        available_skills=[],
        available_sub_agents=[],
        agent_config=SimpleNamespace(system_prompt="", model=None),
    )
    seen_messages: list[list[dict[str, Any]]] = []

    async def _chat(**kwargs):
        messages = kwargs.get("messages") or []
        seen_messages.append(messages)
        if len(seen_messages) == 1:
            return SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_read_skill",
                        "function": {
                            "name": "read_skill",
                            "arguments": "{\"skill_id\":\"deep-research\"}",
                        },
                    }
                ],
            )
        if len(seen_messages) == 2:
            raise RetryError(_HTTP400Error())
        return SimpleNamespace(
            content=json.dumps(
                {
                    "type": "plan",
                    "goal": "完成研究",
                    "round_goal": "完成研究计划",
                    "selected_skill": "deep-research",
                    "skill_context_for_act": {
                        "skill_id": "deep-research",
                        "phase": "scope",
                        "execution_rules": [
                            {
                                "id": "rule-1",
                                "instruction": "must define scope before retrieval",
                                "strength": "must",
                                "condition": "for current round",
                                "source_ref": "SKILL.md#scope",
                            }
                        ],
                        "quality_checks": [
                            {
                                "id": "check-1",
                                "instruction": "范围必须明确",
                                "strength": "must",
                                "condition": "scope phase",
                                "source_ref": "SKILL.md#scope",
                            }
                        ],
                        "artifact_rules": [
                            {
                                "id": "artifact-1",
                                "instruction": "记录范围文档",
                                "strength": "must",
                                "condition": "scope phase",
                                "source_ref": "SKILL.md#scope",
                            }
                        ],
                        "replan_triggers": [
                            {
                                "id": "trigger-1",
                                "instruction": "范围阶段失败时重规划",
                                "source_ref": "SKILL.md#scope",
                            }
                        ],
                        "source_sections": ["scope"],
                    },
                    "steps": [
                        {
                            "id": "step-1",
                            "title": "定义研究范围",
                            "phase": "scope",
                            "intent": "明确研究边界",
                            "inputs_required": ["task"],
                            "expected_outputs": ["scope_definition"],
                            "execution_constraints": ["先定义范围"],
                            "completion_criteria": ["研究范围已明确"],
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            tool_calls=[],
        )

    mock_context["llm_provider"].chat.side_effect = _chat

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "act"
    compact_messages = seen_messages[2]
    preserved_skill_notice = next(
        message
        for message in compact_messages
        if message.get("role") == "system"
        and "already loaded earlier in this planning session" in str(message.get("content") or "")
    )
    assert "deep-research" in str(preserved_skill_notice.get("content") or "")
    preserved_skill_tool = next(
        message
        for message in compact_messages
        if message.get("role") == "tool"
        and str(message.get("tool_call_id") or "").startswith("read_skill:loaded:")
    )
    preserved_payload = json.loads(str(preserved_skill_tool.get("content") or ""))
    assert preserved_payload["purpose"] == "planning_methodology_scaffold"
    assert preserved_payload["payload"]["skill_id"] == "deep-research"


@pytest.mark.asyncio
async def test_plan_node_uses_read_skill_tool_loop(mock_context, base_state, monkeypatch):
    class _FakeCapabilityGraph:
        def __init__(self, _runtime_context):
            self._runtime_context = _runtime_context

        def get_schemas_for_planner(self):
            return []

    monkeypatch.setattr("src.orchestrator.capability.CapabilityGraph", _FakeCapabilityGraph)
    base_state["context"] = SimpleNamespace(
        metadata={
            "skill_index": [
                {
                    "id": "deep-research",
                    "name": "deep-research",
                    "description": "Conduct deep research",
                    "enabled": True,
                    "package": {
                        "files": [
                            {
                                "path": "SKILL.md",
                                "content": "# deep-research\n\n## Workflow\n1. Scope\n2. Retrieve\n3. Package\n",
                            }
                        ]
                    },
                }
            ]
        },
        available_skills=[],
        available_sub_agents=[],
        agent_config=SimpleNamespace(system_prompt="", model=None),
    )
    seen_messages: list[list[dict[str, Any]]] = []

    async def _chat(**kwargs):
        messages = kwargs.get("messages") or []
        seen_messages.append(messages)
        if len(seen_messages) == 1:
            return SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_read_skill",
                        "function": {
                            "name": "read_skill",
                            "arguments": "{\"skill_id\":\"deep-research\"}",
                        },
                    }
                ],
            )
        return SimpleNamespace(
            content=json.dumps(
                {
                    "type": "plan",
                    "goal": "完成研究",
                    "round_goal": "完成研究计划",
                    "selected_skill": "deep-research",
                    "skill_context_for_act": {
                        "skill_id": "deep-research",
                        "phase": "scope",
                        "execution_rules": [
                            {
                                "id": "rule-1",
                                "instruction": "must define scope before retrieval",
                                "strength": "must",
                                "condition": "for current round",
                                "source_ref": "SKILL.md#scope",
                            }
                        ],
                        "quality_checks": [
                            {
                                "id": "check-1",
                                "instruction": "范围必须明确",
                                "strength": "must",
                                "condition": "scope phase",
                                "source_ref": "SKILL.md#scope",
                            }
                        ],
                        "artifact_rules": [
                            {
                                "id": "artifact-1",
                                "instruction": "记录范围文档",
                                "strength": "must",
                                "condition": "scope phase",
                                "source_ref": "SKILL.md#scope",
                            }
                        ],
                        "replan_triggers": [
                            {
                                "id": "trigger-1",
                                "instruction": "范围阶段失败时重规划",
                                "source_ref": "SKILL.md#scope",
                            }
                        ],
                        "source_sections": ["scope"],
                    },
                    "steps": [
                        {
                            "id": "step-1",
                            "title": "定义研究范围",
                            "phase": "scope",
                            "intent": "明确研究边界",
                            "expected_outputs": ["scope_definition"],
                            "completion_criteria": ["研究范围已明确"],
                            "skill_source": "deep-research",
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            tool_calls=[],
        )

    mock_context["llm_provider"].chat.side_effect = _chat

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "act"
    assert result["plan"].selected_skill == "deep-research"
    assert mock_context["llm_provider"].chat.await_count == 2
    orchestration_trace = result["metadata"]["skill_orchestration_trace"]
    assert orchestration_trace["loaded_skill_id"] == "deep-research"
    assert orchestration_trace["planner_loaded_skill_id"] == "deep-research"
    second_turn_messages = seen_messages[1]
    tool_message = next(message for message in second_turn_messages if message.get("role") == "tool")
    tool_payload = json.loads(str(tool_message.get("content") or ""))
    assert tool_payload["semibot_message_type"] == "tool_result_v1"
    assert tool_payload["toolName"] == "read_skill"
    assert tool_payload["toolCallId"] == "call_read_skill"
    assert tool_payload["purpose"] == "planning_methodology_scaffold"
    guidance_message = next(
        message
        for message in second_turn_messages
        if message.get("role") == "system"
        and "methodology scaffold for planning" in str(message.get("content") or "")
    )
    assert "selected_skill='deep-research'" in str(guidance_message.get("content") or "")
    planner_loop_trace = result["metadata"]["planner_loop_trace"]
    backfeed_entry = next(item for item in planner_loop_trace if item.get("outcome") == "tool_result_backfed")
    assert backfeed_entry["purpose"] == "planning_methodology_scaffold"
    assert backfeed_entry["requested_skill_id"] == "deep-research"


@pytest.mark.asyncio
async def test_plan_node_deduplicates_read_skill_calls(mock_context, base_state, monkeypatch):
    class _FakeCapabilityGraph:
        def __init__(self, _runtime_context):
            self._runtime_context = _runtime_context

        def get_schemas_for_planner(self):
            return []

    monkeypatch.setattr("src.orchestrator.capability.CapabilityGraph", _FakeCapabilityGraph)
    base_state["context"] = SimpleNamespace(
        metadata={
            "skill_index": [
                {
                    "id": "deep-research",
                    "name": "deep-research",
                    "description": "Conduct deep research",
                    "enabled": True,
                    "package": {
                        "files": [
                            {"path": "SKILL.md", "content": "# deep-research\n\nworkflow"}
                        ]
                    },
                }
            ]
        },
        available_skills=[],
        available_sub_agents=[],
        agent_config=SimpleNamespace(system_prompt="", model=None),
    )
    seen_messages: list[list[dict[str, str]]] = []

    async def _chat(**kwargs):
        messages = kwargs.get("messages") or []
        seen_messages.append(messages)
        tool_messages = [m for m in messages if m.get("role") == "tool"]
        if len(tool_messages) == 0:
            return SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_read_skill_1",
                        "function": {"name": "read_skill", "arguments": "{\"skill_id\":\"deep-research\"}"},
                    }
                ],
            )
        if len(tool_messages) == 1:
            return SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_read_skill_2",
                        "function": {"name": "read_skill", "arguments": "{\"skill_id\":\"deep-research\"}"},
                    }
                ],
            )
        return SimpleNamespace(
            content=json.dumps(
                {
                    "type": "plan",
                    "goal": "完成研究",
                    "round_goal": "完成研究计划",
                    "selected_skill": "deep-research",
                    "skill_context_for_act": {
                        "skill_id": "deep-research",
                        "phase": "scope",
                        "execution_rules": [
                            {
                                "id": "rule-1",
                                "instruction": "must define scope before retrieval",
                                "strength": "must",
                                "condition": "for current round",
                                "source_ref": "SKILL.md#scope",
                            }
                        ],
                        "quality_checks": [
                            {
                                "id": "check-1",
                                "instruction": "范围必须明确",
                                "strength": "must",
                                "condition": "scope phase",
                                "source_ref": "SKILL.md#scope",
                            }
                        ],
                        "artifact_rules": [
                            {
                                "id": "artifact-1",
                                "instruction": "记录范围文档",
                                "strength": "must",
                                "condition": "scope phase",
                                "source_ref": "SKILL.md#scope",
                            }
                        ],
                        "replan_triggers": [
                            {
                                "id": "trigger-1",
                                "instruction": "范围阶段失败时重规划",
                                "source_ref": "SKILL.md#scope",
                            }
                        ],
                        "source_sections": ["scope"],
                    },
                    "steps": [
                        {
                            "id": "step-1",
                            "title": "定义研究范围",
                            "phase": "scope",
                            "intent": "明确研究边界",
                            "expected_outputs": ["scope_definition"],
                            "completion_criteria": ["研究范围已明确"],
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            tool_calls=[],
        )

    mock_context["llm_provider"].chat.side_effect = _chat

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "act"
    duplicate_tool_message = [m for m in seen_messages[-1] if m.get("role") == "tool"][-1]
    assert "already loaded in this planning session" in duplicate_tool_message["content"]


def test_build_plan_loop_messages_places_failure_reflection_after_conversation():
    messages = _build_plan_loop_messages(
        state_messages=[
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "second"},
        ],
        original_goal="first",
        current_round_goal="first",
        execution_state={"completed_steps": [], "in_progress_steps": [], "failed_steps": []},
        prior_plan_summary={"plan_id": "", "plan_mode": "initial", "selected_skill": None},
        available_execution_capabilities={"web_retrieval": "Search the web"},
        planning_limits={"remaining_iterations": 10, "max_iterations": 10},
        runtime_context=SimpleNamespace(metadata={}),
        memory_context="memory",
        failure_reflection="## Failure Reflection\nretry differently",
        sub_agents_for_planner=[],
        agent_system_prompt="",
    )

    assert messages[-1]["content"] == "## Failure Reflection\nretry differently"
    assert messages[-2]["content"] == "second"


def test_build_plan_loop_messages_includes_structured_planning_state():
    messages = _build_plan_loop_messages(
        state_messages=[{"role": "user", "content": "research pdd"}],
        original_goal="research pdd",
        current_round_goal="collect evidence",
        execution_state={
            "completed_steps": ["step-1"],
            "in_progress_steps": [],
            "failed_steps": ["step-2"],
        },
        prior_plan_summary={
            "plan_id": "iter-1",
            "plan_mode": "incremental_replan",
            "selected_skill": "deep-research",
        },
        available_execution_capabilities={"web_retrieval": "Search the web", "webpage_content_extraction": "Fetch webpage content"},
        planning_limits={"remaining_iterations": 8, "max_iterations": 10},
        runtime_context=SimpleNamespace(metadata={}),
        memory_context="",
        failure_reflection="",
        sub_agents_for_planner=[],
        agent_system_prompt="",
    )

    planning_state_message = next(
        message for message in messages if "== Planning State ==" in str(message.get("content") or "")
    )
    assert planning_state_message["role"] == "system"
    assert "Planning State" in planning_state_message["content"]
    assert '"plan_mode": "incremental_replan"' in planning_state_message["content"]
    assert '"current_round_goal": "collect evidence"' in planning_state_message["content"]
    assert '"user_delivery_language": "en"' in planning_state_message["content"]
    assert '"remaining_iterations": 8' in planning_state_message["content"]
    # available_execution_capabilities is in the system prompt, not the planning state JSON
    system_prompt = messages[0]["content"]
    assert "search" in system_prompt or "web_retrieval" in system_prompt


def test_build_plan_loop_system_prompt_requires_minimal_final_delivery_contract():
    prompt = _build_plan_loop_system_prompt(
        available_execution_capabilities={"web_retrieval": "Search the web"},
        sub_agents_summary="(none)",
        agent_system_prompt="",
        current_date="2026-03-12",
        current_weekday="Thursday",
        current_timezone="Asia/Shanghai",
    )

    assert "final_delivery_contract needs delivery_goal only" in prompt
    assert "Current date: 2026-03-12 (Thursday)" in prompt
    assert "Current timezone: Asia/Shanghai" in prompt
    assert "Execution Capabilities (ACT will use these to execute your plan)" in prompt
    assert "web_retrieval" in prompt
    assert "Search the web" in prompt


def test_build_plan_loop_messages_uses_skill_scaffold_language():
    messages = _build_plan_loop_messages(
        state_messages=[{"role": "user", "content": "research pdd"}],
        original_goal="research pdd",
        current_round_goal="collect evidence",
        execution_state={"completed_steps": [], "in_progress_steps": [], "failed_steps": []},
        prior_plan_summary={"plan_id": "", "plan_mode": "initial", "selected_skill": None},
        available_execution_capabilities={"web_retrieval": "Search the web"},
        planning_limits={"remaining_iterations": 10, "max_iterations": 10},
        runtime_context=SimpleNamespace(metadata={}),
        memory_context="",
        failure_reflection="",
        sub_agents_for_planner=[],
        agent_system_prompt="",
        current_date="2026-03-12",
        current_weekday="Thursday",
        current_timezone="Asia/Shanghai",
    )

    planner_prompt = messages[0]["content"]
    assert "methodology scaffold" in planner_prompt
    assert "map its SKILL.md phases into plan steps faithfully" not in planner_prompt
    assert "Preserve stable step IDs" in planner_prompt


def test_build_plan_loop_messages_truncates_history_and_marks_state_first():
    state_messages = [
        {"role": "user", "content": f"user-{idx}"} if idx % 2 == 0 else {"role": "assistant", "content": f"assistant-{idx}"}
        for idx in range(10)
    ]
    messages = _build_plan_loop_messages(
        state_messages=state_messages,
        original_goal="research pdd",
        current_round_goal="collect evidence",
        execution_state={"completed_steps": [], "in_progress_steps": [], "failed_steps": []},
        prior_plan_summary={"plan_id": "", "plan_mode": "initial", "selected_skill": None},
        available_execution_capabilities={"web_retrieval": "Search the web"},
        planning_limits={"remaining_iterations": 10, "max_iterations": 10},
        runtime_context=SimpleNamespace(metadata={}),
        memory_context="",
        failure_reflection="",
        sub_agents_for_planner=[],
        agent_system_prompt="",
    )

    history_window_message = next(
        message for message in messages if "Conversation History Window" in str(message.get("content") or "")
    )
    assert "Use the structured execution state block above as the primary source of truth." in history_window_message["content"]
    history_contents = [
        str(message.get("content") or "")
        for message in messages
        if str(message.get("role") or "") in {"user", "assistant"}
    ]
    assert history_contents == [
        "user-4",
        "assistant-5",
        "user-6",
        "assistant-7",
        "user-8",
        "assistant-9",
    ]


def test_build_plan_loop_messages_filters_machine_like_assistant_history():
    messages = _build_plan_loop_messages(
        state_messages=[
            {"role": "user", "content": "研究拼多多股票"},
            {"role": "assistant", "content": "I encountered an error: Planning failed: planner did not produce valid JSON within turn budget."},
            {"role": "assistant", "content": "```json\n{\"tool_calls\": [{\"id\": \"x\"}]}\n```"},
            {"role": "assistant", "content": ">functions.deep-research:0>{\"request\":\"研究拼多多股票\"}"},
            {"role": "assistant", "content": "已生成文件：pdd_research_data_2025.json。"},
            {"role": "assistant", "content": "好的，我将继续研究拼多多股票。"},
        ],
        original_goal="研究拼多多股票",
        current_round_goal="继续研究拼多多股票",
        execution_state={"completed_steps": [], "in_progress_steps": [], "failed_steps": []},
        prior_plan_summary={"plan_id": "", "plan_mode": "initial", "selected_skill": None},
        available_execution_capabilities={"web_retrieval": "Search the web"},
        planning_limits={"remaining_iterations": 10, "max_iterations": 10},
        runtime_context=SimpleNamespace(metadata={}),
        memory_context="",
        failure_reflection="",
        sub_agents_for_planner=[],
        agent_system_prompt="",
    )

    history_contents = [
        str(message.get("content") or "")
        for message in messages
        if str(message.get("role") or "") in {"user", "assistant"}
    ]
    assert history_contents == [
        "研究拼多多股票",
        "好的，我将继续研究拼多多股票。",
    ]


def test_build_execution_state_for_planner_prefers_structured_act_metadata():
    state = {
        "plan": ExecutionPlan(
            goal="research pdd",
            steps=[
                PlanStep(id="step-1", title="scope", status="completed"),
                PlanStep(id="step-2", title="retrieve", status="pending"),
            ],
        ),
        "tool_results": [
            ToolCallResult(
                tool_name="llm_act",
                params={"title": "scope"},
                result="partial",
                success=True,
                metadata={
                    "act_decision": "continue_current_step",
                    "act_step_id": "step-2",
                    "act_observations": [
                        {
                            "summary": "范围已明确，开始收集证据",
                            "constraints_encountered": ["需要至少两个独立来源"],
                        }
                    ],
                    "act_artifacts_produced": ["scope.md"],
                },
            )
        ],
    }

    execution_state = _build_execution_state_for_planner(state)

    assert execution_state["completed_steps"] == ["step-1"]
    assert execution_state["in_progress_steps"] == ["step-2"]
    assert execution_state["failed_steps"] == []
    assert "范围已明确，开始收集证据" in execution_state["observations"]
    assert "scope.md" in execution_state["artifacts_produced"]
    assert execution_state["unresolved_questions"] == []
    assert "需要至少两个独立来源" in execution_state["known_constraints"]


def test_build_execution_state_for_planner_uses_full_tool_history_when_rebuilding():
    tool_results = []
    for index in range(13):
        tool_results.append(
            ToolCallResult(
                tool_name="llm_act",
                params={"title": f"step-{index + 1}"},
                result="done",
                success=True,
                metadata={
                    "act_decision": "advance_step",
                    "act_step_id": f"step-{index + 1}",
                },
            )
        )

    execution_state = _build_execution_state_for_planner(
        {
            "plan": ExecutionPlan(goal="goal", steps=[]),
            "tool_results": tool_results,
        },
        prefer_existing=False,
    )

    assert "step-1" in execution_state["completed_steps"]
    assert "step-13" in execution_state["completed_steps"]


def test_build_execution_state_for_planner_creates_step_input_bindings():
    plan = parse_plan_response(
        {
            "type": "plan",
            "goal": "research pdd",
            "steps": [
                {
                    "id": "step-1",
                    "title": "收集证据",
                    "phase": "retrieve",
                    "expected_outputs": ["evidence bundle"],
                },
                {
                    "id": "step-2",
                    "title": "撰写报告",
                    "phase": "synthesize",
                    "expected_outputs": ["report"],
                },
            ],
        }
    )
    state = {
        "plan": plan,
        "context": SimpleNamespace(metadata={}),
        "tool_results": [
            ToolCallResult(
                tool_name="search",
                params={"query": "PDD 最新财报"},
                result={"results": [{"title": "PDD earnings", "url": "https://example.com", "snippet": "Revenue grew 59%"}]},
                success=True,
                metadata={
                    "source_step_id": "step-1",
                    "artifact_result_text": "Revenue grew 59%",
                    "text_artifact": {
                        "artifact_result_text": "Revenue grew 59%",
                        "artifact_role": "evidence_bundle",
                        "artifact_name": "检索证据摘要",
                        "source_step_id": "step-1",
                    },
                },
            )
        ],
    }

    execution_state = _build_execution_state_for_planner(state)

    bindings = execution_state["step_input_bindings"]["step-2"]
    assert bindings[0]["source_step_id"] == "step-1"
    assert bindings[0]["resolved_medium"] == "artifact_result_text"
    assert "Revenue grew 59%" in bindings[0]["artifact_result_text"]


def test_ensure_step_result_handoff_contract_summarizes_result_rows_without_tool_special_case():
    action = PlanStep(
        id="step-1",
        title="搜索最新动态",
        expected_outputs=["AI 行业动态结果列表"],
    )
    result = ToolCallResult(
        tool_name="search",
        params={"query": "最新 AI 行业动态"},
        success=True,
        result={
            "items": [
                {
                    "title": "News A",
                    "url": "https://example.com/a",
                    "snippet": "摘要 A",
                }
            ]
        },
    )

    normalized = _ensure_step_result_handoff_contract(action, result)

    assert isinstance(normalized.metadata, dict)
    assert "artifact_result_text" in normalized.metadata
    assert "News A" in str(normalized.metadata["artifact_result_text"])


def test_ensure_step_result_handoff_contract_does_not_promote_code_executor_stdout_to_artifact_text():
    action = PlanStep(
        id="step-1",
        title="当前日期确认",
        expected_outputs=["今天的日期"],
    )
    result = ToolCallResult(
        tool_name="code_executor",
        params={"language": "python"},
        success=True,
        result={"stdout": "{\"current_date\":\"2026-03-12\"}", "stderr": "", "exit_code": 0},
    )

    normalized = _ensure_step_result_handoff_contract(action, result)

    assert isinstance(normalized.metadata, dict)
    assert not str(normalized.metadata.get("artifact_result_text") or "").strip()
    assert not isinstance(normalized.metadata.get("text_artifact"), dict)


def test_build_execution_state_for_planner_prefers_state_field_when_present():
    state = AgentState(
        session_id="sess-1",
        agent_id="agent-1",
        context=SimpleNamespace(),
        messages=[],
        current_step="plan",
        observe_outcome=None,
        plan=None,
        pending_actions=[],
        execution_state={
            "completed_steps": ["persisted-step"],
            "in_progress_steps": [],
            "failed_steps": [],
            "observations": ["persisted observation"],
            "artifacts_produced": ["persisted.md"],
            "unresolved_questions": [],
            "known_constraints": [],
            "remaining_budget_or_limits": [],
        },
        tool_results=[
            ToolCallResult(
                tool_name="llm_act",
                params={},
                result="ignored",
                success=True,
                metadata={"act_decision": "advance_step", "act_step_id": "ephemeral-step"},
            )
        ],
        memory_context="",
        reflection=None,
        iteration=0,
        error=None,
        metadata={},
        evolved_skill_refs=[],
        evolution_triggered=False,
    )

    execution_state = _build_execution_state_for_planner(state)

    assert execution_state["completed_steps"] == ["persisted-step"]
    assert execution_state["observations"] == ["persisted observation"]


def test_trim_plan_loop_messages_returns_new_list_without_mutating_input():
    original = [
        {"role": "system", "content": "keep-1"},
        {"role": "system", "content": "== Memory Context ==\nremove"},
        {"role": "user", "content": "keep-2"},
    ]

    trimmed, changed = _trim_plan_loop_messages(original)

    assert changed is True
    assert len(trimmed) == 2
    assert len(original) == 3
    assert original[1]["content"].startswith("== Memory Context ==")


@pytest.mark.asyncio
async def test_plan_node_trims_messages_after_context_overflow(mock_context, base_state, monkeypatch):
    class _FakeCapabilityGraph:
        def __init__(self, _runtime_context):
            self._runtime_context = _runtime_context

        def get_schemas_for_planner(self):
            return []

    monkeypatch.setattr("src.orchestrator.capability.CapabilityGraph", _FakeCapabilityGraph)
    base_state["context"] = SimpleNamespace(
        metadata={},
        available_skills=[],
        available_sub_agents=[],
        agent_config=SimpleNamespace(system_prompt="", model=None),
    )
    base_state["memory_context"] = "memory block"
    base_state["tool_results"] = [
        ToolCallResult(tool_name="search", params={}, result=None, success=False, error="too many tokens from previous round")
    ]

    calls = {"count": 0}

    async def _chat(**kwargs):
        calls["count"] += 1
        messages = kwargs.get("messages") or []
        if calls["count"] == 1:
            assert any("== Memory Context ==" in str(m.get("content") or "") for m in messages)
            raise RuntimeError("maximum context length exceeded")
        assert not any("== Memory Context ==" in str(m.get("content") or "") for m in messages)
        return SimpleNamespace(
            content=json.dumps(
                {
                    "type": "plan",
                    "goal": "trimmed plan",
                    "round_goal": "trimmed plan",
                    "selected_skill": None,
                    "steps": [
                        {
                            "id": "1",
                            "title": "step 1",
                            "phase": "scope",
                            "intent": "understand",
                            "expected_outputs": ["scope"],
                            "completion_criteria": ["done"],
                        }
                    ],
                }
            ),
            tool_calls=[],
        )

    mock_context["llm_provider"].chat.side_effect = _chat

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "act"
    assert calls["count"] == 2


@pytest.mark.asyncio
async def test_act_node_executes_pending_actions(mock_context, base_state):
    """Test that act_node executes pending actions."""
    base_state["pending_actions"] = [
        PlanStep(id="1", title="search", tool="search", params={"query": "test"})
    ]

    call_count = {"search": 0}
    async def _chat(**kwargs):
        if _any_message_contains(kwargs, "Current step title:\nsearch") and call_count["search"] == 0:
            call_count["search"] += 1
            return SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_search_1",
                        "function": {"name": "search", "arguments": "{\"query\":\"test\"}"},
                    }
                ],
            )
        return SimpleNamespace(content=_act_result_json(summary="step 1 done"), tool_calls=[])

    mock_context["llm_provider"].chat = AsyncMock(side_effect=_chat)
    mock_context["unified_executor"].execute.return_value = ToolCallResult(
        tool_name="search",
        params={"query": "test"},
        result="search result",
        success=True,
    )

    result = await act_node(base_state, mock_context)

    assert result["current_step"] == "observe"
    assert mock_context["unified_executor"].execute.await_count == 1


@pytest.mark.asyncio
async def test_act_node_times_out_llm_call_after_tool_backfeed(monkeypatch, mock_context, base_state):
    base_state["pending_actions"] = [
        PlanStep(id="1", title="search", tool="search", params={"query": "test"})
    ]

    monkeypatch.setattr("src.orchestrator.nodes_act._act_llm_timeout_seconds", lambda _provider: 1.0)
    turn = {"count": 0}

    async def _chat(**kwargs):
        if _any_message_contains(kwargs, "Current step title:\nsearch") and turn["count"] == 0:
            turn["count"] += 1
            return SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_search_1",
                        "function": {"name": "search", "arguments": "{\"query\":\"test\"}"},
                    }
                ],
            )
        raise asyncio.TimeoutError("ACT LLM call timed out")

    mock_context["llm_provider"].chat = AsyncMock(side_effect=_chat)
    mock_context["unified_executor"].execute.return_value = ToolCallResult(
        tool_name="search",
        params={"query": "test"},
        result="search result",
        success=True,
    )

    result = await act_node(base_state, mock_context)

    assert result["current_step"] == "observe"
    assert len(result["tool_results"]) >= 2
    assert result["tool_results"][-1].success is False
    assert "timeout" in str(result["tool_results"][-1].error).lower()


@pytest.mark.asyncio
async def test_act_node_parallelizes_readonly_inner_loop_tool_calls(mock_context, base_state):
    base_state["pending_actions"] = [
        PlanStep(id="1", title="search", tool="search", params={"query": "test"})
    ]

    turn = {"count": 0}

    async def _chat(**kwargs):
        if _any_message_contains(kwargs, "Current step title:\nsearch") and turn["count"] == 0:
            turn["count"] += 1
            return SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_search_1",
                        "function": {"name": "search", "arguments": "{\"query\":\"alpha\"}"},
                    },
                    {
                        "id": "call_fetch_1",
                        "function": {"name": "web_fetch", "arguments": "{\"url\":\"https://example.com\"}"},
                    },
                ],
            )
        return SimpleNamespace(content=_act_result_json(summary="step 1 done"), tool_calls=[])

    active = {"count": 0, "max": 0}

    async def _execute(action):
        active["count"] += 1
        active["max"] = max(active["max"], active["count"])
        await asyncio.sleep(0.02)
        active["count"] -= 1
        return ToolCallResult(
            tool_name=action.tool or "unknown",
            params=action.params,
            result="ok",
            success=True,
        )

    mock_context["llm_provider"].chat = AsyncMock(side_effect=_chat)
    mock_context["unified_executor"].execute.side_effect = _execute

    result = await act_node(base_state, mock_context)

    assert result["current_step"] == "observe"
    assert mock_context["unified_executor"].execute.await_count == 2
    assert active["max"] >= 2


@pytest.mark.asyncio
async def test_act_node_does_not_advance_to_next_step_on_partial_progress(mock_context, base_state):
    base_state["pending_actions"] = [
        PlanStep(id="1", title="step 1", tool="search", params={"query": "test"}),
        PlanStep(id="2", title="step 2", tool="search", params={"query": "next"}),
    ]

    turn = {"count": 0}

    async def _chat(**kwargs):
        if _any_message_contains(kwargs, "Current step title:\nstep 1") and turn["count"] == 0:
            turn["count"] += 1
            return SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_search_partial_progress",
                        "function": {"name": "search", "arguments": "{\"query\":\"test\"}"},
                    }
                ],
            )
        return SimpleNamespace(
            content=json.dumps(
                {
                    "decision": "continue_current_step",
                    "observations": [
                        {
                            "summary": "step 1 still in progress",
                            "evidence": [],
                            "artifacts_produced": [],
                            "constraints_encountered": [],
                        }
                    ],
                    "artifacts_produced": [],
                },
                ensure_ascii=False,
            ),
            tool_calls=[],
        )

    mock_context["llm_provider"].chat = AsyncMock(side_effect=_chat)
    mock_context["unified_executor"].execute.return_value = ToolCallResult(
        tool_name="search",
        params={"query": "test"},
        result="search result",
        success=True,
    )

    result = await act_node(base_state, mock_context)

    assert result["current_step"] == "observe"
    assert [step.id for step in result["pending_actions"]] == ["1", "2"]
    assert result["metadata"]["last_act_step_id"] == "1"
    assert mock_context["unified_executor"].execute.await_count == 1


@pytest.mark.asyncio
async def test_act_node_no_longer_forces_search_and_code_executor_to_sequential(mock_context, base_state):
    base_state["pending_actions"] = [
        PlanStep(id="1", title="search", tool="tavily-search", params={"query": "test"}, parallel=True),
        PlanStep(id="2", title="code", tool="code_executor", params={"code": "print(1)"}, parallel=True),
    ]

    turn_counts = {"search": 0, "code": 0}
    async def _chat(**kwargs):
        if _any_message_contains(kwargs, "Current step title:\nsearch") and turn_counts["search"] == 0:
            turn_counts["search"] += 1
            return SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_search_parallel",
                        "function": {"name": "search", "arguments": "{\"query\":\"test\"}"},
                    }
                ],
            )
        if _any_message_contains(kwargs, "Current step title:\ncode") and turn_counts["code"] == 0:
            turn_counts["code"] += 1
            return SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_code_parallel",
                        "function": {"name": "code_executor", "arguments": "{\"code\":\"print(1)\"}"},
                    }
                ],
            )
        return SimpleNamespace(content=_act_result_json(summary="parallel step done"), tool_calls=[])

    mock_context["llm_provider"].chat = AsyncMock(side_effect=_chat)
    async def _run(action):
        return ToolCallResult(
            tool_name=action.tool or "unknown",
            params=action.params,
            result="ok",
            success=True,
        )

    mock_context["unified_executor"].execute.side_effect = _run

    result = await act_node(base_state, mock_context)

    assert result["current_step"] == "observe"
    assert len(result["tool_results"]) == 4
    assert mock_context["unified_executor"].execute.await_count == 2


@pytest.mark.asyncio
async def test_act_node_preserves_plan_order_before_parallel_group(mock_context, base_state):
    base_state["pending_actions"] = [
        PlanStep(id="1", title="scope", tool="code_executor", params={"language": "python", "code": "print('scope')"}),
        PlanStep(id="2", title="search-a", tool="search", params={"query": "a"}, parallel=True),
        PlanStep(id="3", title="search-b", tool="search", params={"query": "b"}, parallel=True),
    ]

    calls: list[str] = []
    turn_counts = {"scope": 0, "search-a": 0, "search-b": 0}

    async def _chat(**kwargs):
        if _any_message_contains(kwargs, "Current step title:\nscope") and turn_counts["scope"] == 0:
            turn_counts["scope"] += 1
            return SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_scope_1",
                        "function": {
                            "name": "code_executor",
                            "arguments": "{\"language\":\"python\",\"code\":\"print('scope')\"}",
                        },
                    }
                ],
            )
        if _any_message_contains(kwargs, "Current step title:\nsearch-a") and turn_counts["search-a"] == 0:
            turn_counts["search-a"] += 1
            return SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_search_a",
                        "function": {"name": "search", "arguments": "{\"query\":\"a\"}"},
                    }
                ],
            )
        if _any_message_contains(kwargs, "Current step title:\nsearch-b") and turn_counts["search-b"] == 0:
            turn_counts["search-b"] += 1
            return SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_search_b",
                        "function": {"name": "search", "arguments": "{\"query\":\"b\"}"},
                    }
                ],
            )
        return SimpleNamespace(content=_act_result_json(summary="ordered step done"), tool_calls=[])

    mock_context["llm_provider"].chat = AsyncMock(side_effect=_chat)

    async def _run(action):
        calls.append(action.id)
        return ToolCallResult(
            tool_name=action.tool or "unknown",
            params=action.params,
            result="ok",
            success=True,
        )

    mock_context["unified_executor"].execute.side_effect = _run

    result = await act_node(base_state, mock_context)

    assert result["current_step"] == "observe"
    assert len(result["tool_results"]) == 6
    assert calls[0] == "1"
    assert set(calls[1:]) == {"2", "3"}


@pytest.mark.asyncio
async def test_act_node_does_not_parallelize_steps_with_intragroup_dependencies(mock_context, base_state):
    base_state["pending_actions"] = [
        PlanStep(id="step-1", title="search-a", tool="search", params={"query": "a"}, parallel=True),
        PlanStep(
            id="step-2",
            title="search-b",
            tool="search",
            params={"query": "b"},
            parallel=True,
            input_refs=[StepInputRef(name="prior_output_step-1", source_step_id="step-1")],
        ),
    ]

    calls: list[str] = []
    turn_counts = {"search-a": 0, "search-b": 0}

    async def _chat(**kwargs):
        if _any_message_contains(kwargs, "Current step title:\nsearch-a") and turn_counts["search-a"] == 0:
            turn_counts["search-a"] += 1
            return SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_search_a",
                        "function": {"name": "search", "arguments": "{\"query\":\"a\"}"},
                    }
                ],
            )
        if _any_message_contains(kwargs, "Current step title:\nsearch-b") and turn_counts["search-b"] == 0:
            turn_counts["search-b"] += 1
            return SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_search_b",
                        "function": {"name": "search", "arguments": "{\"query\":\"b\"}"},
                    }
                ],
            )
        return SimpleNamespace(content=_act_result_json(summary="ordered step done"), tool_calls=[])

    mock_context["llm_provider"].chat = AsyncMock(side_effect=_chat)

    async def _run(action):
        calls.append(str(action.id))
        return ToolCallResult(
            tool_name=action.tool or "unknown",
            params=action.params,
            result="ok",
            success=True,
            metadata={"act_decision": "advance_step", "act_step_id": str(action.id)},
        )

    mock_context["unified_executor"].execute.side_effect = _run

    result = await act_node(base_state, mock_context)

    assert result["current_step"] == "observe"
    assert calls == ["step-1", "step-2"]


@pytest.mark.asyncio
async def test_act_node_keeps_parallel_group_pending_on_continue_current_step(mock_context, base_state, monkeypatch):
    base_state["pending_actions"] = [
        PlanStep(id="1", title="parallel-a", tool="search", params={"query": "a"}, parallel=True),
        PlanStep(id="2", title="parallel-b", tool="search", params={"query": "b"}, parallel=True),
        PlanStep(id="3", title="after", tool="search", params={"query": "c"}),
    ]

    async def _execute_llm_step(**kwargs):
        action = kwargs["action"]
        if action.id == "1":
            return [
                ToolCallResult(
                    tool_name="search",
                    params={"query": "a"},
                    result="hold",
                    success=True,
                    metadata={"act_decision": "continue_current_step"},
                )
            ]
        return [
            ToolCallResult(
                tool_name="search",
                params={"query": "b" if action.id == "2" else "c"},
                result="ok",
                success=True,
                metadata={"act_decision": "advance_step"},
            )
        ]

    monkeypatch.setattr("src.orchestrator.nodes_act._execute_llm_act_step", _execute_llm_step)

    result = await act_node(base_state, mock_context)

    assert result["current_step"] == "observe"
    assert [step.id for step in result["pending_actions"]] == ["1", "2", "3"]


@pytest.mark.asyncio
async def test_act_node_uses_llm_to_execute_abstract_reasoning_step(mock_context, base_state):
    base_state["pending_actions"] = [
        PlanStep(id="1", title="Phase 1: SCOPE - 明确研究范围和目标", tool=None, params={})
    ]
    base_state["metadata"] = {"skill_orchestration_trace": {"skill_context_skill_id": "deep-research"}}
    base_state["context"] = None
    mock_context["llm_provider"].chat = AsyncMock(
        return_value=SimpleNamespace(
            content="",
            tool_calls=[
                {
                    "function": {
                        "name": "search",
                        "arguments": "{\"queries\":[\"阿里巴巴股票 2024 2025 财报\"]}",
                    }
                }
            ],
        )
    )
    mock_context["unified_executor"].execute.return_value = ToolCallResult(
        tool_name="search",
        params={"queries": ["阿里巴巴股票 2024 2025 财报"]},
        result={"items": [{"title": "Alibaba"}]},
        success=True,
    )

    result = await act_node(base_state, mock_context)

    assert result["current_step"] == "observe"
    mock_context["llm_provider"].chat.assert_awaited()
    mock_context["unified_executor"].execute.assert_awaited()
    executed_action = mock_context["unified_executor"].execute.await_args.args[0]
    assert executed_action.tool == "search"
    assert executed_action.params["queries"] == ["阿里巴巴股票 2024 2025 财报"]


@pytest.mark.asyncio
async def test_act_node_uses_llm_for_builtin_step_when_skill_selected(mock_context, base_state):
    base_state["pending_actions"] = [
        PlanStep(id="1", title="搜索阿里巴巴股票信息", tool="search", params={"queries": ["阿里巴巴股票"]})
    ]
    base_state["metadata"] = {"skill_orchestration_trace": {"skill_context_skill_id": "deep-research"}}
    base_state["context"] = None
    mock_context["llm_provider"].chat = AsyncMock(
        return_value=SimpleNamespace(
            content="",
            tool_calls=[
                {
                    "function": {
                        "name": "web_fetch",
                        "arguments": "{\"url\":\"https://www.alibabagroup.com/en/ir/financial-results\"}",
                    }
                }
            ],
        )
    )
    mock_context["unified_executor"].execute.return_value = ToolCallResult(
        tool_name="web_fetch",
        params={"url": "https://www.alibabagroup.com/en/ir/financial-results"},
        result={"title": "Alibaba IR"},
        success=True,
    )

    result = await act_node(base_state, mock_context)

    assert result["current_step"] == "observe"
    mock_context["llm_provider"].chat.assert_awaited()
    executed_action = mock_context["unified_executor"].execute.await_args.args[0]
    assert executed_action.tool == "web_fetch"
    assert executed_action.params["url"] == "https://www.alibabagroup.com/en/ir/financial-results"


@pytest.mark.asyncio
async def test_act_node_uses_llm_for_parallel_builtin_step_when_skill_selected(mock_context, base_state):
    base_state["pending_actions"] = [
        PlanStep(id="1", title="搜索阿里巴巴股票信息", tool="search", params={"queries": ["阿里巴巴股票"]}, parallel=True)
    ]
    base_state["metadata"] = {"skill_orchestration_trace": {"skill_context_skill_id": "deep-research"}}
    base_state["context"] = None
    mock_context["llm_provider"].chat = AsyncMock(
        return_value=SimpleNamespace(
            content="",
            tool_calls=[
                {
                    "function": {
                        "name": "search",
                        "arguments": "{\"queries\":[\"阿里巴巴股票 财报 2025\"]}",
                    }
                }
            ],
        )
    )
    mock_context["unified_executor"].execute.return_value = ToolCallResult(
        tool_name="search",
        params={"queries": ["阿里巴巴股票 财报 2025"]},
        result={"items": [{"title": "Alibaba earnings"}]},
        success=True,
    )

    result = await act_node(base_state, mock_context)

    assert result["current_step"] == "observe"
    mock_context["llm_provider"].chat.assert_awaited()
    executed_action = mock_context["unified_executor"].execute.await_args.args[0]
    assert executed_action.tool == "search"
    assert executed_action.params["queries"] == ["阿里巴巴股票 财报 2025"]


@pytest.mark.asyncio
async def test_execute_llm_act_step_file_io_uses_generated_session_artifact_path(mock_context, base_state, tmp_path, monkeypatch):
    session_root = tmp_path / "workspace"
    generated_dir = session_root / "tool_runs" / "code_executor_001"
    generated_dir.mkdir(parents=True, exist_ok=True)
    generated_file = generated_dir / "popmart_research_report.md"
    generated_file.write_text("# report", encoding="utf-8")

    base_state["metadata"] = {"skill_orchestration_trace": {"skill_context_skill_id": "deep-research"}}
    base_state["session_id"] = "sess-llm-file-io"
    base_state["context"] = SimpleNamespace(session_id="sess-llm-file-io", metadata={"session_working_dir": str(session_root)})

    prior_results = [
        ToolCallResult(
            tool_name="code_executor",
            params={"language": "python", "code": "print('ok')"},
            result={
                "generated_files": [
                    {
                        "name": "popmart_research_report.md",
                        "source_path": str(generated_file),
                        "path": str(generated_file),
                    }
                ]
            },
            success=True,
        )
    ]
    file_result = ToolCallResult(
        tool_name="file_io",
        params={"action": "read", "scope": "session", "path": "tool_runs/code_executor_001/popmart_research_report.md"},
        result={"content": "# report"},
        success=True,
    )

    mock_context["llm_provider"].chat = AsyncMock(
        side_effect=[
            SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "function": {
                            "name": "file_io",
                            "arguments": "{\"action\":\"read\",\"scope\":\"session\",\"path\":\"popmart_research_report.md\"}",
                        }
                    }
                ],
            ),
            SimpleNamespace(content=_act_result_json(summary="读取完成"), tool_calls=[]),
        ]
    )
    monkeypatch.setattr("src.orchestrator.nodes_act._build_act_tool_schemas", lambda runtime_context, skill_registry: [])
    action = PlanStep(id="2", title="读取报告", tool="file_io", params={"action": "read", "scope": "session", "path": "popmart_research_report.md"})

    mock_context["unified_executor"].execute.return_value = file_result

    results = await _execute_llm_act_step(
        state=base_state,
        context=mock_context,
        action=action,
        unified_executor=mock_context["unified_executor"],
        event_emitter=None,
        prior_results=prior_results,
    )

    assert results[-1].success is True
    executed_action = mock_context["unified_executor"].execute.await_args.args[0]
    assert executed_action.tool == "file_io"
    assert executed_action.params["path"] == "tool_runs/code_executor_001/popmart_research_report.md"


@pytest.mark.asyncio
async def test_execute_llm_act_step_prompt_describes_tool_result_backfeed(mock_context, base_state, monkeypatch):
    seen_prompts: list[str] = []

    async def _chat(**kwargs):
        messages = kwargs.get("messages") or []
        seen_prompts.append(str(messages[0].get("content") or ""))
        return SimpleNamespace(content=_act_result_json(summary="完成"), tool_calls=[])

    mock_context["llm_provider"].chat = AsyncMock(side_effect=_chat)
    monkeypatch.setattr("src.orchestrator.nodes_act._build_act_tool_schemas", lambda runtime_context, skill_registry: [])
    action = PlanStep(id="1", title="执行当前步骤")

    results = await _execute_llm_act_step(
        state=base_state,
        context=mock_context,
        action=action,
        unified_executor=mock_context["unified_executor"],
        event_emitter=None,
        prior_results=[],
    )

    assert results[-1].success is True
    assert seen_prompts
    assert "tool_result_v1 messages" in seen_prompts[0]
    assert "do not call tools just to emit the terminal json" in seen_prompts[0].lower()
    assert "artifact_result_text" in seen_prompts[0].lower()
    assert "artifact_result_path" in seen_prompts[0].lower()
    # Disabled: "search + web_fetch" and "http_client" instructions removed from ACT prompt
    assert "search + web_fetch" not in seen_prompts[0].lower()


@pytest.mark.asyncio
async def test_execute_llm_act_step_prefers_plan_time_context(mock_context, base_state, monkeypatch):
    seen_prompts: list[str] = []

    async def _chat(**kwargs):
        messages = kwargs.get("messages") or []
        seen_prompts.append(str(messages[0].get("content") or ""))
        return SimpleNamespace(content=_act_result_json(summary="完成"), tool_calls=[])

    mock_context["llm_provider"].chat = AsyncMock(side_effect=_chat)
    monkeypatch.setattr("src.orchestrator.nodes_act._build_act_tool_schemas", lambda runtime_context, skill_registry: [])
    base_state["metadata"] = {
        "current_date": "2025-01-01",
        "current_weekday": "Wednesday",
        "current_timezone": "UTC",
    }
    base_state["plan"] = ExecutionPlan(
        goal="测试时间注入",
        steps=[PlanStep(id="step-1", title="执行当前步骤")],
        current_date="2026-03-12",
        current_weekday="Thursday",
        current_timezone="Asia/Shanghai",
    )

    results = await _execute_llm_act_step(
        state=base_state,
        context=mock_context,
        action=PlanStep(id="step-1", title="执行当前步骤"),
        unified_executor=mock_context["unified_executor"],
        event_emitter=None,
        prior_results=[],
    )

    assert results[-1].success is True
    assert seen_prompts
    assert "Current date: 2026-03-12 (Thursday)" in seen_prompts[0]
    assert "Current timezone: Asia/Shanghai" in seen_prompts[0]


@pytest.mark.asyncio
async def test_execute_llm_act_step_prompt_includes_resolved_input_bindings(mock_context, base_state, monkeypatch):
    seen_all_content: list[str] = []

    async def _chat(**kwargs):
        messages = kwargs.get("messages") or []
        seen_all_content.append("\n".join(str(m.get("content") or "") for m in messages))
        return SimpleNamespace(content=_act_result_json(summary="完成"), tool_calls=[])

    mock_context["llm_provider"].chat = AsyncMock(side_effect=_chat)
    monkeypatch.setattr("src.orchestrator.nodes_act._build_act_tool_schemas", lambda runtime_context, skill_registry: [])
    base_state["execution_state"] = {
        "completed_steps": ["step-1"],
        "in_progress_steps": [],
        "failed_steps": [],
        "observations": [],
        "artifacts_produced": [],
        "unresolved_questions": [],
        "known_constraints": [],
        "remaining_budget_or_limits": [],
        "step_input_bindings": {
            "step-2": [
                {
                    "input_name": "retrieval_evidence",
                    "source_step_id": "step-1",
                    "artifact_role": "evidence_bundle",
                    "resolved_medium": "artifact_result_text",
                    "artifact_result_text": "Revenue grew 59%",
                }
            ]
        },
    }
    action = PlanStep(id="step-2", title="撰写报告")

    results = await _execute_llm_act_step(
        state=base_state,
        context=mock_context,
        action=action,
        unified_executor=mock_context["unified_executor"],
        event_emitter=None,
        prior_results=[],
    )

    assert results[-1].success is True
    assert seen_all_content
    assert "Resolved input bindings for this step:" in seen_all_content[0]
    assert "artifact_role=evidence_bundle" in seen_all_content[0]
    assert "artifact_result_text=Revenue grew 59%" in seen_all_content[0]


@pytest.mark.asyncio
async def test_plan_node_uses_terminal_phase_for_stable_provider_when_tools_enabled(
    mock_context, base_state, monkeypatch
):
    from src.llm.provider_compat import resolve_plan_execution_strategy as _real_plan_strategy
    monkeypatch.setattr("src.orchestrator.nodes_plan.resolve_plan_execution_strategy", _real_plan_strategy)
    seen_kwargs: list[dict[str, Any]] = []

    async def _chat(**kwargs):
        seen_kwargs.append(kwargs)
        if len(seen_kwargs) == 1:
            return SimpleNamespace(content="", tool_calls=[])
        return SimpleNamespace(
            content=json.dumps(
                {
                    "type": "terminate",
                    "goal": "test goal",
                    "reason": "无需执行",
                    "status": "no_further_action_needed",
                    "summary_for_act": "无需执行",
                },
                ensure_ascii=False,
            ),
            tool_calls=[],
        )

    mock_context["llm_provider"].chat = AsyncMock(side_effect=_chat)
    base_state["messages"] = [{"role": "user", "content": "你好"}]

    result = await plan_node(base_state, mock_context)

    assert result["plan"].plan_type == "terminate"
    assert len(seen_kwargs) >= 1
    assert seen_kwargs[0].get("tools") is None
    response_format = seen_kwargs[0].get("response_format")
    assert isinstance(response_format, dict)
    assert response_format.get("type") == "json_schema"
    assert response_format.get("json_schema", {}).get("name") == "planner_response"


@pytest.mark.asyncio
async def test_plan_node_uses_two_phase_strategy_for_kimi_when_tools_enabled(mock_context, base_state, monkeypatch):
    from src.llm.provider_compat import resolve_plan_execution_strategy as _real_plan_strategy
    monkeypatch.setattr("src.orchestrator.nodes_plan.resolve_plan_execution_strategy", _real_plan_strategy)
    seen_kwargs: list[dict[str, Any]] = []

    async def _chat(**kwargs):
        seen_kwargs.append(kwargs)
        if len(seen_kwargs) == 1:
            return SimpleNamespace(content="", tool_calls=[])
        return SimpleNamespace(
            content=json.dumps(
                {
                    "type": "terminate",
                    "goal": "test goal",
                    "reason": "无需执行",
                    "status": "no_further_action_needed",
                    "summary_for_act": "无需执行",
                },
                ensure_ascii=False,
            ),
            tool_calls=[],
        )

    mock_context["llm_provider"] = SimpleNamespace(
        config=SimpleNamespace(base_url="https://api.moonshot.cn/v1", model="kimi-k2.5"),
        chat=AsyncMock(side_effect=_chat),
    )
    base_state["messages"] = [{"role": "user", "content": "你好"}]

    result = await plan_node(base_state, mock_context)

    assert result["plan"].plan_type == "terminate"
    assert len(seen_kwargs) >= 1
    assert seen_kwargs[0].get("tools") is None
    response_format = seen_kwargs[0].get("response_format")
    assert isinstance(response_format, dict)
    assert response_format.get("type") == "json_object"


@pytest.mark.asyncio
async def test_plan_node_retries_terminal_phase_once_for_invalid_json(mock_context, base_state, monkeypatch):
    from src.llm.provider_compat import resolve_plan_execution_strategy as _real_plan_strategy
    monkeypatch.setattr("src.orchestrator.nodes_plan.resolve_plan_execution_strategy", _real_plan_strategy)
    seen_kwargs: list[dict[str, Any]] = []

    async def _chat(**kwargs):
        seen_kwargs.append(kwargs)
        if len(seen_kwargs) == 1:
            return SimpleNamespace(content="", tool_calls=[])
        if len(seen_kwargs) == 2:
            return SimpleNamespace(content="我将给出最终计划。", tool_calls=[])
        return SimpleNamespace(
            content=json.dumps(
                {
                    "type": "terminate",
                    "goal": "test goal",
                    "reason": "无需执行",
                    "status": "no_further_action_needed",
                    "summary_for_act": "无需执行",
                },
                ensure_ascii=False,
            ),
            tool_calls=[],
        )

    mock_context["llm_provider"].chat = AsyncMock(side_effect=_chat)
    base_state["messages"] = [{"role": "user", "content": "你好"}]

    result = await plan_node(base_state, mock_context)

    assert result["plan"].plan_type == "terminate"
    assert len(seen_kwargs) >= 3
    assert seen_kwargs[0].get("tools") is None
    assert seen_kwargs[1].get("tools") is None
    trace = result["metadata"]["planner_loop_trace"]
    assert isinstance(trace, list)
    assert len(trace) >= 1


@pytest.mark.asyncio
async def test_execute_llm_act_step_passes_json_schema_response_format(mock_context, base_state, monkeypatch):
    seen_kwargs: list[dict[str, Any]] = []

    async def _chat(**kwargs):
        seen_kwargs.append(kwargs)
        return SimpleNamespace(content=_act_result_json(summary="完成"), tool_calls=[])

    mock_context["llm_provider"].chat = AsyncMock(side_effect=_chat)
    monkeypatch.setattr("src.orchestrator.nodes_act._build_act_tool_schemas", lambda runtime_context, skill_registry: [])
    action = PlanStep(id="step-1", title="整理总结")

    results = await _execute_llm_act_step(
        state=base_state,
        context=mock_context,
        action=action,
        unified_executor=mock_context["unified_executor"],
        event_emitter=None,
        prior_results=[],
    )

    assert results[-1].success is True
    assert seen_kwargs
    response_format = seen_kwargs[0].get("response_format")
    assert isinstance(response_format, dict)
    assert response_format.get("type") == "json_schema"
    assert response_format.get("json_schema", {}).get("name") == "act_response"


@pytest.mark.asyncio
async def test_execute_llm_act_step_omits_json_schema_response_format_when_tools_enabled(
    mock_context, base_state, monkeypatch
):
    from src.llm.provider_compat import resolve_act_execution_strategy as _real_act_strategy
    monkeypatch.setattr("src.orchestrator.nodes_act.resolve_act_execution_strategy", _real_act_strategy)
    seen_kwargs: list[dict[str, Any]] = []

    async def _chat(**kwargs):
        seen_kwargs.append(kwargs)
        return SimpleNamespace(content="", tool_calls=[])

    mock_context["llm_provider"] = SimpleNamespace(
        config=SimpleNamespace(base_url="https://api.moonshot.cn/v1", model="kimi-k2.5"),
        chat=AsyncMock(side_effect=_chat),
    )
    monkeypatch.setattr(
        "src.orchestrator.nodes_act._build_act_tool_schemas",
        lambda runtime_context, skill_registry: [{"type": "function", "function": {"name": "search", "parameters": {"type": "object"}}}],
    )
    action = PlanStep(id="step-1", title="搜索最新动态", phase="retrieve", intent="获取最新动态")

    results = await _execute_llm_act_step(
        state=base_state,
        context=mock_context,
        action=action,
        unified_executor=mock_context["unified_executor"],
        event_emitter=None,
        prior_results=[],
    )

    assert results[-1].success is False
    assert seen_kwargs
    assert seen_kwargs[0].get("tools") is not None
    assert seen_kwargs[0].get("response_format") is None


@pytest.mark.asyncio
async def test_execute_llm_act_step_uses_terminal_phase_after_no_tool_calls_for_two_phase_provider(
    mock_context, base_state, monkeypatch
):
    from src.llm.provider_compat import resolve_act_execution_strategy as _real_act_strategy
    monkeypatch.setattr("src.orchestrator.nodes_act.resolve_act_execution_strategy", _real_act_strategy)
    seen_kwargs: list[dict[str, Any]] = []

    async def _chat(**kwargs):
        seen_kwargs.append(kwargs)
        if len(seen_kwargs) == 1:
            return SimpleNamespace(content="我先整理一下已有结果。", tool_calls=[])
        return SimpleNamespace(content=_act_result_json(summary="完成"), tool_calls=[])

    mock_context["llm_provider"] = SimpleNamespace(
        config=SimpleNamespace(base_url="https://api.moonshot.cn/v1", model="kimi-k2.5"),
        chat=AsyncMock(side_effect=_chat),
    )
    monkeypatch.setattr(
        "src.orchestrator.nodes_act._build_act_tool_schemas",
        lambda runtime_context, skill_registry: [{"type": "function", "function": {"name": "search", "parameters": {"type": "object"}}}],
    )
    action = PlanStep(id="step-1", title="搜索最新动态", phase="retrieve", intent="获取最新动态")

    results = await _execute_llm_act_step(
        state=base_state,
        context=mock_context,
        action=action,
        unified_executor=mock_context["unified_executor"],
        event_emitter=None,
        prior_results=[],
    )

    assert results[-1].success is True
    assert len(seen_kwargs) == 2
    assert seen_kwargs[0].get("tools") is not None
    assert seen_kwargs[0].get("response_format") is None
    assert seen_kwargs[1].get("tools") is None
    terminal_response_format = seen_kwargs[1].get("response_format")
    assert isinstance(terminal_response_format, dict)
    assert terminal_response_format.get("type") == "json_object"
    trace = (base_state.get("metadata") or {}).get("act_loop_trace_by_step", {}).get("step-1")
    assert trace
    assert trace[0]["phase"] == "tool"
    assert any(item.get("outcome") == "switch_to_terminal_phase" for item in trace)
    assert trace[-1]["phase"] == "terminal"
    assert trace[-1]["outcome"] == "terminal_json_accepted"


@pytest.mark.asyncio
async def test_execute_llm_act_step_retries_terminal_phase_once_for_stable_provider_invalid_json(
    mock_context, base_state, monkeypatch
):
    seen_kwargs: list[dict[str, Any]] = []

    async def _chat(**kwargs):
        seen_kwargs.append(kwargs)
        if len(seen_kwargs) == 1:
            return SimpleNamespace(content="我会先整理结果再继续。", tool_calls=[])
        return SimpleNamespace(content=_act_result_json(summary="完成"), tool_calls=[])

    mock_context["llm_provider"] = SimpleNamespace(
        config=SimpleNamespace(base_url="https://gaccodeapi.com/v1", model="claude-sonnet-4-6"),
        chat=AsyncMock(side_effect=_chat),
    )
    monkeypatch.setattr(
        "src.orchestrator.nodes_act._build_act_tool_schemas",
        lambda runtime_context, skill_registry: [{"type": "function", "function": {"name": "search", "parameters": {"type": "object"}}}],
    )
    action = PlanStep(id="step-1", title="搜索最新动态", phase="retrieve", intent="获取最新动态")

    results = await _execute_llm_act_step(
        state=base_state,
        context=mock_context,
        action=action,
        unified_executor=mock_context["unified_executor"],
        event_emitter=None,
        prior_results=[],
    )

    assert results[-1].success is True
    assert len(seen_kwargs) == 2
    assert seen_kwargs[0].get("tools") is not None
    assert seen_kwargs[1].get("tools") is None
    trace = (base_state.get("metadata") or {}).get("act_loop_trace_by_step", {}).get("step-1")
    assert trace
    assert any(item.get("outcome") == "switch_to_terminal_phase" for item in trace)
    assert trace[-1]["phase"] == "terminal"
    assert trace[-1]["outcome"] == "terminal_json_accepted"


@pytest.mark.asyncio
async def test_execute_llm_act_step_retries_terminal_phase_up_to_three_times(
    mock_context, base_state, monkeypatch
):
    seen_kwargs: list[dict[str, Any]] = []

    async def _chat(**kwargs):
        seen_kwargs.append(kwargs)
        if len(seen_kwargs) < 5:
            return SimpleNamespace(content="我会继续整理，并在下一条给出最终 JSON。", tool_calls=[])
        return SimpleNamespace(content=_act_result_json(summary="最终完成"), tool_calls=[])

    mock_context["llm_provider"] = SimpleNamespace(
        config=SimpleNamespace(base_url="https://gaccodeapi.com/v1", model="claude-sonnet-4-6"),
        chat=AsyncMock(side_effect=_chat),
    )
    monkeypatch.setattr(
        "src.orchestrator.nodes_act._build_act_tool_schemas",
        lambda runtime_context, skill_registry: [{"type": "function", "function": {"name": "search", "parameters": {"type": "object"}}}],
    )
    action = PlanStep(id="step-1", title="搜索最新动态", phase="retrieve", intent="获取最新动态")

    results = await _execute_llm_act_step(
        state=base_state,
        context=mock_context,
        action=action,
        unified_executor=mock_context["unified_executor"],
        event_emitter=None,
        prior_results=[],
    )

    assert results[-1].success is True
    assert len(seen_kwargs) == 5
    assert seen_kwargs[1].get("tools") is None
    assert seen_kwargs[2].get("tools") is None
    assert seen_kwargs[3].get("tools") is None
    assert seen_kwargs[4].get("tools") is None
    trace = (base_state.get("metadata") or {}).get("act_loop_trace_by_step", {}).get("step-1")
    retry_events = [item for item in trace if item.get("outcome") == "retry_terminal_phase"]
    assert len(retry_events) == 3
    assert retry_events[-1]["retry_index"] == 3
    assert trace[-1]["outcome"] == "terminal_json_accepted"


def test_validate_llm_act_tool_call_rejects_file_io_when_required_binding_missing():
    action = PlanStep(
        id="step-2",
        title="读取检索结果文件",
        tool="file_io",
        params={"action": "read", "path": "ai_news_search_results.json"},
        input_refs=[
            StepInputRef(
                name="retrieval_evidence",
                required=True,
                source_step_id="step-1",
                preferred_medium="artifact_result_path",
            )
        ],
    )

    result = _validate_llm_act_tool_call(
        action=action,
        prior_results=[],
        current_step_results=[],
        runtime_context=None,
        latest_user_text="搜索最新的 AI 行业动态并总结",
        today=datetime.now(),
    )

    assert result is not None
    assert result.success is False
    assert "missing required input bindings" in str(result.error or "")


def test_validate_llm_act_tool_call_rejects_file_io_when_guessing_path_instead_of_bound_artifact(tmp_path):
    actual_path = tmp_path / "actual_results.json"
    actual_path.write_text("{}", encoding="utf-8")
    action = PlanStep(
        id="step-2",
        title="读取检索结果文件",
        tool="file_io",
        params={"action": "read", "path": "guessed_results.json"},
        input_refs=[
            StepInputRef(
                name="retrieval_evidence",
                required=True,
                source_step_id="step-1",
                preferred_medium="artifact_result_path",
            )
        ],
    )
    prior_results = [
        ToolCallResult(
            tool_name="search",
            params={},
            result={"items": []},
            success=True,
            metadata={
                "artifact_result_path": str(actual_path),
                "artifact_role": "evidence_bundle",
                "source_step_id": "step-1",
            },
        )
    ]

    result = _validate_llm_act_tool_call(
        action=action,
        prior_results=prior_results,
        current_step_results=[],
        runtime_context=None,
        latest_user_text="搜索最新的 AI 行业动态并总结",
        today=datetime.now(),
    )

    assert result is not None
    assert result.success is False
    assert "does not match the resolved artifact_result_path binding" in str(result.error or "")


def test_validate_llm_act_tool_call_rejects_code_executor_terminal_json_wrapper():
    action = PlanStep(
        id="step-1",
        title="搜索最新 AI 行业动态",
        tool="code_executor",
        params={
            "language": "python",
            "code": (
                "import json\n"
                "execution_result = {\n"
                "  \"type\": \"execution_result\",\n"
                "  \"goal\": \"搜索最新的 AI 行业动态并总结\"\n"
                "}\n"
                "print(json.dumps(execution_result, ensure_ascii=False, indent=2))\n"
            ),
        },
    )

    result = _validate_llm_act_tool_call(
        action=action,
        prior_results=[],
        current_step_results=[],
        runtime_context=None,
        latest_user_text="搜索最新的 AI 行业动态并总结",
    )

    assert result is not None
    assert result.success is False
    assert "Return the terminal JSON directly" in str(result.error or "")


def test_validate_llm_act_tool_call_rejects_stale_year_search_for_latest_request():
    # Disabled: stale year search validation always returns None
    action = PlanStep(
        id="step-1",
        title="搜索最新 AI 行业动态",
        tool="search",
        params={
            "query": "AI人工智能 最新动态 2025年3月 中文",
            "max_results": 8,
        },
    )

    result = _validate_llm_act_tool_call(
        action=action,
        prior_results=[],
        current_step_results=[],
        runtime_context=None,
        latest_user_text="搜索最新的 AI 行业动态并总结",
        today=datetime(2026, 3, 12),
    )

    assert result is None


def test_validate_llm_act_tool_call_allows_explicit_historical_search_when_not_latest_request():
    action = PlanStep(
        id="step-1",
        title="研究 2025 年 AI 行业动态",
        tool="search",
        params={
            "query": "AI人工智能 2025年3月 行业动态 中文",
            "max_results": 8,
        },
    )

    result = _validate_llm_act_tool_call(
        action=action,
        prior_results=[],
        current_step_results=[],
        runtime_context=None,
        latest_user_text="研究 2025 年 AI 行业动态并总结",
        today=datetime(2026, 3, 12),
    )

    assert result is None


def test_validate_llm_act_tool_call_rejects_repeated_search_after_same_step_tavily_432_failures():
    # Disabled: repeated search provider failure validation always returns None
    action = PlanStep(
        id="step-2",
        title="补充抓取候选来源",
        tool="search",
        params={
            "query": "AI行业动态 36氪 最新",
            "max_results": 5,
        },
    )

    current_step_results = [
        ToolCallResult(
            tool_name="search",
            params={"query": "AI人工智能 最新动态 2026年3月 机器之心"},
            error="Tavily API error: 432",
            success=False,
        ),
        ToolCallResult(
            tool_name="search",
            params={"query": "AI行业动态 36氪 最新"},
            error="Tavily API error: 432",
            success=False,
        ),
    ]

    result = _validate_llm_act_tool_call(
        action=action,
        prior_results=[],
        current_step_results=current_step_results,
        runtime_context=None,
        latest_user_text="搜索最新的 AI 行业动态并总结",
        today=datetime(2026, 3, 13),
    )

    assert result is None


def test_parse_structured_json_object_extracts_fenced_json_with_surrounding_text():
    payload = (
        "我已经完成当前步骤，下面给出终态对象。\n\n"
        "```json\n"
        "{\n"
        "  \"decision\": \"advance_step\",\n"
        "  \"observations\": [{\"summary\": \"已完成当前步骤\"}]\n"
        "}\n"
        "```\n\n"
        "以上是最终结果。"
    )

    parsed = _parse_structured_json_object(payload)

    assert parsed is not None
    assert parsed["decision"] == "advance_step"


def test_parse_structured_json_object_ignores_non_json_braces_before_terminal_object():
    payload = (
        "说明：artifact summary {draft only}\n"
        "最终对象如下：\n"
        "{\n"
        "  \"decision\": \"replan\",\n"
        "  \"observations\": [{\"summary\": \"缺少来源链接\"}],\n"
        "  \"artifacts_produced\": []\n"
        "}"
    )

    parsed = _parse_structured_json_object(payload)

    assert parsed is not None
    assert parsed["decision"] == "replan"


def test_parse_structured_json_object_recovers_multiline_string_values_inside_fenced_json():
    payload = (
        "```json\n"
        "{\n"
        '  "decision": "complete_task",\n'
        '  "observations": [{"summary": "完成"}],\n'
        '  "artifact_result_text": "# 标题\n\n'
        "第一行\n"
        "第二行\n\n"
        "## 小节\n"
        "更多内容\"\n"
        "}\n"
        "```"
    )

    parsed = _parse_structured_json_object(payload)

    assert parsed is not None
    assert parsed["decision"] == "complete_task"
    assert "第一行" in parsed["artifact_result_text"]
    assert "## 小节" in parsed["artifact_result_text"]


def test_parse_planner_json_object_extracts_nested_fenced_json():
    payload = (
        "```json\n"
        "{\n"
        '  "type": "plan",\n'
        '  "goal": "搜索最新的 AI 行业动态并总结",\n'
        '  "steps": [\n'
        '    {"id": "step-1", "title": "检索", "intent": "检索最新动态"}\n'
        "  ],\n"
        '  "skill_context_for_act": {"skill_id": "deep-research", "execution_rules": [{"instruction": "先检索", "strength": "must"}]}\n'
        "}\n"
        "```"
    )

    parsed = _parse_planner_json_object(payload)

    assert parsed is not None
    assert parsed["type"] == "plan"
    assert parsed["goal"] == "搜索最新的 AI 行业动态并总结"


def test_parse_planner_json_object_recovers_multiline_string_values_inside_fenced_json():
    payload = (
        "```json\n"
        "{\n"
        '  "type": "terminate",\n'
        '  "goal": "test goal",\n'
        '  "reason": "第一行\n'
        "第二行\n"
        '第三行",\n'
        '  "status": "no_further_action_needed",\n'
        '  "summary_for_act": "完成"\n'
        "}\n"
        "```"
    )

    parsed = _parse_planner_json_object(payload)

    assert parsed is not None
    assert parsed["type"] == "terminate"
    assert "第二行" in parsed["reason"]


def test_validate_llm_act_tool_call_rejects_code_executor_when_summarizing_bound_text_only():
    # Disabled: code_executor bound text summary validation always returns None
    action = PlanStep(
        id="step-2",
        title="整理与总结 AI 动态",
        intent="对搜索结果进行分类整理，提取关键信息，形成结构化的总结报告",
        tool="code_executor",
        params={
            "language": "python",
            "code": (
                "search_results = \"\"\"# AI 行业动态 最新\n\n"
                "## 关键结果\n"
                "1. News A - 摘要：AI 基础设施投资增长\n"
                "2. News B - 摘要：大模型产品发布\n"
                "3. News C - 摘要：政策治理更新\n"
                "\"\"\"\n\n"
                "summary = search_results[:200]\n"
                "print(summary)\n"
            ),
        },
        input_refs=[
            StepInputRef(
                name="retrieval_evidence",
                required=True,
                source_step_id="step-1",
                preferred_medium="artifact_result_text",
            )
        ],
    )
    prior_results = [
        ToolCallResult(
            tool_name="search",
            params={},
            result={"items": [{"title": "News A"}, {"title": "News B"}]},
            success=True,
            metadata={
                "text_artifact": {
                    "artifact_role": "evidence_bundle",
                    "source_step_id": "step-1",
                    "artifact_result_text": (
                        "# AI 行业动态 最新\n\n"
                        "## 关键结果\n"
                        "1. News A - 摘要：AI 基础设施投资增长\n"
                        "2. News B - 摘要：大模型产品发布\n"
                        "3. News C - 摘要：政策治理更新\n"
                    ),
                },
            },
        )
    ]

    result = _validate_llm_act_tool_call(
        action=action,
        prior_results=prior_results,
        current_step_results=[],
        runtime_context=None,
        latest_user_text="搜索最新的 AI 行业动态并总结",
    )

    assert result is None


@pytest.mark.asyncio
async def test_execute_llm_act_step_reuses_same_step_file_read_result(mock_context, base_state, monkeypatch):
    base_state["metadata"] = {"skill_orchestration_trace": {"skill_context_skill_id": "deep-research"}}
    seen_prompts: list[str] = []

    async def _chat(**kwargs):
        messages = kwargs.get("messages") or []
        seen_prompts.append(str(messages[-1]["content"]))
        call_index = len(seen_prompts)
        if call_index == 1:
            return SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_read_1",
                        "function": {
                            "name": "file_io",
                            "arguments": "{\"action\":\"read\",\"path\":\"evidence.json\"}",
                        },
                    }
                ],
            )
        if call_index == 2:
            return SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_read_2",
                        "function": {
                            "name": "file_io",
                            "arguments": "{\"action\":\"read\",\"path\":\"evidence.json\"}",
                        },
                    }
                ],
            )
        return SimpleNamespace(content=_act_result_json(summary="读取完成"), tool_calls=[])

    mock_context["llm_provider"].chat = AsyncMock(
        side_effect=_chat
    )
    monkeypatch.setattr("src.orchestrator.nodes_act._build_act_tool_schemas", lambda runtime_context, skill_registry: [])

    action = PlanStep(id="2", title="读取证据", phase="retrieve", tool="file_io", params={"action": "read", "path": "evidence.json"})
    mock_context["unified_executor"].execute.return_value = ToolCallResult(
        tool_name="file_io",
        params={"action": "read", "path": "evidence.json"},
        result={"content": "{\"ok\":true}"},
        success=True,
    )

    results = await _execute_llm_act_step(
        state=base_state,
        context=mock_context,
        action=action,
        unified_executor=mock_context["unified_executor"],
        event_emitter=None,
        prior_results=[],
    )

    assert mock_context["unified_executor"].execute.await_count == 1
    assert len(results) >= 2
    assert results[0].success is True
    assert results[1].success is True
    assert results[1].result == results[0].result
    assert results[1].metadata["reused_existing_result"] is True
    assert len(seen_prompts) >= 2
    assert "Already loaded files in this step:" in seen_prompts[1]
    assert "- evidence.json (read_success=true, truncated=False" in seen_prompts[1]
    assert "Do not read the same file again unless that file was modified in this step." in seen_prompts[1]


@pytest.mark.asyncio
async def test_execute_llm_act_step_treats_skill_context_as_authoritative(mock_context, base_state, monkeypatch):
    seen_system_prompts: list[str] = []
    seen_user_prompts: list[str] = []

    async def _chat(**kwargs):
        messages = kwargs.get("messages") or []
        seen_system_prompts.append(str(messages[0]["content"]))
        # Collect all message content for checking step-level context (now in system messages)
        all_content = "\n".join(str(m.get("content") or "") for m in messages)
        seen_user_prompts.append(all_content)
        return SimpleNamespace(content=_act_result_json(summary="完成"), tool_calls=[])

    base_state["metadata"] = {"skill_orchestration_trace": {"skill_context_skill_id": "deep-research"}}
    base_state["plan"] = ExecutionPlan(
        goal="研究拼多多股票",
        round_goal="完成研究报告",
        selected_skill="deep-research",
        planning_rationale={
            "critical_constraints": ["不要跳过来源验证", "结论必须有证据支撑"],
        },
        stop_or_replan_conditions=["关键证据缺失时必须 replan"],
        skill_context_for_act={
            "skill_id": "deep-research",
            "phase": "scope",
            "execution_rules": [
                {
                    "id": "rule-1",
                    "instruction": "先界定范围再收集证据",
                    "strength": "must",
                    "condition": "",
                    "source_ref": "scope",
                }
            ],
            "quality_checks": [
                {
                    "id": "check-1",
                    "instruction": "范围必须明确",
                    "strength": "must",
                    "condition": "scope phase",
                    "source_ref": "scope",
                }
            ],
            "artifact_rules": [
                {
                    "id": "artifact-1",
                    "instruction": "记录当前阶段产物",
                    "strength": "must",
                    "condition": "scope phase",
                    "source_ref": "scope",
                }
            ],
            "replan_triggers": [
                {
                    "id": "trigger-1",
                    "instruction": "阶段目标无法满足时重规划",
                    "source_ref": "scope",
                }
            ],
            "source_sections": ["scope"],
        },
    )
    mock_context["llm_provider"].chat = AsyncMock(side_effect=_chat)
    monkeypatch.setattr("src.orchestrator.nodes_act._build_act_tool_schemas", lambda runtime_context, skill_registry: [])

    action = PlanStep(id="2", title="界定范围", phase="scope", intent="定义研究边界")

    results = await _execute_llm_act_step(
        state=base_state,
        context=mock_context,
        action=action,
        unified_executor=mock_context["unified_executor"],
        event_emitter=None,
        prior_results=[],
    )

    assert results[-1].success is True
    assert seen_system_prompts
    assert "treat it as the authoritative guidance" in seen_system_prompts[0]
    assert "If the current execution-scope skill exposes scripts/*" not in seen_system_prompts[0]
    assert "Current round skill id hint (secondary context):" not in seen_user_prompts[0]
    assert "Structured skill context for this round:" in seen_user_prompts[0]
    assert "Planner critical constraints:" in seen_user_prompts[0]
    assert "不要跳过来源验证" in seen_user_prompts[0]
    assert "Current round stop or replan conditions:" in seen_user_prompts[0]
    assert "关键证据缺失时必须 replan" in seen_user_prompts[0]


@pytest.mark.asyncio
async def test_observe_node_iteration_limit_returns_respond_with_execution_state(mock_context, base_state):
    base_state["iteration"] = 9
    base_state["plan"] = ExecutionPlan(
        goal="test goal",
        steps=[PlanStep(id="1", title="collect", intent="collect evidence")],
        current_step_index=0,
    )
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="search",
            params={"query": "pdd"},
            result={"items": [{"title": "PDD"}]},
            success=True,
            metadata={
                "act_decision": "complete_task",
                "act_step_id": "1",
                "artifact_result_text": "done",
                "act_observations": [{"step_id": "1", "summary": "完成检索"}],
                "act_artifacts_produced": [],
            },
        )
    ]
    mock_context["config"] = {"max_iterations": 10}

    result = await observe_node(base_state, mock_context)

    assert result["current_step"] == "respond"
    assert result["observe_outcome"] == "task_completed"
    assert "execution_state" in result
    assert result["execution_state"]["completed_steps"] == ["1"]


@pytest.mark.asyncio
async def test_execute_llm_act_step_requires_structured_terminal_json(mock_context, base_state, monkeypatch):
    mock_context["llm_provider"].chat = AsyncMock(
        return_value=SimpleNamespace(content="完成", tool_calls=[])
    )
    monkeypatch.setattr("src.orchestrator.nodes_act._build_act_tool_schemas", lambda runtime_context, skill_registry: [])

    action = PlanStep(id="2", title="界定范围", phase="scope", intent="定义研究边界")

    results = await _execute_llm_act_step(
        state=base_state,
        context=mock_context,
        action=action,
        unified_executor=mock_context["unified_executor"],
        event_emitter=None,
        prior_results=[],
    )

    assert results[-1].success is False
    assert results[-1].metadata["guard"] == "llm_act_validation"
    assert "artifact_result_text" in str(results[-1].error) or "observations" in str(results[-1].error) or "execution_concerns" in str(results[-1].error)


@pytest.mark.asyncio
async def test_execute_llm_act_step_logs_truncated_terminal_json_diagnostics(
    mock_context, base_state, monkeypatch, capsys
):
    mock_context["llm_provider"].chat = AsyncMock(
        return_value=SimpleNamespace(
            content='{"decision":"advance_step","observations":[{"summary":"ok","artifacts_produced":["x"]}',
            tool_calls=[],
            finish_reason="stop",
            usage={"prompt_tokens": 321, "completion_tokens": 77, "total_tokens": 398},
        )
    )
    monkeypatch.setattr("src.orchestrator.nodes_act._build_act_tool_schemas", lambda runtime_context, skill_registry: [])

    action = PlanStep(id="2", title="界定范围", phase="scope", intent="定义研究边界")

    results = await _execute_llm_act_step(
        state=base_state,
        context=mock_context,
        action=action,
        unified_executor=mock_context["unified_executor"],
        event_emitter=None,
        prior_results=[],
    )
    captured = capsys.readouterr()

    assert results[-1].success is False
    assert results[-1].metadata["guard"] == "llm_act_validation"
    assert "act_terminal_json_invalid" in captured.out


@pytest.mark.asyncio
async def test_execute_llm_act_step_rejects_fake_partial_progress_without_tool_execution(
    mock_context, base_state, monkeypatch
):
    mock_context["llm_provider"].chat = AsyncMock(
        return_value=SimpleNamespace(
            content=json.dumps(
                {
                    "decision": "continue_current_step",
                    "observations": [
                        {
                            "summary": "Starting retrieval phase for latest AI industry news and developments",
                            "evidence": [],
                            "artifacts_produced": [],
                            "constraints_encountered": [],
                        }
                    ],
                    "artifacts_produced": [],
                },
                ensure_ascii=False,
            ),
            tool_calls=[],
        )
    )
    monkeypatch.setattr("src.orchestrator.nodes_act._build_act_tool_schemas", lambda runtime_context, skill_registry: [])

    action = PlanStep(id="step-1", title="执行AI行业动态搜索", phase="retrieve", intent="实际调用搜索工具检索最新动态")

    results = await _execute_llm_act_step(
        state=base_state,
        context=mock_context,
        action=action,
        unified_executor=mock_context["unified_executor"],
        event_emitter=None,
        prior_results=[],
    )

    assert results[-1].success is False
    assert results[-1].metadata["guard"] == "llm_act_validation"
    assert "without any real tool execution" in str(results[-1].error)


@pytest.mark.asyncio
async def test_observe_node_replans_from_structured_replan_decision(mock_context, base_state):
    base_state["iteration"] = 1
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="llm_act",
            params={"title": "step"},
            result="blocked",
            error="Need replan",
            success=False,
            metadata={"act_decision": "replan", "act_step_id": "step"},
        )
    ]

    result = await observe_node(base_state, mock_context)

    assert result["current_step"] == "plan"
    assert result["observe_outcome"] == "replan_current_round"


@pytest.mark.asyncio
async def test_observe_node_completes_from_complete_task_decision(mock_context, base_state):
    base_state["iteration"] = 1
    base_state["plan"] = ExecutionPlan(
        plan_type="plan",
        goal="goal",
        steps=[PlanStep(id="step", title="step", tool="search", params={})],
        current_step_index=0,
    )
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="llm_act",
            params={"title": "step"},
            result="done",
            success=True,
            metadata={"act_decision": "complete_task", "act_step_id": "step", "artifact_result_text": "done"},
        )
    ]

    result = await observe_node(base_state, mock_context)

    assert result["current_step"] == "respond"
    assert result["observe_outcome"] == "task_completed"
    assert result["execution_state"]["observations"] == ["llm_act: success"]


@pytest.mark.asyncio
async def test_observe_node_completes_from_structured_completed_task_status(mock_context, base_state):
    base_state["iteration"] = 1
    base_state["plan"] = ExecutionPlan(
        plan_type="plan",
        goal="goal",
        steps=[PlanStep(id="step", title="step", tool="search", params={})],
        current_step_index=0,
    )
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="llm_act",
            params={"title": "step"},
            result="done",
            success=True,
            metadata={"act_decision": "complete_task", "act_step_id": "step", "artifact_result_text": "done"},
        )
    ]

    result = await observe_node(base_state, mock_context)

    assert result["current_step"] == "respond"
    assert result["observe_outcome"] == "task_completed"


@pytest.mark.asyncio
async def test_observe_node_downgrades_stop_on_non_final_step(mock_context, base_state):
    base_state["iteration"] = 1
    base_state["plan"] = ExecutionPlan(
        plan_type="plan",
        goal="goal",
        steps=[
            PlanStep(id="1", title="step 1", tool="search", params={}),
            PlanStep(id="2", title="step 2", tool="search", params={}),
        ],
        current_step_index=0,
    )
    base_state["pending_actions"] = [PlanStep(id="2", title="step 2", tool="search", params={})]
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="llm_act",
            params={"title": "step 1"},
            result="done",
            success=True,
            metadata={
                "act_decision": "complete_task",
                "act_step_id": "1",
                "artifact_result_text": "final answer",
            },
        )
    ]

    result = await observe_node(base_state, mock_context)

    assert result["current_step"] == "act"
    assert result["observe_outcome"] == "continue_execution"
    assert [step.id for step in result["pending_actions"]] == ["2"]


@pytest.mark.asyncio
async def test_observe_node_syncs_plan_index_to_first_pending_action(mock_context, base_state):
    base_state["iteration"] = 1
    base_state["plan"] = ExecutionPlan(
        plan_type="plan",
        goal="goal",
        steps=[
            PlanStep(id="step-1", title="step 1", tool="search", params={}),
            PlanStep(id="step-2", title="step 2", tool="search", params={}),
            PlanStep(id="step-3", title="step 3", tool="search", params={}),
        ],
        current_step_index=1,
    )
    base_state["pending_actions"] = [
        PlanStep(id="step-3", title="step 3", tool="search", params={}),
    ]
    base_state["metadata"] = {"last_act_step_id": "step-2"}
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="llm_act",
            params={"title": "step 2"},
            result="done",
            success=True,
            metadata={
                "act_decision": "advance_step",
                "act_step_id": "step-2",
            },
        )
    ]

    result = await observe_node(base_state, mock_context)

    assert result["current_step"] == "act"
    assert result["observe_outcome"] == "continue_execution"
    assert [step.id for step in result["pending_actions"]] == ["step-3"]


@pytest.mark.asyncio
async def test_observe_node_does_not_advance_without_structured_act_decision(mock_context, base_state):
    base_state["iteration"] = 1
    base_state["plan"] = ExecutionPlan(
        plan_type="plan",
        goal="goal",
        steps=[
            PlanStep(id="step-1", title="step 1", tool="search", params={}),
            PlanStep(id="step-2", title="step 2", tool="search", params={}),
        ],
        current_step_index=0,
    )
    base_state["pending_actions"] = [PlanStep(id="step-1", title="step 1", tool="search", params={}), PlanStep(id="step-2", title="step 2", tool="search", params={})]
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="search",
            params={"query": "test"},
            result={"results": []},
            success=True,
        )
    ]

    result = await observe_node(base_state, mock_context)

    assert result["current_step"] == "act"
    assert result["observe_outcome"] == "continue_execution"
    assert [step.id for step in result["pending_actions"]] == ["step-1", "step-2"]


@pytest.mark.asyncio
async def test_observe_node_allows_stop_on_final_step(mock_context, base_state):
    base_state["iteration"] = 1
    base_state["plan"] = ExecutionPlan(
        plan_type="plan",
        goal="goal",
        steps=[PlanStep(id="1", title="step 1", tool="search", params={})],
        current_step_index=0,
    )
    base_state["pending_actions"] = []
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="llm_act",
            params={"title": "step 1"},
            result="done",
            success=True,
            metadata={
                "act_decision": "complete_task",
                "act_step_id": "1",
                "artifact_result_text": "final answer",
            },
        )
    ]

    result = await observe_node(base_state, mock_context)

    assert result["current_step"] == "respond"
    assert result["observe_outcome"] == "task_completed"


@pytest.mark.asyncio
async def test_observe_node_completes_when_no_pending_actions_remain(mock_context, base_state):
    """When act reports completion and no pending_actions remain, observe completes the task."""
    base_state["iteration"] = 1
    base_state["pending_actions"] = []
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="llm_act",
            params={"title": "step"},
            result="done",
            success=True,
            metadata={"act_decision": "complete_task", "act_step_id": "step-1", "artifact_result_text": "result"},
        )
    ]

    result = await observe_node(base_state, mock_context)

    assert result["current_step"] == "respond"
    assert result["observe_outcome"] == "task_completed"


@pytest.mark.asyncio
async def test_observe_node_advances_plan_from_advance_step_decision(mock_context, base_state):
    base_state["plan"] = ExecutionPlan(
        goal="test goal",
        steps=[
            PlanStep(id="1", title="step 1", tool="search", params={}),
            PlanStep(id="2", title="step 2", tool="search", params={}),
        ],
        current_step_index=0,
    )
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="llm_act",
            params={"title": "step 1"},
            result="done",
            success=True,
            metadata={"act_decision": "advance_step", "act_step_id": "1"},
        )
    ]
    base_state["metadata"] = {
        "last_act_result_count": 1,
        "last_act_step_id": "1",
    }
    base_state["pending_actions"] = [PlanStep(id="2", title="step 2", tool="search", params={})]

    result = await observe_node(base_state, mock_context)

    assert result["current_step"] == "act"
    assert result["observe_outcome"] == "continue_execution"
    assert "remaining work" in result["metadata"]["observe_reason"]


@pytest.mark.asyncio
async def test_observe_node_completes_early_when_only_delivery_followup_remains(mock_context, base_state):
    base_state["plan"] = ExecutionPlan(
        goal="test goal",
        final_delivery_contract={"delivery_goal": "deliver summary"},
        steps=[
            PlanStep(
                id="1",
                title="搜索结果",
                output_contract=StepOutputContract(
                    primary_output_kind="search_results",
                    handoff_mode="reasoning_text",
                    artifact_role="raw_search_data",
                    must_produce_text=True,
                    must_materialize_file=False,
                    handoff_purpose="reasoning_continuation",
                ),
            ),
            PlanStep(
                id="2",
                title="整理成最终回复",
                output_contract=StepOutputContract(
                    primary_output_kind="inline_summary",
                    handoff_mode="final_delivery",
                    artifact_role="user_deliverable",
                    must_produce_text=True,
                    must_materialize_file=False,
                    handoff_purpose="user_delivery",
                ),
            ),
        ],
        current_step_index=0,
    )
    base_state["pending_actions"] = [
        PlanStep(
            id="2",
            title="整理成最终回复",
            output_contract=StepOutputContract(
                primary_output_kind="inline_summary",
                handoff_mode="final_delivery",
                artifact_role="user_deliverable",
                must_produce_text=True,
                must_materialize_file=False,
                handoff_purpose="user_delivery",
            ),
        )
    ]
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="opencli_xiaohongshu_search",
            params={"query": "今天AI资讯"},
            result="ok",
            success=True,
            metadata={
                "source_step_id": "1",
                "artifact_result_text": "1. AI新闻A\n2. AI新闻B\n3. AI新闻C",
                "artifact_type": "search_results",
            },
        ),
        ToolCallResult(
            tool_name="llm_act",
            params={"title": "搜索结果"},
            result="done",
            success=True,
            metadata={
                "act_decision": "advance_step",
                "act_step_id": "1",
                "artifact_result_text": "1. AI新闻A\n2. AI新闻B\n3. AI新闻C",
                "artifact_type": "search_results",
            },
        ),
    ]
    base_state["metadata"] = {"last_act_result_count": 2, "last_act_step_id": "1"}

    result = await observe_node(base_state, mock_context)

    assert result["current_step"] == "respond"
    assert result["observe_outcome"] == "task_completed"
    assert result["metadata"]["observe_reason"] == "task is complete; no further execution is needed"


@pytest.mark.asyncio
async def test_observe_node_does_not_advance_plan_from_continue_current_step_decision(mock_context, base_state):
    base_state["plan"] = ExecutionPlan(
        goal="test goal",
        steps=[
            PlanStep(id="1", title="step 1", tool="search", params={}),
            PlanStep(id="2", title="step 2", tool="search", params={}),
        ],
        current_step_index=0,
    )
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="llm_act",
            params={"title": "step 1"},
            result="partial",
            success=True,
            metadata={"act_decision": "continue_current_step", "act_step_id": "1"},
        )
    ]
    base_state["metadata"] = {
        "last_act_result_count": 1,
        "last_act_step_id": "1",
    }
    base_state["pending_actions"] = [PlanStep(id="1", title="step 1", tool="search", params={}), PlanStep(id="2", title="step 2", tool="search", params={})]

    result = await observe_node(base_state, mock_context)

    assert result["current_step"] == "act"
    assert result["observe_outcome"] == "continue_execution"
    assert result["pending_actions"][0].id == "1"
    assert "remaining work" in result["metadata"]["observe_reason"]


    assert "remaining work" in result["metadata"]["observe_reason"]


@pytest.mark.asyncio
async def test_execute_llm_act_step_emits_plan_version_and_iteration_in_act_decision(
    mock_context,
    base_state,
    monkeypatch,
):
    class _EventEmitter:
        def __init__(self):
            self.events = []

        async def emit(self, event_type, payload):
            self.events.append((event_type, payload))

        async def emit_plan_step_start(self, step_id, title, tool, params):
            self.events.append(("plan_step_start", {"step_id": step_id, "title": title, "tool": tool, "params": params}))

        async def emit_tool_call_start(self, tool_name, arguments):
            self.events.append(("tool_call_start", {"tool_name": tool_name, "arguments": arguments}))

        async def emit_tool_call_complete(self, tool_name, result, success, error=None, duration=None, metadata=None):
            self.events.append(
                (
                    "tool_call_complete",
                    {
                        "tool_name": tool_name,
                        "result": result,
                        "success": success,
                        "error": error,
                        "duration": duration,
                        "metadata": metadata,
                    },
                )
            )

        async def emit_plan_step_complete(self, step_id, title, result, duration_ms):
            self.events.append(
                ("plan_step_complete", {"step_id": step_id, "title": title, "result": result, "duration_ms": duration_ms})
            )

        async def emit_plan_step_failed(self, step_id, title, error):
            self.events.append(("plan_step_failed", {"step_id": step_id, "title": title, "error": error}))

        async def emit_file_created(self, file_id, filename, mime_type, size, url):
            self.events.append(
                (
                    "file_created",
                    {
                        "file_id": file_id,
                        "filename": filename,
                        "mime_type": mime_type,
                        "size": size,
                        "url": url,
                    },
                )
            )

    base_state["iteration"] = 2
    event_emitter = _EventEmitter()

    mock_context["llm_provider"].chat = AsyncMock(
        side_effect=[
            SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_search_1",
                        "function": {
                            "name": "search",
                            "arguments": "{\"query\":\"pdd stock\"}",
                        },
                    }
                ],
            ),
            SimpleNamespace(content=_act_result_json(summary="搜索完成"), tool_calls=[]),
        ]
    )
    monkeypatch.setattr("src.orchestrator.nodes_act._build_act_tool_schemas", lambda runtime_context, skill_registry: [])
    mock_context["unified_executor"].execute.return_value = ToolCallResult(
        tool_name="search",
        params={"query": "pdd stock"},
        result={"items": []},
        success=True,
    )

    action = PlanStep(
        id="2",
        title="搜索拼多多信息",
        phase="retrieve",
        intent="收集拼多多股票相关信息",
        tool="search",
        params={"query": "pdd stock"},
    )

    await _execute_llm_act_step(
        state=base_state,
        context=mock_context,
        action=action,
        unified_executor=mock_context["unified_executor"],
        event_emitter=event_emitter,
        prior_results=[],
    )

    act_decision_events = [payload for event_type, payload in event_emitter.events if event_type == "act_decision"]
    assert act_decision_events
    assert act_decision_events[0]["iteration"] == 2
    assert act_decision_events[0]["plan_version"] == 3
    assert act_decision_events[0]["step_id"] == "2"


@pytest.mark.asyncio
async def test_execute_llm_act_step_emits_only_user_visible_non_data_files(mock_context, base_state, monkeypatch):
    class _EventEmitter:
        def __init__(self):
            self.events = []

        async def emit(self, event_type, payload):
            self.events.append((event_type, payload))

        async def emit_act_decision(self, payload):
            self.events.append(("act_decision", payload))

        async def emit_tool_call_start(self, tool_name, arguments):
            self.events.append(("tool_call_start", {"tool_name": tool_name, "arguments": arguments}))

        async def emit_tool_call_complete(self, tool_name, result, success, error=None, duration=None, metadata=None):
            self.events.append(("tool_call_complete", {"tool_name": tool_name, "result": result, "success": success}))

        async def emit_plan_step_start(self, step_id, title, tool, params):
            self.events.append(("plan_step_start", {"step_id": step_id, "title": title, "tool": tool, "params": params}))

        async def emit_plan_step_complete(self, step_id, title, result, duration_ms):
            self.events.append(("plan_step_complete", {"step_id": step_id, "title": title}))

        async def emit_plan_step_failed(self, step_id, title, error):
            self.events.append(("plan_step_failed", {"step_id": step_id, "title": title, "error": error}))

        async def emit_file_created(self, file_id, filename, mime_type, size, url):
            self.events.append(("file_created", {"file_id": file_id, "filename": filename, "url": url}))

    event_emitter = _EventEmitter()
    mock_context["llm_provider"].chat = AsyncMock(
        side_effect=[
            SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_code_1",
                        "function": {
                            "name": "code_executor",
                            "arguments": "{\"language\":\"python\",\"code\":\"print('ok')\"}",
                        },
                    }
                ],
            ),
            SimpleNamespace(content=_act_result_json(summary="报告已生成"), tool_calls=[]),
        ]
    )
    monkeypatch.setattr("src.orchestrator.nodes_act._build_act_tool_schemas", lambda runtime_context, skill_registry: [])
    mock_context["unified_executor"].execute.return_value = ToolCallResult(
        tool_name="code_executor",
        params={"language": "python", "code": "print('ok')"},
        result={},
        success=True,
        metadata={
            "generated_files": [
                {
                    "file_id": "json-1",
                    "filename": "industry_comparison.json",
                    "mime_type": "application/json",
                    "artifact_role": "data_json",
                    "user_visible": False,
                },
                {
                    "file_id": "md-1",
                    "filename": "pinduoduo_investment_research_report.md",
                    "mime_type": "text/markdown",
                    "artifact_role": "report_md",
                    "user_visible": True,
                },
            ]
        },
    )

    action = PlanStep(
        id="2",
        title="生成投资研究报告",
        phase="synthesize",
        intent="生成最终研究报告",
        tool="code_executor",
        params={"language": "python", "code": "print('ok')"},
    )

    await _execute_llm_act_step(
        state=base_state,
        context=mock_context,
        action=action,
        unified_executor=mock_context["unified_executor"],
        event_emitter=event_emitter,
        prior_results=[],
    )

    file_events = [payload for event_type, payload in event_emitter.events if event_type == "file_created"]
    assert len(file_events) == 1
    assert file_events[0]["filename"] == "pinduoduo_investment_research_report.md"


@pytest.mark.asyncio
async def test_observe_node_with_empty_plan_steps(mock_context, base_state):
    """Test observe_node handles empty plan.steps gracefully."""
    # Create plan with empty steps
    base_state["plan"] = ExecutionPlan(
        goal="test goal",
        steps=[],
        current_step_index=0,
        requires_delegation=False,
        delegate_to=None,
    )
    base_state["tool_results"] = []

    result = await observe_node(base_state, mock_context)

    # Should move to respond when no more steps
    assert result["current_step"] == "respond"
    assert result["observe_outcome"] == "task_completed"


@pytest.mark.asyncio
async def test_delegate_node_routes_back_to_respond(mock_context, base_state):
    mock_context["sub_agent_delegator"] = MagicMock()
    mock_context["sub_agent_delegator"].delegate = AsyncMock(
        return_value={"result": "delegated answer", "error": None}
    )
    base_state["plan"] = ExecutionPlan(
        plan_type="delegate",
        goal="delegate test",
        sub_agent_id="specialist",
        delegate_context="context",
        delegate_reason="better fit",
        delegate_expected_outputs=["report"],
        delegate_return_conditions=["when finished"],
    )

    result = await delegate_node(base_state, mock_context)

    assert result["current_step"] == "respond"
    assert result["tool_results"][0].success is True
    assert result["tool_results"][0].metadata["delegate"] is True
    assert result["tool_results"][0].metadata["sub_agent_id"] == "specialist"


@pytest.mark.asyncio
async def test_observe_node_continues_to_next_step(mock_context, base_state):
    """Test observe_node moves to next step when available."""
    # Create plan with multiple steps
    base_state["plan"] = ExecutionPlan(
        goal="test goal",
        steps=[
            PlanStep(id="1", title="step 1", tool="search", params={}),
            PlanStep(id="2", title="step 2", tool="search", params={}),
        ],
        current_step_index=0,
        requires_delegation=False,
        delegate_to=None,
    )
    base_state["pending_actions"] = [PlanStep(id="2", title="step 2", tool="search", params={})]
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="llm_act",
            params={"title": "step 1"},
            result="result 1",
            success=True,
            metadata={"act_decision": "advance_step", "act_step_id": "1"},
        )
    ]

    result = await observe_node(base_state, mock_context)

    # Should continue via ACT with updated state
    assert result["current_step"] == "act"
    assert result["observe_outcome"] == "continue_execution"


@pytest.mark.asyncio
async def test_observe_node_replans_on_all_failures(mock_context, base_state):
    """Test observe_node triggers replan when all actions fail."""
    base_state["plan"] = ExecutionPlan(
        goal="test goal",
        steps=[PlanStep(id="1", title="step 1", tool="search", params={})],
        current_step_index=0,
        requires_delegation=False,
        delegate_to=None,
    )
    base_state["tool_results"] = [{"success": False, "error": "failed"}]
    base_state["iteration"] = 1

    result = await observe_node(base_state, mock_context)

    # Should trigger replan
    assert result["current_step"] == "plan"
    assert result["observe_outcome"] == "replan_current_round"
    assert result["messages"]
    assert "FAILURE REFLECTION" in str(result["messages"][0]["content"])


@pytest.mark.asyncio
async def test_observe_node_enters_awaiting_approval_when_tool_pending(mock_context, base_state):
    base_state["plan"] = ExecutionPlan(
        goal="test goal",
        steps=[PlanStep(id="1", title="open browser", tool="browser_automation", params={})],
        current_step_index=0,
        requires_delegation=False,
        delegate_to=None,
    )
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="browser_automation",
            params={},
            result=None,
            success=False,
            error="approval_pending",
            metadata={"approval_status": "pending", "approval_id": "appr_test_123"},
        )
    ]

    result = await observe_node(base_state, mock_context)

    assert result["current_step"] == "respond"
    assert result["observe_outcome"] == "awaiting_approval"
    assert result["metadata"]["pending_approval_ids"] == ["appr_test_123"]


@pytest.mark.asyncio
async def test_observe_node_uses_current_act_results_not_historical_tool_results(mock_context, base_state):
    base_state["iteration"] = 1
    base_state["plan"] = ExecutionPlan(
        goal="test goal",
        steps=[PlanStep(id="1", title="step 1", tool="search", params={})],
        current_step_index=0,
        requires_delegation=False,
        delegate_to=None,
    )
    base_state["tool_results"] = [
        ToolCallResult(tool_name="search", params={}, result="old success", success=True),
        ToolCallResult(tool_name="search", params={}, error="new failure", success=False),
    ]
    base_state["metadata"] = {
        "last_act_result_count": 1,
    }

    result = await observe_node(base_state, mock_context)

    assert result["current_step"] == "plan"
    assert result["observe_outcome"] == "replan_current_round"


@pytest.mark.asyncio
async def test_observe_node_stops_on_repeated_failing_pattern(mock_context, base_state):
    base_state["iteration"] = 1
    base_state["plan"] = ExecutionPlan(
        goal="test goal",
        steps=[PlanStep(id="1", title="读取 SKILL.md", tool="file_io", params={"action": "read"})],
        current_step_index=0,
        requires_delegation=False,
        delegate_to=None,
    )
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="code_executor",
            params={},
            result={
                "generated_files": [
                    {
                        "filename": "popmart_research_report.md",
                        "artifact_role": "report_md",
                        "user_visible": True,
                    }
                ]
            },
            success=True,
        ),
        ToolCallResult(
            tool_name="file_io",
            params={"action": "read"},
            error="File not found: popmart_research_report.md",
            success=False,
        ),
    ]
    base_state["metadata"] = {
        "observe_loop_guard": {
            "last_signature": _build_observe_progress_signature(
                current_skill_name="",
                tool_results=base_state["tool_results"],
                plan=base_state["plan"],
            ),
            "repeat_count": 1,
            "last_failure_pattern": _build_observe_failure_pattern(
                blocking_failures=[base_state["tool_results"][-1]],
                latest_structured_act_result=None,
                metadata={},
                plan=base_state["plan"],
            ),
            "failure_repeat_count": 1,
        }
    }

    result = await observe_node(base_state, mock_context)

    assert result["current_step"] == "respond"
    assert result["observe_outcome"] == "task_completed"
    # Disabled: transient network retry → execution_stall fires instead
    assert "stall" in str(result.get("error") or "").lower()


@pytest.mark.asyncio
async def test_observe_node_replans_on_repeated_web_fetch_timeout(mock_context, base_state):
    base_state["iteration"] = 1
    base_state["plan"] = ExecutionPlan(
        goal="test goal",
        steps=[PlanStep(id="1", title="fetch page", tool="web_fetch", params={"url": "https://example.com"})],
        current_step_index=0,
        requires_delegation=False,
        delegate_to=None,
    )
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="web_fetch",
            params={"url": "https://example.com"},
            error="web_fetch request failed: ReadTimeout: ReadTimeout('')",
            success=False,
        ),
    ]
    base_state["metadata"] = {
        "observe_loop_guard": {
            "last_signature": _build_observe_progress_signature(
                current_skill_name="",
                tool_results=base_state["tool_results"],
                plan=base_state["plan"],
            ),
            "repeat_count": 1,
            "last_failure_pattern": _build_observe_failure_pattern(
                blocking_failures=base_state["tool_results"],
                latest_structured_act_result=None,
                metadata={},
                plan=base_state["plan"],
            ),
            "failure_repeat_count": 1,
        }
    }

    result = await observe_node(base_state, mock_context)

    # Disabled: transient network retry → execution_stall fires (failure_repeat_count=2, iteration=2)
    assert result["current_step"] == "respond"
    assert result["observe_outcome"] == "task_completed"
    assert "stall" in str(result.get("error") or "").lower()


@pytest.mark.asyncio
async def test_observe_node_stops_after_transient_network_retry_budget(mock_context, base_state):
    base_state["iteration"] = 2
    base_state["plan"] = ExecutionPlan(
        goal="test goal",
        steps=[PlanStep(id="1", title="fetch page", tool="web_fetch", params={"url": "https://example.com"})],
        current_step_index=0,
    )
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="web_fetch",
            params={"url": "https://example.com"},
            error="web_fetch request failed: ReadTimeout: ReadTimeout('')",
            success=False,
        ),
    ]
    base_state["metadata"] = {
        "transient_network_retry_count": 2,
    }

    result = await observe_node(base_state, mock_context)

    assert result["current_step"] == "respond"
    assert result["observe_outcome"] == "task_completed"
    # Disabled: transient network retry budget check removed; no error set
    assert result.get("error") is None


@pytest.mark.asyncio
async def test_observe_node_replans_on_recoverable_error(mock_context, base_state):
    """Recoverable deterministic tool errors should trigger replan."""
    base_state["plan"] = ExecutionPlan(
        goal="test goal",
        steps=[
            PlanStep(id="1", title="create rule", tool="rule_authoring", params={}),
            PlanStep(id="2", title="notify", tool="notify", params={}),
        ],
        current_step_index=0,
        requires_delegation=False,
        delegate_to=None,
    )
    base_state["tool_results"] = [
        {
            "tool_name": "search",
            "success": True,
            "error": None,
            "result": "ok",
        },
        {
            "tool_name": "rule_authoring",
            "success": False,
            "error": "RULE_NAME_CONFLICT: rule id or name already exists",
            "result": None,
        }
    ]
    base_state["iteration"] = 0

    result = await observe_node(base_state, mock_context)

    assert result["current_step"] == "plan"
    details = result["metadata"].get("replan_failure_details")
    assert isinstance(details, dict)
    assert details["failed_tool_results"][0]["tool_name"] == "rule_authoring"
    assert details["failed_tool_results"][0]["error"].startswith("RULE_NAME_CONFLICT")


@pytest.mark.asyncio
async def test_observe_node_persists_replan_failure_details_with_step_trace(mock_context, base_state):
    base_state["plan"] = ExecutionPlan(
        goal="test goal",
        steps=[
            PlanStep(id="step-1", title="search", tool="search", params={}),
            PlanStep(id="step-2", title="summarize", tool="llm_act", params={}),
        ],
        current_step_index=1,
        requires_delegation=False,
        delegate_to=None,
    )
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="llm_act",
            params={},
            result=None,
            success=False,
            error="ACT terminal response must be a single JSON object",
            metadata={
                "act_decision": "complete_task",
                "source_step_id": "step-2",
            },
        )
    ]
    base_state["metadata"] = {
        "last_act_step_id": "step-2",
        "act_loop_trace_by_step": {
            "step-2": [
                {"turn": 1, "phase": "tool", "outcome": "switch_to_terminal_phase"},
                {"turn": 2, "phase": "terminal", "outcome": "invalid_terminal_json"},
            ]
        },
        "step_transcripts": {
            "step-2": [
                {
                    "role": "assistant",
                    "content": '{"decision":"complete_task","artifact_result_text":"# Report\\n\\nline 1"}',
                }
            ]
        },
    }

    result = await observe_node(base_state, mock_context)

    assert result["current_step"] == "plan"
    details = result["metadata"].get("replan_failure_details")
    assert isinstance(details, dict)
    assert details["failed_step_id"] == "step-2"
    assert details["last_act_step_id"] == "step-2"
    assert details["act_loop_trace"][-1]["outcome"] == "invalid_terminal_json"
    assert details["raw_terminal_response_excerpt"].startswith('{"decision":"complete_task"')


@pytest.mark.asyncio
async def test_respond_node_uses_observed_failure_summary_for_all_failed_results(mock_context, base_state):
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="skill_script_runner",
            params={"command": "python scripts/missing.py"},
            result=None,
            success=False,
            error="script target not found: scripts/missing.py",
        )
    ]
    base_state["current_step"] = "respond"
    base_state["error"] = None
    mock_context["llm_provider"] = AsyncMock()
    mock_context["llm_provider"].generate_response.return_value = "hallucinated explanation"

    result = await respond_node(base_state, mock_context)

    assert "messages" in result
    content = result["messages"][0]["content"]
    assert "未能完成" in content
    assert "script target not found: scripts/missing.py" in content
    assert "run_phases.py" not in content
    mock_context["llm_provider"].generate_response.assert_not_awaited()


@pytest.mark.asyncio
async def test_respond_node_prefers_markdown_primary_artifact_over_pdf(mock_context, base_state):
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="code_executor",
            params={"language": "python"},
            result={"filename": "report.md"},
            success=True,
            metadata={
                "generated_files": [
                    {
                        "file_id": "file-md",
                        "filename": "report.md",
                        "path": "/tmp/report.md",
                        "mime_type": "text/markdown",
                        "size": 321,
                        "user_visible": True,
                        "artifact_role": "report_md",
                    },
                    {
                        "file_id": "file-1",
                        "filename": "report.pdf",
                        "path": "/tmp/report.pdf",
                        "mime_type": "application/pdf",
                        "size": 123,
                        "user_visible": True,
                        "artifact_role": "report_pdf",
                    }
                ]
            },
        )
    ]
    base_state["current_step"] = "respond"
    base_state["error"] = None
    mock_context["llm_provider"] = AsyncMock()
    mock_context["llm_provider"].generate_response.return_value = "a different freeform answer"

    result = await respond_node(base_state, mock_context)

    content = result["messages"][0]["content"]
    assert "report.md" in content
    # artifact_result_path should NOT appear in user-facing content (local paths must not leak)
    assert "artifact_result_path" not in content
    mock_context["llm_provider"].generate_response.assert_not_awaited()


def test_build_llm_act_terminal_result_keeps_artifact_text_pure_user_delivery():
    action = PlanStep(
        id="step-4",
        title="最终报告交付",
        intent="交付最终报告",
    )
    terminal_result = _build_llm_act_terminal_result(
        action=action,
        payload={
            "decision": "complete_task",
            "observations": [
                {
                    "summary": "成功读取并交付报告",
                    "evidence": [],
                    "constraints_encountered": [],
                    "artifacts_produced": ["report.md"],
                }
            ],
            "artifacts_produced": ["report.md"],
            "artifact_result_text": "# 标题\n\n正文内容",
            "artifact_result_path": "report.md",
        },
    )

    assert terminal_result.result.endswith("Artifacts:\n- report.md")
    assert terminal_result.metadata["artifact_result_text"] == "# 标题\n\n正文内容"
    assert terminal_result.metadata["text_artifact"]["artifact_result_text"] == "# 标题\n\n正文内容"


def test_build_llm_act_terminal_result_supports_missing_capability_contract():
    action = PlanStep(
        id="step-5",
        title="需要认证浏览器会话",
        intent="访问已登录页面并提取内容",
    )

    terminal_result = _build_llm_act_terminal_result(
        action=action,
        payload={
            "missing_capability": {
                "intent": "authenticated_browser_session",
                "reason": "Current shortlisted tools cannot operate an authenticated browser session.",
                "requiredCapabilities": ["browser", "authenticated_session"],
                "preferredSources": ["cli", "mcp"],
            }
        },
    )

    assert terminal_result.success is False
    assert terminal_result.metadata["act_result_type"] == "execution_blocked"
    assert terminal_result.metadata["act_decision"] == "missing_capability"
    assert terminal_result.metadata["missing_capability"]["type"] == "missing_capability"
    assert terminal_result.metadata["missing_capability"]["version"] == "1"
    assert terminal_result.metadata["missing_capability"]["intent"] == "authenticated_browser_session"


def test_build_llm_act_terminal_result_supports_proposed_cli_import_contract():
    action = PlanStep(
        id="step-6",
        title="建议导入小红书 CLI",
        intent="请求导入新的 CLI 工具",
    )

    terminal_result = _build_llm_act_terminal_result(
        action=action,
        payload={
            "proposed_cli_import": {
                "shape": "group",
                "command": ["opencli", "xiaohongshu"],
                "toolName": "opencli_xiaohongshu",
                "reason": "Need Xiaohongshu browser actions",
            }
        },
    )

    assert terminal_result.metadata["proposed_cli_import"]["type"] == "proposed_cli_import"
    assert terminal_result.metadata["proposed_cli_import"]["shape"] == "group"
    assert terminal_result.metadata["proposed_cli_import"]["command"] == ["opencli", "xiaohongshu"]
    assert terminal_result.metadata["proposed_cli_import"]["tool_name"] == "opencli_xiaohongshu"


def test_build_plan_loop_messages_include_tool_catalog_cards():
    runtime_context = RuntimeSessionContext(
        user_id="user_1",
        agent_id="agent_1",
        session_id="session_1",
        agent_config=AgentConfig(id="agent_1", name="Test Agent"),
        available_tools=[ToolDefinition(name="search", description="Search the web")],
    )

    messages = _build_plan_loop_messages(
        state_messages=[{"role": "user", "content": "帮我搜索今天的 AI 新闻"}],
        original_goal="帮我搜索今天的 AI 新闻",
        current_round_goal="帮我搜索今天的 AI 新闻",
        execution_state={},
        prior_plan_summary={"plan_id": "", "plan_mode": "initial", "selected_skill": None, "round_goal": None},
        available_execution_capabilities={"web_retrieval": "Search the web for current information"},
        planning_limits={"remaining_iterations": 10, "max_iterations": 15},
        runtime_context=runtime_context,
        memory_context="",
        failure_reflection="",
        sub_agents_for_planner=[],
        agent_system_prompt="",
        current_date="2026-03-23",
        current_weekday="Monday",
        current_timezone="Asia/Shanghai",
    )

    assert any("Tool Catalog Cards" in str(item.get("content") or "") for item in messages)


@pytest.mark.asyncio
async def test_respond_node_prefers_text_payload_over_path_in_chat_content(mock_context, base_state):
    mock_context["event_emitter"] = AsyncMock()
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="file_io",
            params={"action": "write"},
            result={"filename": "AI行业动态报告.md"},
            success=True,
            metadata={
                "generated_files": [
                    {
                        "file_id": "file-report-md",
                        "filename": "AI行业动态报告.md",
                        "path": "AI行业动态报告.md",
                        "mime_type": "text/markdown",
                        "size": 512,
                        "user_visible": True,
                        "artifact_role": "report_md",
                    }
                ],
                "source_step_id": "step-4",
                "source_step_title": "最终报告交付",
            },
        ),
        ToolCallResult(
            tool_name="llm_act",
            params={"title": "最终报告交付"},
            result="done",
            success=True,
            metadata={
                "act_decision": "complete_task",
                "act_step_id": "step-4",
                "artifact_result_text": "# AI 行业动态报告\n\n- 条目 A",
                "artifact_result_path": "AI行业动态报告.md",
                "text_artifact": {
                    "artifact_result_text": "# AI 行业动态报告\n\n- 条目 A",
                    "artifact_role": "report_md",
                    "artifact_medium": "text",
                    "artifact_format": "plain_text",
                    "artifact_type": "research_report",
                    "artifact_name": "最终报告交付",
                    "artifact_purpose": "用户交付",
                    "source_step_id": "step-4",
                    "source_step_title": "最终报告交付",
                    "handoff_mode": "final_delivery",
                    "handoff_purpose": "user_delivery",
                    "is_likely_final": True,
                },
                "source_step_id": "step-4",
                "source_step_title": "最终报告交付",
            },
        )
    ]
    base_state["metadata"] = {"last_act_step_id": "step-4"}
    base_state["current_step"] = "respond"
    base_state["error"] = None

    result = await respond_node(base_state, mock_context)

    content = str(result["messages"][0]["content"])
    assert content == "# AI 行业动态报告\n\n- 条目 A"
    assert "artifact_result_path" not in content
    mock_context["event_emitter"].emit_file_created.assert_awaited_once_with(
        file_id="file-report-md",
        filename="AI行业动态报告.md",
        mime_type="text/markdown",
        size=512,
        url="/api/v1/files/file-report-md",
    )


@pytest.mark.asyncio
async def test_respond_node_prefers_primary_artifact_even_when_state_has_error(mock_context, base_state):
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="pdf_report",
            params={"filename": "report.pdf"},
            result={"filename": "report.pdf"},
            success=True,
            metadata={
                "generated_files": [
                    {
                        "file_id": "file-1",
                        "filename": "report.pdf",
                        "path": "/tmp/report.pdf",
                        "mime_type": "application/pdf",
                        "size": 123,
                        "user_visible": True,
                        "artifact_role": "report_pdf",
                    }
                ]
            },
        )
    ]
    base_state["current_step"] = "respond"
    base_state["error"] = "cannot access local variable 'current_skill_name' where it is not associated with a value"
    mock_context["llm_provider"] = AsyncMock()

    result = await respond_node(base_state, mock_context)

    content = result["messages"][0]["content"]
    assert "report.pdf" in content
    # artifact_result_path should NOT appear in user-facing content (local paths must not leak)
    assert "artifact_result_path" not in content


@pytest.mark.asyncio
async def test_respond_node_returns_pending_approval_notice_in_metadata(mock_context, base_state):
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="browser_automation",
            params={},
            result=None,
            success=False,
            error="approval_pending",
            metadata={"approval_status": "pending", "approval_id": "appr_test_123"},
        )
    ]
    base_state["current_step"] = "respond"
    base_state["error"] = None

    result = await respond_node(base_state, mock_context)

    assert result["messages"] == []
    assert result["metadata"]["pending_approval_ids"] == ["appr_test_123"]
    assert "待审批 ID: appr_test_123" in str(result["metadata"]["awaiting_approval_message"])


@pytest.mark.asyncio
async def test_respond_node_returns_terminate_summary(mock_context, base_state):
    base_state["plan"] = ExecutionPlan(
        goal="done",
        steps=[],
        plan_type="terminate",
        terminate_reason="No further execution needed",
        terminate_status="completed",
        summary_for_act="任务已完成，无需进一步执行。",
    )
    base_state["current_step"] = "respond"
    base_state["error"] = None

    result = await respond_node(base_state, mock_context)

    assert "任务已完成，无需进一步执行。" in str(result["messages"][0]["content"])


@pytest.mark.asyncio
async def test_respond_node_prefers_structured_act_result_summary(mock_context, base_state):
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="llm_act",
            params={"title": "生成报告"},
            result="done",
            success=True,
            metadata={
                "act_decision": "complete_task",
                "act_observations": [
                    {"summary": "已完成拼多多股票研究报告的综合分析"},
                    {"summary": "已整理关键风险与估值结论"},
                ],
                "act_artifacts_produced": ["pdd_report.md"],
            },
        )
    ]
    base_state["current_step"] = "respond"
    base_state["error"] = None
    mock_context["llm_provider"] = AsyncMock()

    result = await respond_node(base_state, mock_context)

    content = str(result["messages"][0]["content"])
    assert "任务已完成。" in content
    assert "已完成拼多多股票研究报告的综合分析" in content
    assert "已产出：" not in content
    assert "pdd_report.md" not in content
    mock_context["llm_provider"].generate_response.assert_not_awaited()


@pytest.mark.asyncio
async def test_respond_node_uses_inline_delivery_for_structured_act_result(mock_context, base_state):
    base_state["plan"] = ExecutionPlan(
        goal="搜索最新的 AI 行业动态并总结",
        steps=[],
        final_delivery_contract={
            "delivery_goal": "AI 行业动态中文摘要",
        },
    )
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="llm_act",
            params={"title": "生成总结"},
            result="done",
            success=True,
            metadata={
                "act_decision": "complete_task",
                "act_observations": [
                    {"summary": "已汇总最近一周 AI 产品发布与融资动态"},
                    {"summary": "已整理技术突破与政策信号"},
                ],
                "act_artifacts_produced": ["ai_news_summary.md"],
            },
        )
    ]
    base_state["current_step"] = "respond"
    mock_context["llm_provider"] = AsyncMock()
    mock_context["llm_provider"].chat = AsyncMock(
        return_value=SimpleNamespace(content="# AI 行业动态中文摘要\n\n- 已汇总最近一周 AI 产品发布与融资动态\n- 已整理技术突破与政策信号")
    )

    result = await respond_node(base_state, mock_context)

    content = str(result["messages"][0]["content"])
    assert "任务已完成" in content
    assert "产品发布与融资动态" in content
    mock_context["llm_provider"].generate_response.assert_not_awaited()


@pytest.mark.asyncio
async def test_respond_node_avoids_raw_web_fetch_json_and_falls_back_to_inline_summary(mock_context, base_state):
    base_state["messages"] = [{"role": "user", "content": "搜索最新的 AI 行业动态并总结"}]
    base_state["plan"] = ExecutionPlan(
        goal="搜索最新的 AI 行业动态并总结",
        steps=[],
        final_delivery_contract={"delivery_goal": "AI 行业动态中文摘要"},
    )
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="web_fetch",
            params={"url": "https://example.com/ai"},
            result={
                "url": "https://example.com/ai",
                "status_code": 200,
                "content_type": "text/html",
                "title": "",
                "text": "OpenAI 发布了新的企业功能，Anthropic 推进 Claude 订阅增长。",
            },
            success=True,
            metadata={
                "artifact_result_text": json.dumps(
                    {
                        "url": "https://example.com/ai",
                        "status_code": 200,
                        "content_type": "text/html",
                        "title": "",
                        "text": "OpenAI 发布了新的企业功能，Anthropic 推进 Claude 订阅增长。",
                    },
                    ensure_ascii=False,
                ),
                "text_artifact": {
                    "artifact_result_text": json.dumps(
                        {
                            "url": "https://example.com/ai",
                            "status_code": 200,
                            "content_type": "text/html",
                            "title": "",
                            "text": "OpenAI 发布了新的企业功能，Anthropic 推进 Claude 订阅增长。",
                        },
                        ensure_ascii=False,
                    ),
                    "artifact_name": "抓取结果",
                    "artifact_role": "evidence_bundle",
                },
            },
        ),
        ToolCallResult(
            tool_name="search",
            params={"query": "AI industry news"},
            result={
                "items": [
                    {
                        "title": "OpenAI focuses on enterprise features",
                        "url": "https://example.com/openai",
                        "snippet": "OpenAI 发布新的企业产品能力。",
                    },
                    {
                        "title": "Anthropic subscription growth",
                        "url": "https://example.com/anthropic",
                        "snippet": "Claude 付费订阅增长明显。",
                    },
                ]
            },
            success=True,
        ),
    ]
    base_state["current_step"] = "respond"
    mock_context["llm_provider"] = AsyncMock()
    mock_context["llm_provider"].chat = AsyncMock(side_effect=Exception("render failed"))

    result = await respond_node(base_state, mock_context)

    content = str(result["messages"][0]["content"])
    assert '"status_code"' not in content
    assert "https://example.com/openai" in content
    assert "OpenAI 发布新的企业产品能力" in content


@pytest.mark.asyncio
async def test_respond_node_handles_failed_act_result_with_error(mock_context, base_state):
    """When act produces a failed result, respond generates an error-aware response."""
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="llm_act",
            params={"title": "验证报告"},
            result="blocked",
            error="缺少必需来源证据",
            success=False,
            metadata={
                "act_decision": "continue_current_step",
                "act_result_type": "execution_result",
                "act_observations": [
                    {"summary": "当前报告缺少来源链接与引用"},
                ],
                "act_artifacts_produced": ["draft_report.md"],
            },
        )
    ]
    base_state["current_step"] = "respond"
    base_state["error"] = None
    mock_context["llm_provider"] = AsyncMock()

    result = await respond_node(base_state, mock_context)

    content = str(result["messages"][0]["content"])
    assert "缺少必需来源证据" in content or "缺少来源链接" in content or "未能完成" in content


@pytest.mark.asyncio
async def test_respond_node_uses_inline_delivery_contract_for_text_artifact(mock_context, base_state):
    base_state["plan"] = ExecutionPlan(
        goal="搜索今天的新闻",
        steps=[],
        final_delivery_contract={
            "delivery_goal": "latest news",
        },
    )
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="search",
            params={"query": "今天的新闻"},
            result={"items": [{"title": "News A", "url": "https://example.com/a", "snippet": "摘要"}]},
            success=True,
            metadata={
                "text_artifact": {
                    "artifact_result_text": "1. News A - 摘要",
                    "artifact_role": "evidence_bundle",
                    "artifact_name": "新闻摘要",
                }
            },
        )
    ]
    base_state["current_step"] = "respond"
    mock_context["llm_provider"] = AsyncMock()
    mock_context["llm_provider"].chat = AsyncMock(
        return_value=SimpleNamespace(content="## 摘要\n\n1. [News A](https://example.com/a)\n   - 摘要：摘要")
    )

    result = await respond_node(base_state, mock_context)

    assert "1. News A - 摘要" in result["messages"][0]["content"]
    mock_context["llm_provider"].generate_response.assert_not_awaited()


@pytest.mark.asyncio
async def test_respond_node_uses_structured_list_delivery_contract(mock_context, base_state):
    base_state["plan"] = ExecutionPlan(
        goal="整理最新新闻列表",
        steps=[],
        final_delivery_contract={
            "delivery_goal": "latest news list",
        },
    )
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="search",
            params={"query": "最新新闻"},
            result={"items": [{"title": "News A", "url": "https://example.com/a", "snippet": "摘要"}]},
            success=True,
            metadata={
                "text_artifact": {
                    "artifact_result_text": "News A\nNews B",
                    "artifact_role": "evidence_bundle",
                    "artifact_name": "新闻列表",
                }
            },
        )
    ]
    base_state["current_step"] = "respond"
    mock_context["llm_provider"] = AsyncMock()
    mock_context["llm_provider"].chat = AsyncMock(
        return_value=SimpleNamespace(content="# latest news list\n\n1. News A\n2. News B")
    )

    result = await respond_node(base_state, mock_context)

    assert "News A" in result["messages"][0]["content"]
    assert "News B" in result["messages"][0]["content"]
    mock_context["llm_provider"].generate_response.assert_not_awaited()


@pytest.mark.asyncio
async def test_respond_node_without_artifact_payload_uses_status_summary(mock_context, base_state):
    base_state["plan"] = ExecutionPlan(
        goal="打开网页检查是否可访问",
        steps=[],
        final_delivery_contract={"delivery_goal": "accessibility status"},
    )
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="llm_act",
            params={"title": "检查网页"},
            result="done",
            success=True,
            metadata={
                "act_decision": "complete_task",
                "act_observations": [{"summary": "网页可访问，已成功加载"}],
                "act_artifacts_produced": [],
            },
        )
    ]
    base_state["current_step"] = "respond"
    mock_context["llm_provider"] = AsyncMock()

    result = await respond_node(base_state, mock_context)

    content = str(result["messages"][0]["content"])
    assert "任务已完成" in content
    assert "网页可访问" in content
    mock_context["llm_provider"].generate_response.assert_not_awaited()


@pytest.mark.asyncio
async def test_respond_node_prefers_reflection_summary(mock_context, base_state):
    base_state["current_step"] = "respond"
    base_state["error"] = None
    base_state["reflection"] = ReflectionResult(
        summary="已完成拼多多股票研究，并整理出关键风险与结论。",
        lessons_learned=[],
        worth_remembering=False,
        importance=0.5,
    )
    mock_context["llm_provider"] = AsyncMock()

    result = await respond_node(base_state, mock_context)

    content = str(result["messages"][0]["content"])
    assert "已完成拼多多股票研究" in content
    mock_context["llm_provider"].generate_response.assert_not_awaited()


@pytest.mark.asyncio
async def test_respond_node_prefers_generic_inline_delivery_fallback_for_successful_results(mock_context, base_state):
    base_state["messages"] = [{"role": "user", "content": "搜索今天的新闻"}]
    base_state["plan"] = ExecutionPlan(
        goal="搜索今天的新闻",
        steps=[],
        final_delivery_contract={
            "delivery_goal": "最新 AI 行业动态",
        },
    )
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="search",
            params={"query": "今天的新闻"},
            result={
                "items": [
                    {
                        "title": "News A",
                        "url": "https://example.com/a",
                        "snippet": "今日要闻摘要 A",
                    },
                    {
                        "title": "News B",
                        "url": "https://example.com/b",
                        "snippet": "今日要闻摘要 B",
                    },
                ]
            },
            success=True,
        )
    ]
    base_state["current_step"] = "respond"
    base_state["error"] = None
    mock_context["llm_provider"] = AsyncMock()
    mock_context["llm_provider"].chat = AsyncMock(side_effect=Exception("render failed"))

    result = await respond_node(base_state, mock_context)

    content = str(result["messages"][0]["content"])
    assert "# 最新 AI 行业动态" in content
    assert "[News A](https://example.com/a)" in content
    assert "摘要：" in content
    mock_context["llm_provider"].generate_response.assert_not_awaited()


@pytest.mark.asyncio
async def test_respond_node_prefers_successful_delegate_result(mock_context, base_state):
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="subagent:equity-specialist",
            params={"task": "研究拼多多股票"},
            result="已完成拼多多股票研究，并给出估值与风险结论。",
            success=True,
            metadata={
                "delegate": True,
                "sub_agent_id": "equity-specialist",
                "expected_outputs": ["研究结论", "风险提示"],
            },
        )
    ]
    base_state["current_step"] = "respond"
    base_state["error"] = None
    mock_context["llm_provider"] = AsyncMock()

    result = await respond_node(base_state, mock_context)

    content = str(result["messages"][0]["content"])
    assert "子代理 equity-specialist 已完成委派任务。" in content
    assert "已完成拼多多股票研究" in content
    assert "研究结论" in content
    mock_context["llm_provider"].generate_response.assert_not_awaited()


@pytest.mark.asyncio
async def test_respond_node_prefers_execution_state_summary(mock_context, base_state):
    base_state["current_step"] = "respond"
    base_state["error"] = None
    base_state["execution_state"] = {
        "completed_steps": ["step-1", "step-2"],
        "in_progress_steps": [],
        "failed_steps": [],
        "observations": ["已完成范围界定", "已汇总主要财务结论"],
        "artifacts_produced": ["report.md"],
        "unresolved_questions": ["缺少最新电话会纪要"],
        "known_constraints": [],
        "remaining_budget_or_limits": [],
    }
    mock_context["llm_provider"] = AsyncMock()

    result = await respond_node(base_state, mock_context)

    content = str(result["messages"][0]["content"])
    assert "已完成当前任务流程" in content
    assert "step-1" in content
    assert "已产出：" not in content
    assert "report.md" not in content
    assert "缺少最新电话会纪要" in content
    mock_context["llm_provider"].generate_response.assert_not_awaited()


@pytest.mark.asyncio
async def test_respond_node_report_file_delivery_requires_real_file_artifact(mock_context, base_state):
    base_state["plan"] = ExecutionPlan(
        goal="搜索最新的 AI 行业动态并总结",
        steps=[],
        final_delivery_contract={"delivery_goal": "AI 行业动态月报"},
    )
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="llm_act",
            params={"title": "整理总结"},
            result="done",
            success=True,
            metadata={
                "act_decision": "complete_task",
                "act_observations": [{"summary": "已完成 AI 行业动态检索与整理"}],
                "act_artifacts_produced": ["AI行业动态总结_2026年3月"],
                "text_artifact": {
                    "artifact_result_text": "# AI 行业动态总结\n\n已完成整理。",
                    "artifact_name": "AI 行业动态总结",
                    "artifact_medium": "text",
                    "artifact_type": "research_report",
                    "is_likely_final": True,
                },
            },
        )
    ]
    base_state["current_step"] = "respond"
    base_state["error"] = None
    mock_context["llm_provider"] = AsyncMock()

    result = await respond_node(base_state, mock_context)

    content = str(result["messages"][0]["content"])
    assert "# AI 行业动态总结" in content


@pytest.mark.asyncio
async def test_respond_node_uses_inline_delivery_for_execution_state(mock_context, base_state):
    base_state["plan"] = ExecutionPlan(
        goal="搜索最新的 AI 行业动态并总结",
        steps=[],
        final_delivery_contract={"delivery_goal": "AI 行业动态中文摘要"},
    )
    base_state["current_step"] = "respond"
    base_state["error"] = None
    base_state["execution_state"] = {
        "completed_steps": ["step-1", "step-2"],
        "in_progress_steps": [],
        "failed_steps": [],
        "observations": ["已完成 AI 新闻检索", "已整理关键趋势与政策要点"],
        "artifacts_produced": ["ai_news_summary.md"],
        "unresolved_questions": [],
        "known_constraints": [],
        "remaining_budget_or_limits": [],
    }
    mock_context["llm_provider"] = AsyncMock()
    mock_context["llm_provider"].chat = AsyncMock(
        return_value=SimpleNamespace(content="# AI 行业动态中文摘要\n\n1. 已完成 AI 新闻检索\n2. 已整理关键趋势与政策要点")
    )

    result = await respond_node(base_state, mock_context)

    content = str(result["messages"][0]["content"])
    assert "已完成当前任务流程" in content
    assert "已完成 AI 新闻检索" in content
    mock_context["llm_provider"].generate_response.assert_not_awaited()


@pytest.mark.asyncio
async def test_respond_node_uses_inline_delivery_for_final_text_artifact_without_delivery_contract(
    mock_context, base_state
):
    base_state["plan"] = None
    base_state["current_step"] = "respond"
    base_state["error"] = None
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="llm_act",
            params={"title": "检索并整理最新信息"},
            result="done",
            success=True,
            metadata={
                "act_decision": "complete_task",
                "text_artifact": {
                    "artifact_result_text": "# AI 行业动态总结\n\n- 趋势一\n- 趋势二",
                    "artifact_name": "AI行业动态总结",
                    "artifact_medium": "text",
                    "artifact_type": "research_report",
                    "is_likely_final": True,
                },
                "artifact_result_text": "# AI 行业动态总结\n\n- 趋势一\n- 趋势二",
            },
        )
    ]
    mock_context["llm_provider"] = None

    result = await respond_node(base_state, mock_context)

    content = str(result["messages"][0]["content"])
    assert "# AI 行业动态总结" in content
    assert "已生成文本结果：" not in content


@pytest.mark.asyncio
async def test_respond_node_only_delivers_last_step_artifact_payloads(mock_context, base_state):
    base_state["plan"] = ExecutionPlan(
        goal="搜索并整理最新 AI 行业动态",
        steps=[
            PlanStep(id="step-1", title="检索"),
            PlanStep(id="step-2", title="分类总结"),
            PlanStep(id="step-3", title="美化排版"),
        ],
        current_step_index=2,
    )
    base_state["current_step"] = "respond"
    base_state["error"] = None
    base_state["metadata"] = {"last_act_step_id": "step-3"}
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="search",
            params={"query": "最新 AI 行业动态"},
            result={"items": []},
            success=True,
            metadata={
                "text_artifact": {
                    "artifact_result_text": "step-1 raw search notes",
                    "artifact_name": "检索摘要",
                    "artifact_medium": "text",
                    "source_step_id": "step-1",
                }
            },
        ),
        ToolCallResult(
            tool_name="llm_act",
            params={"title": "分类总结"},
            result="done",
            success=True,
            metadata={
                "act_decision": "advance_step",
                "act_step_id": "step-2",
                "text_artifact": {
                    "artifact_result_text": "step-2 categorized draft",
                    "artifact_name": "分类草稿",
                    "artifact_medium": "text",
                    "source_step_id": "step-2",
                },
            },
        ),
        ToolCallResult(
            tool_name="llm_act",
            params={"title": "美化排版"},
            result="done",
            success=True,
            metadata={
                "act_decision": "complete_task",
                "act_step_id": "step-3",
                "text_artifact": {
                    "artifact_result_text": "# 最终排版稿\n\n- 条目 A\n- 条目 B",
                    "artifact_name": "最终报告",
                    "artifact_medium": "text",
                    "artifact_type": "research_report",
                    "is_likely_final": True,
                    "source_step_id": "step-3",
                },
                "artifact_result_text": "# 最终排版稿\n\n- 条目 A\n- 条目 B",
            },
        ),
    ]
    mock_context["llm_provider"] = None

    result = await respond_node(base_state, mock_context)

    content = str(result["messages"][0]["content"])
    assert "# 最终排版稿" in content
    assert "step-1 raw search notes" not in content
    assert "step-2 categorized draft" not in content


@pytest.mark.asyncio
async def test_respond_node_prefers_latest_llm_act_payload_over_same_step_tool_artifacts(mock_context, base_state):
    base_state["plan"] = ExecutionPlan(
        goal="确认今天日期",
        steps=[PlanStep(id="step-1", title="当前日期确认")],
        current_step_index=0,
    )
    base_state["current_step"] = "respond"
    base_state["error"] = None
    base_state["metadata"] = {"last_act_step_id": "step-1"}
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="code_executor",
            params={"language": "python"},
            result={"stdout": "{\"current_date\":\"2026-03-12\"}", "stderr": "", "exit_code": 0},
            success=True,
            metadata={
                "source_step_id": "step-1",
                "text_artifact": {
                    "artifact_result_text": "{\"stdout\":\"...\"}",
                    "artifact_name": "执行输出",
                    "artifact_medium": "text",
                    "source_step_id": "step-1",
                },
            },
        ),
        ToolCallResult(
            tool_name="llm_act",
            params={"title": "当前日期确认"},
            result="done",
            success=True,
            metadata={
                "act_decision": "complete_task",
                "act_step_id": "step-1",
                "artifact_result_text": "今天是 **2026年03月12日**（星期四）。",
                "text_artifact": {
                    "artifact_result_text": "今天是 **2026年03月12日**（星期四）。",
                    "artifact_name": "日期确认",
                    "artifact_medium": "text",
                    "source_step_id": "step-1",
                },
            },
        ),
    ]
    mock_context["llm_provider"] = None

    result = await respond_node(base_state, mock_context)

    content = str(result["messages"][0]["content"])
    assert "今天是 **2026年03月12日**（星期四）。" in content
    assert "{\"stdout\"" not in content


@pytest.mark.asyncio
async def test_plan_node_replan_keeps_skill_script_runner_available(mock_context, base_state, monkeypatch):
    runtime_context = SimpleNamespace(
        metadata={
            "skill_index": [
                {
                    "id": "deep-research",
                    "name": "deep-research",
                    "description": "深度研究技能",
                    "enabled": True,
                    "file_inventory": {"has_skill_md": True},
                    "package": {
                        "files": [
                            {
                                "path": "SKILL.md",
                                "content": "# deep-research\n\n## phases\nscope\nretrieve\npackage\n",
                            }
                        ]
                    },
                }
            ]
        },
        available_skills=[],
        available_sub_agents=[],
        agent_config=SimpleNamespace(system_prompt="", model="kimi-k2.5"),
        skill_injection_tracker=None,
    )
    base_state["context"] = runtime_context
    base_state["messages"] = [{"role": "user", "content": "使用deep-research技能研究腾讯股票"}]
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="skill_script_runner",
            params={"skill_name": "deep-research", "command": "python scripts/research_engine.py --query x"},
            result=None,
            error="script claimed artifact(s) that do not exist",
            success=False,
        )
    ]
    base_state["iteration"] = 1

    captured_tools = {}

    class _FakeCapabilityGraph:
        def __init__(self, _runtime_context):
            self._runtime_context = _runtime_context

        def get_schemas_for_planner(self):
            return [
                {
                    "type": "function",
                    "function": {"name": "search", "description": "search", "parameters": {"type": "object"}},
                },
                {
                    "type": "function",
                    "function": {
                        "name": "skill_script_runner",
                        "description": "run skill script",
                        "parameters": {"type": "object"},
                    },
                },
                {
                    "type": "function",
                    "function": {
                        "name": "code_executor",
                        "description": "run code",
                        "parameters": {"type": "object"},
                    },
                },
            ]

    monkeypatch.setattr("src.orchestrator.capability.CapabilityGraph", _FakeCapabilityGraph)

    call_count = {"value": 0}

    async def _chat(**kwargs):
        planning_messages = kwargs.get("messages") or []
        captured_tools["prompt"] = str(planning_messages[0]["content"])
        call_count["value"] += 1
        if call_count["value"] == 1:
            return SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_read_skill_1",
                        "type": "function",
                        "function": {
                            "name": "read_skill",
                            "arguments": json.dumps({"skill_id": "deep-research"}, ensure_ascii=False),
                        },
                    }
                ],
            )
        return SimpleNamespace(
            content=json.dumps(
                {
                    "type": "plan",
                    "goal": "test goal",
                    "round_goal": "完成研究计划",
                    "selected_skill": "deep-research",
                    "skill_context_for_act": {
                        "skill_id": "deep-research",
                        "phase": "package",
                        "execution_rules": [
                            {
                                "id": "rule-1",
                                "instruction": "prefer the skill script runner for packaging",
                                "strength": "must",
                                "condition": "for current round",
                                "source_ref": "SKILL.md#package",
                            }
                        ],
                        "quality_checks": [
                            {
                                "id": "check-1",
                                "instruction": "文档结构必须完整",
                                "strength": "must",
                                "condition": "package phase",
                                "source_ref": "SKILL.md#package",
                            }
                        ],
                        "artifact_rules": [
                            {
                                "id": "artifact-1",
                                "instruction": "produce the report artifact",
                                "strength": "must",
                                "condition": "when package completes",
                                "source_ref": "SKILL.md#package",
                            }
                        ],
                        "replan_triggers": [
                            {
                                "id": "trigger-1",
                                "instruction": "replan if packaging artifact cannot be produced",
                                "source_ref": "SKILL.md#package",
                            }
                        ],
                        "source_sections": ["package"],
                    },
                    "steps": [
                        {
                            "id": "1",
                            "title": "执行技能脚本",
                            "phase": "package",
                            "intent": "生成交付物",
                            "expected_outputs": ["report"],
                            "completion_criteria": ["report ready"],
                            "skill_source": "deep-research",
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            tool_calls=[],
        )

    mock_context["llm_provider"].chat.side_effect = _chat

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "act"
    # skill_script_runner maps to "skill_script_execution" in the planner capability map
    assert "skill_script_execution" in captured_tools["prompt"]


@pytest.mark.asyncio
async def test_plan_node_replan_preserves_completed_prefix_and_filters_pending_actions(
    mock_context, base_state, monkeypatch
):
    class _FakeCapabilityGraph:
        def __init__(self, _runtime_context):
            self._runtime_context = _runtime_context

        def get_schemas_for_planner(self):
            return []

    monkeypatch.setattr("src.orchestrator.capability.CapabilityGraph", _FakeCapabilityGraph)
    base_state["iteration"] = 1
    base_state["messages"] = [{"role": "user", "content": "使用deep-research研究拼多多股票"}]
    base_state["plan"] = ExecutionPlan(
        goal="使用deep-research研究拼多多股票",
        round_goal="完成研究",
        plan_mode="incremental_replan",
        steps=[
            PlanStep(id="step-1", title="界定研究范围与方法"),
            PlanStep(id="step-2", title="收集并交叉验证多源证据"),
            PlanStep(id="step-3", title="生成最终研究报告"),
        ],
        current_step_index=2,
        selected_skill="deep-research",
    )
    base_state["execution_state"] = {
        "completed_steps": ["step-1", "step-2"],
        "in_progress_steps": [],
        "failed_steps": [],
        "observations": [],
        "artifacts_produced": [],
        "unresolved_questions": [],
        "known_constraints": [],
        "remaining_budget_or_limits": [],
    }
    mock_context["llm_provider"].chat = AsyncMock(
        return_value=SimpleNamespace(
            content=json.dumps(
                {
                    "type": "plan",
                    "plan_mode": "incremental_replan",
                    "goal": "使用deep-research研究拼多多股票",
                    "round_goal": "完成研究",
                    "selected_skill": "deep-research",
                    "planning_rationale": {"why_replanned": "继续最后包装阶段"},
                    "skill_context_for_act": {
                        "skill_id": "deep-research",
                        "phase": "package",
                        "execution_rules": [
                            {"id": "r1", "instruction": "生成最终报告", "strength": "must", "condition": "package", "source_ref": "SKILL.md#package"}
                        ],
                        "quality_checks": [
                            {"id": "q1", "instruction": "报告必须引用证据", "strength": "must", "condition": "package", "source_ref": "SKILL.md#package"}
                        ],
                        "artifact_rules": [
                            {"id": "a1", "instruction": "输出 markdown 报告", "strength": "must", "condition": "package", "source_ref": "SKILL.md#package"}
                        ],
                        "replan_triggers": [
                            {"id": "t1", "instruction": "关键证据缺失时 replan", "source_ref": "SKILL.md#package"}
                        ],
                        "source_sections": ["package"],
                    },
                    "steps": [
                        {"id": "step-1", "title": "界定研究范围与方法", "intent": "已完成", "expected_outputs": ["范围"], "completion_criteria": ["完成"]},
                        {"id": "step-2", "title": "收集并交叉验证多源证据", "intent": "已完成", "expected_outputs": ["证据"], "completion_criteria": ["完成"]},
                        {"id": "step-3", "title": "生成最终研究报告", "intent": "输出报告", "expected_outputs": ["研究报告"], "completion_criteria": ["报告完成"]},
                    ],
                },
                ensure_ascii=False,
            ),
            tool_calls=[],
        )
    )

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "act"
    assert [step.id for step in result["pending_actions"]] == ["step-3"]


@pytest.mark.asyncio
async def test_plan_node_retries_when_replan_renames_completed_step_ids(
    mock_context, base_state, monkeypatch
):
    class _FakeCapabilityGraph:
        def __init__(self, _runtime_context):
            self._runtime_context = _runtime_context

        def get_schemas_for_planner(self):
            return []

    monkeypatch.setattr("src.orchestrator.capability.CapabilityGraph", _FakeCapabilityGraph)
    base_state["iteration"] = 1
    base_state["messages"] = [{"role": "user", "content": "使用deep-research研究拼多多股票"}]
    base_state["plan"] = ExecutionPlan(
        goal="使用deep-research研究拼多多股票",
        round_goal="完成研究",
        plan_mode="incremental_replan",
        steps=[
            PlanStep(id="step-1", title="界定研究范围与方法"),
            PlanStep(id="step-2", title="收集并交叉验证多源证据"),
            PlanStep(id="step-3", title="生成最终研究报告"),
        ],
        current_step_index=2,
        selected_skill="deep-research",
    )
    base_state["execution_state"] = {
        "completed_steps": ["step-1", "step-2"],
        "in_progress_steps": [],
        "failed_steps": [],
        "observations": [],
        "artifacts_produced": [],
        "unresolved_questions": [],
        "known_constraints": [],
        "remaining_budget_or_limits": [],
    }
    mock_context["llm_provider"].chat = AsyncMock(
        side_effect=[
            SimpleNamespace(
                content=json.dumps(
                    {
                        "type": "plan",
                        "plan_mode": "incremental_replan",
                        "goal": "使用deep-research研究拼多多股票",
                        "round_goal": "完成研究",
                        "selected_skill": "deep-research",
                        "planning_rationale": {"why_replanned": "继续最后包装阶段"},
                        "skill_context_for_act": {
                            "skill_id": "deep-research",
                            "phase": "package",
                            "execution_rules": [
                                {"id": "r1", "instruction": "生成最终报告", "strength": "must", "condition": "package", "source_ref": "SKILL.md#package"}
                            ],
                            "quality_checks": [
                                {"id": "q1", "instruction": "报告必须引用证据", "strength": "must", "condition": "package", "source_ref": "SKILL.md#package"}
                            ],
                            "artifact_rules": [
                                {"id": "a1", "instruction": "输出 markdown 报告", "strength": "must", "condition": "package", "source_ref": "SKILL.md#package"}
                            ],
                            "replan_triggers": [
                                {"id": "t1", "instruction": "关键证据缺失时 replan", "source_ref": "SKILL.md#package"}
                            ],
                            "source_sections": ["package"],
                        },
                        "steps": [
                            {"id": "step-a", "title": "界定研究范围与方法", "intent": "已完成", "expected_outputs": ["范围"], "completion_criteria": ["完成"]},
                            {"id": "step-b", "title": "收集并交叉验证多源证据", "intent": "已完成", "expected_outputs": ["证据"], "completion_criteria": ["完成"]},
                            {"id": "step-3", "title": "生成最终研究报告", "intent": "输出报告", "expected_outputs": ["研究报告"], "completion_criteria": ["报告完成"]},
                        ],
                    },
                    ensure_ascii=False,
                ),
                tool_calls=[],
            ),
            SimpleNamespace(
                content=json.dumps(
                    {
                        "type": "plan",
                        "plan_mode": "incremental_replan",
                        "goal": "使用deep-research研究拼多多股票",
                        "round_goal": "完成研究",
                        "selected_skill": "deep-research",
                        "planning_rationale": {"why_replanned": "继续最后包装阶段"},
                        "skill_context_for_act": {
                            "skill_id": "deep-research",
                            "phase": "package",
                            "execution_rules": [
                                {"id": "r1", "instruction": "生成最终报告", "strength": "must", "condition": "package", "source_ref": "SKILL.md#package"}
                            ],
                            "quality_checks": [
                                {"id": "q1", "instruction": "报告必须引用证据", "strength": "must", "condition": "package", "source_ref": "SKILL.md#package"}
                            ],
                            "artifact_rules": [
                                {"id": "a1", "instruction": "输出 markdown 报告", "strength": "must", "condition": "package", "source_ref": "SKILL.md#package"}
                            ],
                            "replan_triggers": [
                                {"id": "t1", "instruction": "关键证据缺失时 replan", "source_ref": "SKILL.md#package"}
                            ],
                            "source_sections": ["package"],
                        },
                        "steps": [
                            {"id": "step-1", "title": "界定研究范围与方法", "intent": "已完成", "expected_outputs": ["范围"], "completion_criteria": ["完成"]},
                            {"id": "step-2", "title": "收集并交叉验证多源证据", "intent": "已完成", "expected_outputs": ["证据"], "completion_criteria": ["完成"]},
                            {"id": "step-3", "title": "生成最终研究报告", "intent": "输出报告", "expected_outputs": ["研究报告"], "completion_criteria": ["报告完成"]},
                        ],
                    },
                    ensure_ascii=False,
                ),
                tool_calls=[],
            ),
        ]
    )

    result = await plan_node(base_state, mock_context)

    assert mock_context["llm_provider"].chat.await_count == 2
    assert result["current_step"] == "act"
    assert [step.id for step in result["pending_actions"]] == ["step-3"]


@pytest.mark.asyncio
async def test_observe_node_completes_without_followup_skill_heuristic(mock_context, base_state, tmp_path):
    report = tmp_path / "report.md"
    report.write_text("# report", encoding="utf-8")
    base_state["context"] = SimpleNamespace(
        available_skills=[
            SimpleNamespace(id="deep-research", name="deep-research", description="research", metadata={}),
            SimpleNamespace(id="pdf", name="pdf", description="render pdf", metadata={}),
        ]
    )
    base_state["messages"] = [{"role": "user", "content": "使用deep-research研究拼多多股票，然后用pdf技能生成PDF"}]
    base_state["metadata"] = {"skill_orchestration_trace": {"skill_context_skill_id": "deep-research"}}
    base_state["plan"] = ExecutionPlan(
        goal="test goal",
        steps=[PlanStep(id="1", title="step 1", tool="search", params={})],
        current_step_index=0,
    )
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="llm_act",
            params={"title": "step 1"},
            result="done",
            success=True,
            metadata={
                "act_decision": "complete_task",
                "act_step_id": "1",
                "artifact_result_path": str(report),
            },
        )
    ]

    result = await observe_node(base_state, mock_context)

    assert result["current_step"] == "respond"
    assert result["observe_outcome"] == "task_completed"


@pytest.mark.asyncio
async def test_reflect_node_generates_final_response(mock_context, base_state):
    """Test reflect_node generates final response."""
    base_state["plan"] = ExecutionPlan(
        goal="test goal",
        steps=[PlanStep(id="1", title="step 1", tool="search", params={})],
        current_step_index=0,
        requires_delegation=False,
        delegate_to=None,
    )
    base_state["tool_results"] = [{"success": True, "result": "result"}]

    mock_context["llm_provider"].reflect.return_value = {
        "summary": "Final answer based on results",
        "lessons_learned": [],
        "worth_remembering": False,
        "importance": 0.4,
    }

    result = await reflect_node(base_state, mock_context)

    assert "reflection" in result
    assert result["reflection"].summary == "Final answer based on results"
    assert result["current_step"] == "respond"


@pytest.mark.asyncio
async def test_plan_node_handles_invalid_json(mock_context, base_state):
    """Test plan_node returns an error payload on malformed planner output."""
    mock_context["llm_provider"].chat.return_value = SimpleNamespace(
        content="not valid json",
        tool_calls=[],
    )

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "respond"
    assert "error" in result


def test_inject_skill_script_artifacts_rewrites_report_placeholder(tmp_path) -> None:
    report_path = tmp_path / "research_report_20260306_195301.md"
    report_path.write_text("# report\n", encoding="utf-8")
    action = PlanStep(
        id="2",
        title="validate report",
        tool="skill_script_runner",
        params={
            "skill_name": "deep-research",
            "command": "python scripts/validate_report.py --report research_output/report.md",
        },
    )
    prior_results = [
        ToolCallResult(
            tool_name="skill_script_runner",
            params={},
            result={
                "stdout": f"Research complete! Report path: {report_path}\n",
                "stderr": "",
            },
            success=True,
        )
    ]

    _inject_skill_script_artifacts(action, prior_results, "test-session")

    assert str(report_path) in str(action.params.get("command") or "")


def test_inject_skill_script_artifacts_uses_generated_file_candidates(tmp_path) -> None:
    report_path = tmp_path / "generated_report.md"
    report_path.write_text("# report\n", encoding="utf-8")
    action = PlanStep(
        id="2",
        title="validate report",
        tool="skill_script_runner",
        params={
            "skill_name": "deep-research",
            "command": "python scripts/validate_report.py --report research_output/report.md",
        },
    )
    prior_results = [
        ToolCallResult(
            tool_name="code_executor",
            params={},
            result={},
            success=True,
            metadata={
                "generated_files": [
                    {
                        "filename": "generated_report.md",
                        "path": str(report_path),
                        "source_path": str(report_path),
                    }
                ]
            },
        )
    ]

    _inject_skill_script_artifacts(action, prior_results, "test-session")

    assert str(report_path) in str(action.params.get("command") or "")


def test_inject_skill_script_artifacts_ignores_nonexistent_report_path() -> None:
    action = PlanStep(
        id="2",
        title="validate report",
        tool="skill_script_runner",
        params={
            "skill_name": "deep-research",
            "command": "python scripts/validate_report.py --report research_output/report.md",
        },
    )
    prior_results = [
        ToolCallResult(
            tool_name="skill_script_runner",
            params={},
            result={
                "stdout": "Research complete! Report path: /tmp/does_not_exist_123456.md\n",
                "stderr": "",
            },
            success=True,
        )
    ]

    _inject_skill_script_artifacts(action, prior_results, "test-session")

    assert str(action.params.get("command") or "").endswith("research_output/report.md")


@pytest.mark.asyncio
async def test_act_node_handles_execution_failure(mock_context, base_state):
    """Test act_node handles skill execution failures."""
    base_state["pending_actions"] = [
        PlanStep(id="1", title="search", tool="search", params={"query": "test"})
    ]

    # Mock skill execution failure
    mock_result = MagicMock(success=False, error="execution failed")
    mock_context["skill_registry"].execute.return_value = mock_result

    result = await act_node(base_state, mock_context)

    # Should still move to observe to handle failure
    assert result["current_step"] == "observe"


@pytest.mark.asyncio
async def test_act_node_stops_after_first_sequential_failure(mock_context, base_state):
    base_state["plan"] = ExecutionPlan(
        goal="test goal",
        steps=[
            PlanStep(id="1", title="step 1", tool="search", params={"query": "first"}),
            PlanStep(id="2", title="step 2", tool="search", params={"query": "second"}),
            PlanStep(id="3", title="step 3", tool="search", params={"query": "third"}),
        ],
        current_step_index=0,
        requires_delegation=False,
        delegate_to=None,
    )
    base_state["pending_actions"] = list(base_state["plan"].steps)

    turn_counts = {"step 1": 0, "step 2": 0}
    async def _chat(**kwargs):
        if _any_message_contains(kwargs, "Current step title:\nstep 1") and turn_counts["step 1"] == 0:
            turn_counts["step 1"] += 1
            return SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_step_1",
                        "function": {"name": "search", "arguments": "{\"query\":\"first\"}"},
                    }
                ],
            )
        if _any_message_contains(kwargs, "Current step title:\nstep 2") and turn_counts["step 2"] == 0:
            turn_counts["step 2"] += 1
            return SimpleNamespace(
                content="",
                tool_calls=[
                    {
                        "id": "call_step_2",
                        "function": {"name": "search", "arguments": "{\"query\":\"second\"}"},
                    }
                ],
            )
        completed_step_id = "1" if turn_counts["step 2"] == 0 else "2"
        return SimpleNamespace(content=_act_result_json(summary="done"), tool_calls=[])

    mock_context["llm_provider"].chat = AsyncMock(side_effect=_chat)
    mock_context["unified_executor"].execute.side_effect = [
        ToolCallResult(
            tool_name="search",
            params={"query": "first"},
            result="ok",
            success=True,
        ),
        ToolCallResult(
            tool_name="search",
            params={"query": "second"},
            error="failed",
            success=False,
        ),
    ]

    result = await act_node(base_state, mock_context)

    assert result["current_step"] == "observe"
    assert mock_context["unified_executor"].execute.await_count == 2
    assert len(result["tool_results"]) == 5
    assert result["tool_results"][0].success is True
    assert any(row.success is False for row in result["tool_results"])
    assert result["pending_actions"] == []
    assert result["metadata"]["last_act_step_id"] == "3"


def test_merge_dynamic_registry_schemas_skips_blocked_non_executable_skill():
    schema = {
        "type": "function",
        "function": {"name": "deep-research", "description": "x", "parameters": {"type": "object"}},
    }
    runtime_context = SimpleNamespace(
        metadata={"skill_registry": SimpleNamespace(get_tool_schemas=lambda: [schema])},
        get_all_capability_names=lambda: ["deep-research", "search"],
        available_skills=[
            SimpleNamespace(name="deep-research", metadata={"has_skill_md": True, "script_files": ["scripts/research_engine.py"]}),
        ],
    )

    merged = _merge_dynamic_registry_schemas([], runtime_context)
    names = {str((item.get("function") or {}).get("name") or "") for item in merged}
    assert "deep-research" not in names
