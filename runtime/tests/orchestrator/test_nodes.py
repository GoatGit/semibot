"""Tests for orchestrator nodes (plan_node, act_node, observe_node, etc.)."""

from unittest.mock import AsyncMock, MagicMock
from types import SimpleNamespace
import pytest

from src.orchestrator.nodes import (
    plan_node,
    act_node,
    observe_node,
    reflect_node,
    _merge_dynamic_registry_schemas,
    _pick_skill_candidate,
    _is_explicit_skill_execution_request,
    _inject_minimum_execution_step,
    _enforce_structured_installer_gap,
    _enforce_skill_md_gate_step,
    _inject_skill_md_context_message,
    _extract_script_commands_from_skill_md,
    _enforce_hybrid_skill_script_runner_step,
    _rewrite_unexecutable_pending_actions,
    _sanitize_plan_tool_names,
    _normalize_step_skill_sources,
    _validate_plan_provenance,
    _inject_skill_script_artifacts,
    _enforce_report_synthesis_tool_preference,
    _enforce_file_io_write_params,
    _inject_skill_constraints_message,
)
from src.orchestrator.execution import ToolCallResult
from src.orchestrator.state import AgentState, ExecutionPlan, PlanStep


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
        "org_id": "test-org",
        "messages": [{"role": "user", "content": "test query"}],
        "plan": None,
        "pending_actions": [],
        "tool_results": [],
        "iteration": 0,
        "current_step": "plan",
        "final_response": None,
    }


@pytest.mark.asyncio
async def test_plan_node_creates_execution_plan(mock_context, base_state):
    """Test that plan_node creates a valid execution plan."""
    # Mock LLM response
    mock_context["llm_provider"].generate_plan.return_value = {
        "goal": "test goal",
        "steps": [{"id": "1", "title": "step 1", "tool": "search", "params": {}}],
    }

    result = await plan_node(base_state, mock_context)

    assert "plan" in result
    assert result["plan"] is not None
    assert result["plan"].goal == "test goal"
    assert len(result["plan"].steps) == 1
    assert result["current_step"] == "act"


@pytest.mark.asyncio
async def test_act_node_executes_pending_actions(mock_context, base_state):
    """Test that act_node executes pending actions."""
    # Setup state with pending action
    base_state["pending_actions"] = [
        PlanStep(id="1", title="search", tool="search", params={"query": "test"})
    ]

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

    # Should move to reflect when no more steps
    assert result["current_step"] == "reflect"
    assert result["observe_outcome"] == "task_completed"


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
    base_state["tool_results"] = [
        ToolCallResult(tool_name="search", params={}, result="result 1", success=True)
    ]

    result = await observe_node(base_state, mock_context)

    # Should move to next step
    assert result["current_step"] == "act"
    assert result["observe_outcome"] == "continue_execution"
    assert result["plan"].current_step_index == 1


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
    assert result["observe_outcome"] == "replan_current_round"
    assert result.get("messages")


def test_enforce_report_synthesis_tool_preference_skips_when_selected_skill():
    steps = [
        PlanStep(
            id="1",
            title="综合分析并生成报告",
            tool="search",
            params={"query": "腾讯股票 研究报告"},
        )
    ]

    rewritten = _enforce_report_synthesis_tool_preference(
        steps=steps,
        available_tool_names={"search", "code_executor"},
        session_id="test-session",
        selected_skill_name="deep-research",
    )

    assert rewritten == 0
    assert steps[0].tool == "search"


def test_enforce_file_io_write_params_skips_when_selected_skill():
    steps = [
        PlanStep(
            id="1",
            title="写入研究报告",
            tool="file_io",
            params={"action": "write", "path": "report.md"},
        )
    ]

    rewritten = _enforce_file_io_write_params(
        steps=steps,
        available_tool_names={"file_io", "code_executor"},
        session_id="test-session",
        selected_skill_name="deep-research",
    )

    assert rewritten == 0
    assert steps[0].tool == "file_io"


def test_inject_skill_constraints_message_does_not_preinject_script_inventory():
    messages = []

    _inject_skill_constraints_message(
        messages,
        {"id": "deep-research", "name": "deep-research", "file_inventory": {"has_skill_md": True}},
        {"skill_script_runner", "file_io"},
        skill_md_preloaded=True,
    )

    content = messages[-1]["content"]
    assert "available files under skill/scripts" not in content
    assert "validated script CLI signatures" not in content
    assert "command must be derived from SKILL.md instructions" in content


def test_validate_plan_provenance_rejects_non_script_skill_runner_command():
    plan = ExecutionPlan(
        goal="test",
        steps=[
            PlanStep(
                id="1",
                title="bad step",
                tool="skill_script_runner",
                params={"skill_name": "deep-research", "command": "echo hello && cat /tmp/x"},
                skill_source="deep-research",
            )
        ],
        current_step_index=0,
        requires_delegation=False,
        delegate_to=None,
    )

    errors = _validate_plan_provenance(plan)

    assert any("must reference a script file under scripts/" in item for item in errors)


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

    async def _generate_plan(**kwargs):
        available_tools = kwargs.get("available_tools") or []
        names = []
        for item in available_tools:
            fn = item.get("function") if isinstance(item, dict) else None
            if isinstance(fn, dict):
                names.append(str(fn.get("name") or ""))
        captured_tools["names"] = names
        return {
            "goal": "test goal",
            "steps": [
                {
                    "id": "1",
                    "title": "执行技能脚本",
                    "tool": "skill_script_runner",
                    "params": {
                        "skill_name": "deep-research",
                        "command": "python scripts/research_engine.py --query \"腾讯股票\"",
                    },
                    "skill_source": "deep-research",
                }
            ],
        }

    mock_context["llm_provider"].generate_plan.side_effect = _generate_plan

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "act"
    assert "skill_script_runner" in captured_tools["names"]


@pytest.mark.asyncio
async def test_observe_node_starts_next_round_when_followup_skill_and_artifact_exist(mock_context, base_state, tmp_path):
    report = tmp_path / "report.md"
    report.write_text("# report", encoding="utf-8")
    base_state["context"] = SimpleNamespace(
        available_skills=[
            SimpleNamespace(id="deep-research", name="deep-research", description="research", metadata={}),
            SimpleNamespace(id="pdf", name="pdf", description="render pdf", metadata={}),
        ]
    )
    base_state["messages"] = [{"role": "user", "content": "使用deep-research研究拼多多股票，然后用pdf技能生成PDF"}]
    base_state["metadata"] = {"skill_orchestration_trace": {"selected_skill": "deep-research"}}
    base_state["plan"] = ExecutionPlan(
        goal="test goal",
        steps=[PlanStep(id="1", title="step 1", tool="search", params={})],
        current_step_index=0,
        requires_delegation=False,
        delegate_to=None,
    )
    base_state["tool_results"] = [
        ToolCallResult(
            tool_name="code_executor",
            params={},
            result={"stdout": f"saved to: {report}", "stderr": ""},
            success=True,
        )
    ]

    result = await observe_node(base_state, mock_context)

    assert result["current_step"] == "plan"
    assert result["observe_outcome"] == "plan_next_round"
    assert "NEXT ROUND" in result["messages"][0]["content"]


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
    mock_context["llm_provider"].generate_plan.return_value = {
        "goal": "bad goal",
        "steps": object(),
    }

    result = await plan_node(base_state, mock_context)

    assert result["current_step"] == "respond"
    assert "error" in result


def test_normalize_step_skill_sources_backfills_runner_steps() -> None:
    plan = ExecutionPlan(
        goal="test",
        steps=[
            PlanStep(
                id="1",
                title="run script",
                tool="skill_script_runner",
                params={"skill_name": "deep-research", "command": "python scripts/run.py"},
            )
        ],
    )

    _normalize_step_skill_sources(plan)

    assert plan.steps[0].skill_source == "deep-research"


def test_validate_plan_provenance_rejects_mismatch() -> None:
    plan = ExecutionPlan(
        goal="test",
        steps=[
            PlanStep(
                id="1",
                title="run script",
                tool="skill_script_runner",
                params={"skill_name": "deep-research", "command": "python scripts/run.py"},
                skill_source="other-skill",
            )
        ],
    )

    errors = _validate_plan_provenance(plan)

    assert errors
    assert "does not match" in errors[0]


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
    assert len(result["tool_results"]) == 2
    assert result["tool_results"][0].success is True
    assert result["tool_results"][1].success is False
    assert len(result["pending_actions"]) == 1
    assert result["pending_actions"][0].id == "3"
    assert result["plan"].current_step_index == 0


def test_pick_skill_candidate_prefers_exact_name_match():
    runtime_context = SimpleNamespace(
        metadata={
            "skill_index": [
                {"id": "browser_automation", "description": "网页自动化操作", "tags": ["web"]},
                {"id": "deep-research", "description": "研究与报告", "tags": ["research"]},
            ]
        }
    )
    selected = _pick_skill_candidate(runtime_context, "请用 deep-research 研究阿里巴巴")
    assert isinstance(selected, dict)
    assert selected.get("id") == "deep-research"


def test_pick_skill_candidate_tie_break_prefers_enabled_skill():
    runtime_context = SimpleNamespace(
        metadata={
            "skill_index": [
                {"id": "skill-a", "description": "data processing", "tags": ["data"], "enabled": False},
                {"id": "skill-b", "description": "data processing", "tags": ["data"], "enabled": True},
            ]
        }
    )
    selected = _pick_skill_candidate(runtime_context, "need data processing")
    assert isinstance(selected, dict)
    assert selected.get("id") == "skill-b"


def test_pick_skill_candidate_matches_cross_language_skill_phrase():
    runtime_context = SimpleNamespace(
        metadata={
            "skill_index": [
                {"id": "deep-research", "description": "comprehensive analysis and research report", "tags": ["research"]},
                {"id": "browser_automation", "description": "web automation", "tags": ["web"]},
            ]
        }
    )
    selected = _pick_skill_candidate(runtime_context, "使用深度研究技能研究拼多多股票")
    assert isinstance(selected, dict)
    assert selected.get("id") == "deep-research"


def test_enforce_structured_installer_gap_drops_unstructured_installer_step():
    plan = ExecutionPlan(
        goal="test",
        steps=[
            PlanStep(id="1", title="install", tool="skill_installer", params={}),
            PlanStep(id="2", title="run", tool="code_executor", params={"language": "python", "code": "print(1)"}),
        ],
        current_step_index=0,
        requires_delegation=False,
        delegate_to=None,
    )
    gate = _enforce_structured_installer_gap(plan, {"code_executor", "skill_installer"}, "sess-1")
    assert [s.tool for s in plan.steps] == ["code_executor"]
    assert gate["dropped"] == 1


def test_enforce_skill_md_gate_step_inserts_first_step():
    plan = ExecutionPlan(
        goal="test",
        steps=[
            PlanStep(id="2", title="执行", tool="code_executor", params={"language": "python", "code": "print(1)"}),
        ],
        current_step_index=0,
        requires_delegation=False,
        delegate_to=None,
    )
    skill_item = {
        "id": "deep-research",
        "package": {"files": [{"path": "SKILL.md"}, {"path": "scripts/main.py"}]},
    }
    _enforce_skill_md_gate_step(plan, skill_item, {"file_io", "code_executor"}, "sess-2")
    assert plan.steps[0].tool == "file_io"
    assert plan.steps[0].params.get("action") == "read_skill_file"
    assert plan.steps[0].params.get("file_path") == "SKILL.md"


def test_inject_skill_md_context_message_uses_tool_context_role():
    messages = [{"role": "user", "content": "请研究网易"}]
    skill_item = {
        "id": "deep-research",
        "package": {
            "files": [
                {"path": "SKILL.md", "content": "# deep research\nfollow workflow"},
                {"path": "scripts/main.py", "content": "print('ok')"},
            ]
        },
    }

    injected = _inject_skill_md_context_message(messages, skill_item, "sess-skill")

    assert injected is True
    assert len(messages) == 2
    injected_msg = messages[-1]
    assert injected_msg["role"] == "tool"
    assert str(injected_msg.get("name") or "").startswith("tools/skill_context/deep-research")
    assert str(injected_msg.get("tool_call_id") or "").startswith("skill_ctx_")
    assert "<skill_md>" in str(injected_msg.get("content") or "")


def test_extract_script_commands_from_skill_md_parses_python_commands():
    content = """
    ## Verify
    python scripts/verify_citations.py --report out.md
    ```bash
    python scripts/validate_report.py --report out.md
    ```
    """
    commands = _extract_script_commands_from_skill_md(content)
    assert "python scripts/verify_citations.py --report out.md" in commands
    assert "python scripts/validate_report.py --report out.md" in commands


def test_enforce_hybrid_skill_script_runner_step_injects_step():
    plan = ExecutionPlan(goal="g", steps=[PlanStep(id="1", title="s", tool="search", params={"query": "q"})])
    injected = _enforce_hybrid_skill_script_runner_step(
        plan=plan,
        skill_item={"id": "deep-research"},
        available_tool_names={"search", "skill_script_runner"},
        script_commands=["python scripts/validate_report.py --report [path]"],
        session_id="sess-hybrid",
    )
    assert injected is True
    assert plan.steps[-1].tool == "skill_script_runner"
    assert plan.steps[-1].params.get("skill_name") == "deep-research"
    assert "scripts/validate_report.py" in str(plan.steps[-1].params.get("command") or "")




def test_sanitize_plan_tool_names_rewrites_skill_name_call():
    plan = ExecutionPlan(
        goal="test",
        steps=[PlanStep(id="1", title="执行深度研究", tool="deep-research", params={"query": "腾讯股票"})],
        current_step_index=0,
        requires_delegation=False,
        delegate_to=None,
    )
    skill_item = {"id": "deep-research"}

    result = _sanitize_plan_tool_names(plan, {"search", "code_executor"}, skill_item, "sess-3")

    assert result["rewritten"] == 1
    assert plan.steps[0].tool == "search"
    assert "query" in plan.steps[0].params


def test_sanitize_plan_tool_names_rewrites_skill_name_call_with_scripts_inventory():
    plan = ExecutionPlan(
        goal="test",
        steps=[PlanStep(id="1", title="执行深度研究", tool="deep-research", params={"query": "拼多多股票"})],
        current_step_index=0,
        requires_delegation=False,
        delegate_to=None,
    )
    skill_item = {
        "id": "deep-research",
        "file_inventory": {
            "has_skill_md": True,
            "has_scripts": True,
            "script_files": ["scripts/research_engine.py"],
        },
    }

    result = _sanitize_plan_tool_names(plan, {"deep-research", "search", "code_executor"}, skill_item, "sess-4")

    assert result["rewritten"] == 1
    assert plan.steps[0].tool == "search"
    assert "query" in plan.steps[0].params


def test_sanitize_plan_tool_names_rewrites_unregistered_tool_even_if_listed():
    plan = ExecutionPlan(
        goal="test",
        steps=[PlanStep(id="1", title="执行深度研究", tool="deep-research", params={"query": "拼多多"})],
        current_step_index=0,
        requires_delegation=False,
        delegate_to=None,
    )
    registry = SimpleNamespace(get_tool=lambda _name: None)
    result = _sanitize_plan_tool_names(
        plan,
        {"deep-research", "search"},
        {"id": "deep-research"},
        "sess-6",
        skill_registry=registry,
    )
    assert result["rewritten"] == 1
    assert plan.steps[0].tool == "search"


def test_sanitize_plan_tool_names_rewrites_blocked_skill_name():
    plan = ExecutionPlan(
        goal="test",
        steps=[PlanStep(id="1", title="执行深度研究", tool="deep-research", params={"query": "拼多多"})],
        current_step_index=0,
        requires_delegation=False,
        delegate_to=None,
    )
    result = _sanitize_plan_tool_names(
        plan,
        {"deep-research", "search"},
        None,
        "sess-7",
        blocked_skill_names={"deep-research"},
    )
    assert result["rewritten"] == 1
    assert plan.steps[0].tool == "search"


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


def test_inject_skill_md_context_message_reinjects_even_if_tracker_has_old_payload(monkeypatch):
    skill_item = {"id": "deep-research", "package": {"files": [{"path": "SKILL.md", "content": "# fresh"}]}}
    tracker = SimpleNamespace(
        is_injected=lambda *args, **kwargs: True,
        get_injected_content=lambda *_args, **_kwargs: "stale",
        mark_injected=lambda *args, **kwargs: None,
    )
    messages: list[dict[str, str]] = []

    injected = _inject_skill_md_context_message(messages, skill_item, "sess-skill-md", tracker)

    assert injected is True
    assert len(messages) == 1
    assert "# fresh" in messages[0]["content"]


def test_is_explicit_skill_execution_request_detects_cn_prompt():
    skill_item = {"id": "deep-research"}
    assert _is_explicit_skill_execution_request("使用deep-research技能研究拼多多股票", skill_item) is True
    assert _is_explicit_skill_execution_request("帮我研究拼多多股票", skill_item) is False


def test_inject_minimum_execution_step_adds_search_when_empty_plan():
    plan = ExecutionPlan(
        goal="test",
        steps=[],
        current_step_index=0,
        requires_delegation=False,
        delegate_to=None,
    )
    injected = _inject_minimum_execution_step(
        plan=plan,
        available_tool_names={"search", "code_executor"},
        user_text="使用deep-research技能研究拼多多股票",
        session_id="sess-5",
    )
    assert injected is True
    assert len(plan.steps) == 1
    assert plan.steps[0].tool == "search"


def test_rewrite_unexecutable_pending_actions_rewrites_blocked_skill():
    actions = [PlanStep(id="1", title="执行深度研究", tool="deep-research", params={"query": "拼多多"})]
    runtime_context = SimpleNamespace(
        metadata={"skill_registry": SimpleNamespace(list_tools=lambda: ["search"], list_skills=lambda: ["deep-research"])},
        available_skills=[
            SimpleNamespace(name="deep-research", metadata={"has_skill_md": True}),
        ],
    )
    rewritten, count = _rewrite_unexecutable_pending_actions(actions, runtime_context, None, "sess-8")
    assert count == 1
    assert rewritten[0].tool == "search"
    assert "query" in rewritten[0].params


def test_rewrite_unexecutable_pending_actions_without_context_rewrites_unknown_tool():
    actions = [PlanStep(id="1", title="执行深度研究", tool="deep-research", params={"query": "拼多多"})]
    rewritten, count = _rewrite_unexecutable_pending_actions(actions, None, None, "sess-9")
    assert count == 1
    assert rewritten[0].tool == "search"
