"""Tests for orchestrator state definitions."""

import pytest
from datetime import datetime, timezone

from src.orchestrator.execution import parse_plan_response
from src.orchestrator.state import (
    ExecutionPlan,
    PlanStep,
    ReflectionResult,
    ToolCallResult,
    build_session_time_metadata,
    create_initial_state,
    resolve_time_context,
)


class TestPlanStep:
    """Tests for PlanStep dataclass."""

    def test_create_plan_step(self):
        """Test creating a plan step."""
        step = PlanStep(
            id="step_1",
            title="Search",
            description="Search for information",
            tool="web_search",
            params={"query": "test"},
        )

        assert step.id == "step_1"
        assert step.title == "Search"
        assert step.tool == "web_search"
        assert step.params == {"query": "test"}
        assert step.parallel is False  # Default

    def test_plan_step_parallel(self):
        """Test parallel plan step."""
        step = PlanStep(
            id="step_1",
            title="Parallel task",
            parallel=True,
        )

        assert step.parallel is True

    def test_plan_step_optional_fields(self):
        """Test plan step with optional fields."""
        step = PlanStep(id="step_1", title="Simple step")

        assert step.tool is None
        assert step.params == {}


class TestExecutionPlan:
    """Tests for ExecutionPlan dataclass."""

    def test_create_execution_plan(self, sample_plan_step):
        """Test creating an execution plan."""
        plan = ExecutionPlan(
            goal="Complete the task",
            analysis="User wants to do something",
            steps=[sample_plan_step],
        )

        assert plan.goal == "Complete the task"
        assert len(plan.steps) == 1
        assert plan.current_step_index == 0

    def test_execution_plan_empty_steps(self):
        """Test execution plan with no steps."""
        plan = ExecutionPlan(goal="Simple question", steps=[])

        assert len(plan.steps) == 0
        assert plan.plan_type == "plan"

    def test_execution_plan_delegation(self):
        """Test execution plan requiring delegation."""
        plan = ExecutionPlan(
            goal="Complex task",
            steps=[],
            plan_type="delegate",
            sub_agent_id="specialist_agent",
        )

        assert plan.plan_type == "delegate"


class TestTimeContext:
    def test_build_session_time_metadata_defaults_to_system_timezone(self, monkeypatch):
        monkeypatch.delenv("TZ", raising=False)
        monkeypatch.setattr(
            "src.orchestrator.state._resolve_system_timezone_name",
            lambda: "Asia/Shanghai",
        )

        metadata = build_session_time_metadata()

        assert metadata["current_timezone"] == "Asia/Shanghai"
        assert len(metadata["current_date"]) == 10
        assert metadata["current_weekday"] in {
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
            "Sunday",
        }

    def test_build_session_time_metadata_invalid_timezone_falls_back_to_system(self, monkeypatch):
        monkeypatch.setattr(
            "src.orchestrator.state._resolve_system_timezone_name",
            lambda: "Asia/Shanghai",
        )

        metadata = build_session_time_metadata({"timezone": "Invalid/Timezone"})

        assert metadata["current_timezone"] == "Asia/Shanghai"

    def test_resolve_time_context_uses_system_timezone_when_metadata_missing(self, monkeypatch):
        monkeypatch.setattr(
            "src.orchestrator.state.build_session_time_metadata",
            lambda metadata=None, context=None: {
                "current_date": "2026-03-26",
                "current_weekday": "Thursday",
                "current_timezone": "Asia/Shanghai",
            },
        )

        current_date, current_weekday, current_timezone = resolve_time_context()

        assert current_date == "2026-03-26"
        assert current_weekday == "Thursday"
        assert current_timezone == "Asia/Shanghai"

    def test_parse_plan_response_supports_delegate_contract_v1_fields(self):
        plan = parse_plan_response(
            {
                "type": "delegate",
                "sub_agent_id": "equity-specialist",
                "goal": "研究拼多多股票",
                "round_goal": "完成股票研究",
                "why_delegate": "该任务更适合股票研究子代理",
                "context_for_delegate": "重点关注财务、估值和风险。",
                "expected_outputs": ["研究结论", "风险提示"],
                "return_conditions": ["完成研究报告", "无法获取关键数据时返回"],
            }
        )

        assert plan.plan_type == "delegate"
        assert plan.sub_agent_id == "equity-specialist"
        assert plan.round_goal == "完成股票研究"
        assert plan.delegate_reason == "该任务更适合股票研究子代理"
        assert plan.delegate_context == "重点关注财务、估值和风险。"
        assert plan.delegate_expected_outputs == ["研究结论", "风险提示"]
        assert plan.delegate_return_conditions == ["完成研究报告", "无法获取关键数据时返回"]

    def test_parse_plan_response_preserves_execution_clear_fields(self):
        plan = parse_plan_response(
            {
                "type": "plan",
                "goal": "Research task",
                "steps": [
                    {
                        "id": "step-1",
                        "title": "Define scope",
                        "phase": "scope",
                        "intent": "Define research scope",
                        "inputs_required": ["user goal", "prior report"],
                        "expected_outputs": ["scope"],
                        "execution_constraints": ["do not repeat completed work"],
                        "completion_criteria": ["scope is clear"],
                    }
                ],
            }
        )

        assert plan.steps[0].inputs_required == ["user goal", "prior report"]
        assert plan.steps[0].execution_constraints == ["do not repeat completed work"]

    def test_parse_plan_response_supports_wrapped_plan_payload(self):
        plan = parse_plan_response(
            {
                "plan": {
                    "goal": "Research task",
                    "selected_skill": "deep-research",
                    "steps": [
                        {
                            "id": "step-1",
                            "title": "Define scope",
                            "phase": "scope",
                            "intent": "Define research scope",
                            "inputs_required": ["user goal"],
                            "expected_outputs": ["scope"],
                            "execution_constraints": ["keep scope concrete"],
                            "completion_criteria": ["scope is clear"],
                        }
                    ],
                }
            }
        )

        assert plan.plan_type == "plan"
        assert plan.goal == "Research task"
        assert plan.selected_skill == "deep-research"
        assert len(plan.steps) == 1
        assert plan.steps[0].title == "Define scope"

    def test_parse_plan_response_flattens_phase_wrapped_steps(self):
        plan = parse_plan_response(
            {
                "plan": {
                    "goal": "Research task",
                    "phases": [
                        {
                            "name": "scope",
                            "steps": [
                                {
                                    "id": "step-1",
                                    "title": "Define scope",
                                    "intent": "Define research scope",
                                    "inputs_required": ["user goal"],
                                    "expected_outputs": ["scope"],
                                    "execution_constraints": ["keep scope concrete"],
                                    "completion_criteria": ["scope is clear"],
                                }
                            ],
                        }
                    ],
                }
            }
        )

        assert plan.plan_type == "plan"
        assert len(plan.steps) == 1
        assert plan.steps[0].phase == "scope"
        assert plan.steps[0].title == "Define scope"

    def test_parse_plan_response_infers_step_handoff_contracts(self):
        plan = parse_plan_response(
            {
                "type": "plan",
                "goal": "Research task",
                "intent_decomposition": {
                    "requested_operation": "research stock",
                    "delivery_goal": "deliver investment analysis",
                },
                "final_delivery_contract": {
                    "delivery_goal": "investment analysis",
                },
                "steps": [
                    {
                        "id": "step-1",
                        "title": "Retrieve evidence",
                        "phase": "retrieve",
                        "intent": "Collect evidence",
                        "expected_outputs": ["evidence bundle"],
                    },
                    {
                        "id": "step-2",
                        "title": "Write report",
                        "phase": "synthesize",
                        "intent": "Write final report",
                        "expected_outputs": ["report"],
                    },
                ],
            }
        )

        assert plan.intent_decomposition["delivery_goal"] == "deliver investment analysis"
        assert plan.final_delivery_contract["delivery_goal"] == "investment analysis"
        assert plan.steps[0].input_refs == []
        assert plan.steps[0].output_contract is not None
        assert plan.steps[0].output_contract.artifact_role == "evidence_bundle"
        assert plan.steps[1].input_refs[0].source_step_id == "step-1"
        assert plan.steps[1].input_refs[0].preferred_medium == "artifact_result_text"
        assert plan.steps[1].output_contract is not None
        assert plan.steps[1].output_contract.artifact_role == "report_md"

    def test_parse_plan_response_infers_final_delivery_contract(self):
        plan = parse_plan_response(
            {
                "type": "plan",
                "goal": "研究拼多多股票并生成报告",
                "steps": [
                    {
                        "id": "step-1",
                        "title": "收集证据",
                        "phase": "retrieve",
                        "expected_outputs": ["evidence bundle"],
                    },
                    {
                        "id": "step-2",
                        "title": "生成研究报告",
                        "phase": "synthesize",
                        "expected_outputs": ["report"],
                    },
                ],
            }
        )

        assert str(plan.final_delivery_contract["delivery_goal"]).strip()

    def test_parse_plan_response_preserves_time_context(self):
        plan = parse_plan_response(
            {
                "type": "plan",
                "goal": "研究拼多多股票并生成报告",
                "current_date": "2026-03-12",
                "current_weekday": "Thursday",
                "current_timezone": "Asia/Shanghai",
                "steps": [
                    {
                        "id": "step-1",
                        "title": "收集证据",
                        "phase": "retrieve",
                        "expected_outputs": ["evidence bundle"],
                    }
                ],
            }
        )

        assert plan.current_date == "2026-03-12"
        assert plan.current_weekday == "Thursday"
        assert plan.current_timezone == "Asia/Shanghai"

    def test_parse_plan_response_infers_intent_decomposition(self):
        plan = parse_plan_response(
            {
                "type": "plan",
                "goal": "用浏览器打开百度搜索最新新闻并整理给用户",
                "round_goal": "搜索最新新闻并整理结果",
                "steps": [
                    {
                        "id": "step-1",
                        "title": "搜索新闻",
                        "phase": "retrieve",
                        "expected_outputs": ["最新新闻摘要"],
                    }
                ],
            }
        )

        assert plan.intent_decomposition["requested_operation"] == "搜索最新新闻并整理结果"
        assert plan.intent_decomposition["delivery_goal"] == "最新新闻摘要"
        assert plan.intent_decomposition["execution_preference"]["must_use_tools"] is False

    def test_parse_plan_response_infers_delivery_goal_from_last_step_output(self):
        plan = parse_plan_response(
            {
                "type": "plan",
                "goal": "搜索最新的 AI 行业动态并总结",
                "steps": [
                    {
                        "id": "step-1",
                        "title": "搜索最新动态",
                        "phase": "retrieve",
                        "expected_outputs": ["AI 行业新闻结果列表"],
                    },
                    {
                        "id": "step-2",
                        "title": "生成总结",
                        "phase": "synthesize",
                        "expected_outputs": ["AI 行业动态中文摘要"],
                    },
                ],
            }
        )

        assert plan.final_delivery_contract["delivery_goal"] == "AI 行业动态中文摘要"
        assert plan.intent_decomposition["delivery_goal"] == "AI 行业动态中文摘要"


class TestToolCallResult:
    """Tests for ToolCallResult dataclass."""

    def test_successful_result(self):
        """Test successful tool call result."""
        result = ToolCallResult(
            tool_name="calculator",
            params={"expression": "2+2"},
            success=True,
            result=42,
            duration_ms=50,
        )

        assert result.success is True
        assert result.result == 42
        assert result.error is None

    def test_failed_result(self):
        """Test failed tool call result."""
        result = ToolCallResult(
            tool_name="web_search",
            params={"query": "test"},
            success=False,
            error="Connection timeout",
            duration_ms=5000,
        )

        assert result.success is False
        assert result.error == "Connection timeout"


class TestReflectionResult:
    """Tests for ReflectionResult dataclass."""

    def test_create_reflection(self):
        """Test creating a reflection result."""
        reflection = ReflectionResult(
            summary="Task completed successfully",
            lessons_learned=["API was slow", "Caching helped"],
            worth_remembering=True,
            importance=0.8,
        )

        assert reflection.summary == "Task completed successfully"
        assert len(reflection.lessons_learned) == 2
        assert reflection.worth_remembering is True
        assert reflection.importance == 0.8


class TestCreateInitialState:
    """Tests for create_initial_state function."""

    def test_create_initial_state(self):
        """Test creating initial agent state."""
        from src.orchestrator.context import RuntimeSessionContext, AgentConfig

        runtime_context = RuntimeSessionContext(
            user_id="user_456",
            agent_id="agent_456",
            session_id="sess_123",
            agent_config=AgentConfig(id="agent_456", name="Test Agent"),
        )

        state = create_initial_state(
            session_id="sess_123",
            agent_id="agent_456",
            user_message="Hello, please help me.",
            context=runtime_context,
        )

        assert state["session_id"] == "sess_123"
        assert state["agent_id"] == "agent_456"
        assert len(state["messages"]) == 1
        assert state["messages"][0]["role"] == "user"
        assert state["messages"][0]["content"] == "Hello, please help me."
        assert state["plan"] is None
        assert state["tool_results"] == []
        assert state["execution_state"]["completed_steps"] == []
        assert state["execution_state"]["observations"] == []
        assert state["current_step"] == "start"
        assert state["iteration"] == 0

    def test_create_initial_state_with_history(self):
        """Test creating initial state with message history."""
        from src.orchestrator.context import RuntimeSessionContext, AgentConfig

        runtime_context = RuntimeSessionContext(
            user_id="user_456",
            agent_id="agent_456",
            session_id="sess_123",
            agent_config=AgentConfig(id="agent_456", name="Test Agent"),
        )

        history_messages = [
            {"role": "user", "content": "第一轮问题"},
            {"role": "assistant", "content": "第一轮回答"},
            {"role": "user", "content": "第二轮问题"},
        ]

        state = create_initial_state(
            session_id="sess_123",
            agent_id="agent_456",
            user_message="Second message",
            context=runtime_context,
            history_messages=history_messages,
        )

        assert len(state["messages"]) == 4
        assert state["messages"][0]["content"] == "第一轮问题"
        assert state["messages"][1]["role"] == "assistant"
        assert state["messages"][2]["content"] == "第二轮问题"
        assert state["messages"][3]["content"] == "Second message"

    def test_create_initial_state_with_metadata(self):
        """Test creating initial state with metadata."""
        from src.orchestrator.context import RuntimeSessionContext, AgentConfig

        runtime_context = RuntimeSessionContext(
            user_id="user_456",
            agent_id="agent_456",
            session_id="sess_123",
            agent_config=AgentConfig(id="agent_456", name="Test Agent"),
        )

        metadata = {"user_id": "user_123", "request_id": "req_456"}

        state = create_initial_state(
            session_id="sess_123",
            agent_id="agent_456",
            user_message="Hello",
            context=runtime_context,
            metadata=metadata,
        )

        assert state["metadata"]["user_id"] == "user_123"
        assert state["metadata"]["request_id"] == "req_456"
        assert state["metadata"]["request_id"] == "req_456"
        assert state["metadata"]["current_date"]
        assert state["metadata"]["current_weekday"]
        assert state["metadata"]["current_timezone"]

    def test_create_initial_state_sets_session_time_metadata_once(self):
        """Test creating initial state injects a stable session time chain."""
        from src.orchestrator.context import RuntimeSessionContext, AgentConfig

        runtime_context = RuntimeSessionContext(
            user_id="user_456",
            agent_id="agent_456",
            session_id="sess_123",
            agent_config=AgentConfig(id="agent_456", name="Test Agent"),
            metadata={"timezone": "UTC"},
        )

        state = create_initial_state(
            session_id="sess_123",
            agent_id="agent_456",
            user_message="Hello",
            context=runtime_context,
        )

        assert state["metadata"]["current_timezone"] == "UTC"
        assert len(state["metadata"]["current_date"]) == 10
        datetime.strptime(state["metadata"]["current_date"], "%Y-%m-%d")
        assert state["metadata"]["current_weekday"] in {
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
            "Sunday",
        }
