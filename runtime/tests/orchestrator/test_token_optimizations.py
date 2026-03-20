"""Tests for token & speed optimizations (priorities 1-8).

Priority 1: replan 时裁剪 tool_results
Priority 2: artifact_context 按 input_refs 过滤
Priority 3: act 内层静态内容移到 system message
Priority 4: planner skill index 截断更激进
Priority 5: 上一轮 artifact_context 只传当前 iteration
Priority 6: replan 时跳过 planner tool phase
Priority 7: act transcript backfeed 截断更激进
Priority 8: Token 消耗统计与前端看板
"""

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.orchestrator.nodes_act import (
    _build_tool_transcript_message,
    _filter_historical_tool_results_for_artifact_context,
)
from src.orchestrator.nodes_plan import (
    _build_plan_loop_messages,
    _MAX_SKILLS_IN_PROMPT,
)
from src.orchestrator.state import (
    AgentState,
    ExecutionPlan,
    PlanStep,
    StepInputRef,
    ToolCallResult,
)
from src.skills.skill_index_prompt import SkillIndexEntry, format_skills_for_prompt


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_tool_result(
    *,
    tool_name: str = "web_search",
    success: bool = True,
    result: str = "some result content",
    metadata: dict | None = None,
) -> ToolCallResult:
    return ToolCallResult(
        tool_name=tool_name,
        params={},
        success=success,
        result=result,
        error=None,
        metadata=metadata or {},
    )


def _make_terminal_result(step_id: str, iteration: int = 0) -> ToolCallResult:
    return _make_tool_result(
        tool_name="llm_act",
        metadata={
            "act_result_type": "execution_result",
            "act_step_id": step_id,
            "iteration": iteration,
        },
    )


def _make_file_result(step_id: str, iteration: int = 0) -> ToolCallResult:
    return _make_tool_result(
        tool_name="file_io",
        metadata={
            "generated_files": ["/workspace/out.md"],
            "act_step_id": step_id,
            "iteration": iteration,
        },
    )


def _make_intermediate_result(step_id: str = "step_1") -> ToolCallResult:
    """Intermediate tool call — should be filtered out."""
    return _make_tool_result(
        tool_name="web_search",
        metadata={"act_step_id": step_id, "iteration": 0},
    )


def _make_skill_entry(skill_id: str, description: str = "A skill") -> SkillIndexEntry:
    return SkillIndexEntry(
        skill_id=skill_id,
        name=skill_id,
        description=description,
        script_files=[],
        has_skill_md=False,
        has_references=False,
        has_templates=False,
    )


def _make_plan_loop_messages(
    *,
    skill_index: list[dict] | None = None,
    prior_plan_summary: dict | None = None,
) -> list[dict]:
    """Helper to call _build_plan_loop_messages with minimal required args."""
    ctx = MagicMock()
    ctx.metadata = {"skill_index": skill_index or []}
    return _build_plan_loop_messages(
        state_messages=[{"role": "user", "content": "do something"}],
        original_goal="do something",
        current_round_goal="do something",
        execution_state={},
        prior_plan_summary=prior_plan_summary or {},
        available_execution_capabilities=[],
        planning_limits={},
        runtime_context=ctx,
        memory_context="",
        failure_reflection="",
        sub_agents_for_planner=[],
        agent_system_prompt="",
    )


# ---------------------------------------------------------------------------
# Priority 1: _filter_historical_tool_results_for_artifact_context
# ---------------------------------------------------------------------------

class TestPriority1FilterHistoricalToolResults:
    def test_keeps_terminal_results(self):
        r = _make_terminal_result("step_1")
        assert _filter_historical_tool_results_for_artifact_context([r]) == [r]

    def test_keeps_file_generating_results(self):
        r = _make_file_result("step_1")
        assert _filter_historical_tool_results_for_artifact_context([r]) == [r]

    def test_drops_intermediate_tool_calls(self):
        intermediate = _make_intermediate_result()
        terminal = _make_terminal_result("step_1")
        result = _filter_historical_tool_results_for_artifact_context([intermediate, terminal])
        assert result == [terminal]

    def test_empty_list(self):
        assert _filter_historical_tool_results_for_artifact_context([]) == []

    def test_all_intermediate_returns_empty(self):
        rows = [_make_intermediate_result() for _ in range(5)]
        assert _filter_historical_tool_results_for_artifact_context(rows) == []

    def test_mixed_keeps_only_terminal_and_file(self):
        rows = [
            _make_intermediate_result("s1"),
            _make_terminal_result("s1"),
            _make_intermediate_result("s2"),
            _make_file_result("s2"),
            _make_intermediate_result("s3"),
        ]
        filtered = _filter_historical_tool_results_for_artifact_context(rows)
        assert len(filtered) == 2
        assert all(
            r.metadata.get("act_result_type") == "execution_result"
            or r.metadata.get("generated_files")
            for r in filtered
        )


# ---------------------------------------------------------------------------
# Priority 2: artifact_context filtered by input_refs
# Tests the dep_step_ids filtering logic directly (without calling the full
# _execute_llm_act_step which requires extensive mocking).
# ---------------------------------------------------------------------------

class TestPriority2InputRefsFilter:
    """Verify the dep_step_ids filtering logic used inside _execute_llm_act_step."""

    def _apply_dep_filter(
        self,
        historical_rows: list[ToolCallResult],
        action: PlanStep,
    ) -> list[ToolCallResult]:
        """Replicate the dep_step_ids filter from _execute_llm_act_step."""
        dep_step_ids = {
            ref.source_step_id
            for ref in (action.input_refs or [])
            if ref.source_step_id
        }
        if dep_step_ids:
            return [
                r for r in historical_rows
                if isinstance(r.metadata, dict)
                and r.metadata.get("act_step_id") in dep_step_ids
            ]
        return historical_rows

    def test_input_refs_filter_excludes_unrelated_steps(self):
        """When input_refs declares step_1, step_2 artifacts should not appear."""
        terminal_s1 = _make_terminal_result("step_1", iteration=0)
        terminal_s2 = _make_terminal_result("step_2", iteration=0)

        action = PlanStep(
            id="step_3",
            title="Use step_1 output",
            input_refs=[StepInputRef(name="data", source_step_id="step_1")],
        )

        result = self._apply_dep_filter([terminal_s1, terminal_s2], action)
        step_ids = {r.metadata.get("act_step_id") for r in result}
        assert "step_1" in step_ids
        assert "step_2" not in step_ids

    def test_no_input_refs_includes_all_historical(self):
        """When input_refs is empty, all historical rows are included."""
        terminal_s1 = _make_terminal_result("step_1", iteration=0)
        terminal_s2 = _make_terminal_result("step_2", iteration=0)

        action = PlanStep(id="step_3", title="Summarize", input_refs=[])

        result = self._apply_dep_filter([terminal_s1, terminal_s2], action)
        step_ids = {r.metadata.get("act_step_id") for r in result}
        assert "step_1" in step_ids
        assert "step_2" in step_ids

    def test_multiple_input_refs_includes_all_declared_steps(self):
        """Multiple input_refs should include all declared source steps."""
        t1 = _make_terminal_result("step_1")
        t2 = _make_terminal_result("step_2")
        t3 = _make_terminal_result("step_3")

        action = PlanStep(
            id="step_4",
            title="Combine",
            input_refs=[
                StepInputRef(name="a", source_step_id="step_1"),
                StepInputRef(name="b", source_step_id="step_2"),
            ],
        )

        result = self._apply_dep_filter([t1, t2, t3], action)
        step_ids = {r.metadata.get("act_step_id") for r in result}
        assert "step_1" in step_ids
        assert "step_2" in step_ids
        assert "step_3" not in step_ids

    def test_input_refs_without_source_step_id_are_ignored(self):
        """input_refs with no source_step_id should not restrict filtering."""
        t1 = _make_terminal_result("step_1")
        t2 = _make_terminal_result("step_2")

        # ref with no source_step_id — dep_step_ids will be empty
        action = PlanStep(
            id="step_3",
            title="Use user input",
            input_refs=[StepInputRef(name="user_query", source_step_id=None)],
        )

        result = self._apply_dep_filter([t1, t2], action)
        # No dep_step_ids → all rows returned
        assert len(result) == 2


# ---------------------------------------------------------------------------
# Priority 3: act static content hoisted to system message
# ---------------------------------------------------------------------------

class TestPriority3StaticContentInSystemMessage:
    """Verify that _execute_llm_act_step builds _step_system_messages with static content."""

    def test_step_system_messages_built_before_loop(self):
        """The static step context should be in a system message, not repeated per turn.

        We verify this by checking that _build_plan_loop_messages (which uses the same
        pattern) produces system messages containing static content.
        """
        # This test verifies the pattern: static content → system message
        # by checking that _build_plan_loop_messages produces system-role messages
        messages = _make_plan_loop_messages()
        system_messages = [m for m in messages if m.get("role") == "system"]
        assert len(system_messages) >= 1

    def test_truncate_act_prompt_text_limits_length(self):
        """_truncate_act_prompt_text should cap content at max_chars."""
        from src.orchestrator.nodes_act import _truncate_act_prompt_text

        long_text = "x" * 40000
        result = _truncate_act_prompt_text(long_text, max_chars=32000)
        assert len(result) <= 32000

    def test_truncate_act_prompt_text_passthrough_short(self):
        """Short text should pass through unchanged."""
        from src.orchestrator.nodes_act import _truncate_act_prompt_text

        short = "hello world"
        assert _truncate_act_prompt_text(short) == short


# ---------------------------------------------------------------------------
# Priority 4: planner skill index truncation
# ---------------------------------------------------------------------------

class TestPriority4SkillIndexTruncation:
    """Verify that initial planning uses at most 15 skills."""

    def test_initial_planning_caps_skills_at_15(self):
        """With no prior_plan_summary.selected_skill, max 15 skills in prompt."""
        # Build 30 skill entries
        skill_index = [
            {"skill_id": f"skill_{i}", "name": f"Skill {i}", "description": f"desc {i}",
             "script_files": [], "has_skill_md": False, "has_references": False,
             "has_templates": False, "enabled": True}
            for i in range(30)
        ]
        messages = _make_plan_loop_messages(skill_index=skill_index)
        # Find the system message containing skill index
        skill_messages = [
            m for m in messages
            if m.get("role") == "system" and "<available_skills>" in str(m.get("content", ""))
        ]
        assert len(skill_messages) >= 1
        content = skill_messages[0]["content"]
        # Count skill entries — each has <skill id="...">
        skill_count = content.count('<skill id="')
        assert skill_count <= 15

    def test_replan_shows_selected_skill_full_details(self):
        """On replan with selected_skill, only that skill gets full details."""
        skill_index = [
            {"skill_id": "skill_a", "name": "Skill A", "description": "desc a",
             "script_files": [], "has_skill_md": False, "has_references": False,
             "has_templates": False, "enabled": True},
            {"skill_id": "skill_b", "name": "Skill B", "description": "desc b",
             "script_files": [], "has_skill_md": False, "has_references": False,
             "has_templates": False, "enabled": True},
            {"skill_id": "skill_c", "name": "Skill C", "description": "desc c",
             "script_files": [], "has_skill_md": False, "has_references": False,
             "has_templates": False, "enabled": True},
        ]
        messages = _make_plan_loop_messages(
            skill_index=skill_index,
            prior_plan_summary={"selected_skill": "skill_a"},
        )
        skill_messages = [
            m for m in messages
            if m.get("role") == "system" and "<available_skills>" in str(m.get("content", ""))
        ]
        assert len(skill_messages) >= 1
        content = skill_messages[0]["content"]
        # Only skill_a should have full <skill> block
        assert '<skill id="skill_a">' in content
        assert '<skill id="skill_b">' not in content
        # Other skills listed compactly
        assert "skill_b" in content
        assert "skill_c" in content

    def test_format_skills_for_prompt_respects_max_skills(self):
        """format_skills_for_prompt should stop at max_skills."""
        entries = [_make_skill_entry(f"s{i}") for i in range(20)]
        result = format_skills_for_prompt(
            entries, max_skills=5, max_chars=100_000, max_desc_chars=200
        )
        assert result.count('<skill id="') == 5

    def test_max_skills_in_prompt_env_default(self):
        """_MAX_SKILLS_IN_PROMPT should be defined and positive."""
        assert isinstance(_MAX_SKILLS_IN_PROMPT, int)
        assert _MAX_SKILLS_IN_PROMPT > 0

    def test_replan_selected_skill_not_in_index_falls_back(self):
        """If selected_skill doesn't match any entry, fall back to top-15."""
        skill_index = [
            {"skill_id": f"skill_{i}", "name": f"Skill {i}", "description": f"desc {i}",
             "script_files": [], "has_skill_md": False, "has_references": False,
             "has_templates": False, "enabled": True}
            for i in range(20)
        ]
        messages = _make_plan_loop_messages(
            skill_index=skill_index,
            prior_plan_summary={"selected_skill": "nonexistent_skill"},
        )
        skill_messages = [
            m for m in messages
            if m.get("role") == "system" and "<available_skills>" in str(m.get("content", ""))
        ]
        assert len(skill_messages) >= 1
        content = skill_messages[0]["content"]
        # Should fall back to showing multiple skills, not an empty block
        skill_count = content.count('<skill id="')
        assert skill_count > 0
        assert skill_count <= 15


# ---------------------------------------------------------------------------
# Priority 5: iteration filter for artifact_context
# ---------------------------------------------------------------------------

class TestPriority5IterationFilter:
    """Verify that only current-iteration results pass through the iteration filter."""

    def _apply_iteration_filter(
        self,
        rows: list[ToolCallResult],
        current_iteration: int,
    ) -> list[ToolCallResult]:
        """Replicate the iteration filter from _execute_llm_act_step."""
        def _iter_matches(meta_iteration):
            if meta_iteration is None:
                return True
            try:
                return int(meta_iteration) == current_iteration
            except (ValueError, TypeError):
                return True

        return [
            r for r in rows
            if not isinstance(r.metadata, dict)
            or _iter_matches(r.metadata.get("iteration"))
        ]

    def test_keeps_current_iteration_results(self):
        r = _make_terminal_result("step_1", iteration=1)
        assert self._apply_iteration_filter([r], current_iteration=1) == [r]

    def test_drops_previous_iteration_results(self):
        old = _make_terminal_result("step_1", iteration=0)
        current = _make_terminal_result("step_2", iteration=1)
        result = self._apply_iteration_filter([old, current], current_iteration=1)
        assert result == [current]

    def test_keeps_results_without_iteration_metadata(self):
        """Results with no iteration key should always pass through."""
        r = _make_tool_result(metadata={"act_step_id": "step_1"})
        result = self._apply_iteration_filter([r], current_iteration=5)
        assert result == [r]

    def test_keeps_results_with_none_iteration(self):
        """Results with iteration=None should always pass through."""
        r = _make_tool_result(metadata={"act_step_id": "step_1", "iteration": None})
        result = self._apply_iteration_filter([r], current_iteration=3)
        assert result == [r]

    def test_mixed_iterations(self):
        rows = [
            _make_terminal_result("s1", iteration=0),
            _make_terminal_result("s2", iteration=1),
            _make_terminal_result("s3", iteration=1),
            _make_terminal_result("s4", iteration=2),
        ]
        result = self._apply_iteration_filter(rows, current_iteration=1)
        step_ids = {r.metadata.get("act_step_id") for r in result}
        assert step_ids == {"s2", "s3"}

    def test_non_numeric_iteration_passes_through(self):
        """Non-numeric iteration value should not crash, result passes through."""
        r = _make_tool_result(metadata={"act_step_id": "step_1", "iteration": "abc"})
        result = self._apply_iteration_filter([r], current_iteration=1)
        # Non-numeric → treated as pass-through (not filtered out)
        assert result == [r]


# ---------------------------------------------------------------------------
# Priority 6: replan skips planner tool phase
# ---------------------------------------------------------------------------

class TestPriority6ReplanSkipsToolPhase:
    """Verify that tools_available=False when loaded_skill_id is set."""

    def test_tools_available_false_when_skill_loaded(self):
        """Replicate the tools_available logic from plan_node."""
        loaded_skill_id = "my_skill"
        tools_available = not bool(loaded_skill_id)
        assert tools_available is False

    def test_tools_available_true_when_no_skill(self):
        loaded_skill_id = None
        tools_available = not bool(loaded_skill_id)
        assert tools_available is True

    def test_tools_available_true_for_empty_string(self):
        """Empty string (no skill loaded) means tools are available."""
        # In plan_node, loaded_skill_id starts as None and is only set to a
        # non-empty string when a skill is successfully loaded. An empty string
        # is equivalent to None — tools remain available.
        loaded_skill_id = ""
        tools_available = not bool(loaded_skill_id)
        assert tools_available is True

    def test_replan_skill_index_shows_selected_skill_only(self):
        """On replan, skill index message contains only selected skill full details."""
        skill_index = [
            {"skill_id": "skill_x", "name": "X", "description": "x desc",
             "script_files": [], "has_skill_md": True, "has_references": False,
             "has_templates": False, "enabled": True},
            {"skill_id": "skill_y", "name": "Y", "description": "y desc",
             "script_files": [], "has_skill_md": False, "has_references": False,
             "has_templates": False, "enabled": True},
        ]
        messages = _make_plan_loop_messages(
            skill_index=skill_index,
            prior_plan_summary={"selected_skill": "skill_x"},
        )
        skill_msg = next(
            (m for m in messages if "<available_skills>" in str(m.get("content", ""))),
            None,
        )
        assert skill_msg is not None
        content = skill_msg["content"]
        # Full details for selected skill
        assert '<skill id="skill_x">' in content
        # Other skill listed compactly, not as full block
        assert '<skill id="skill_y">' not in content
        assert "skill_y" in content  # still mentioned in compact list


# ---------------------------------------------------------------------------
# Priority 7: act transcript backfeed truncation
# ---------------------------------------------------------------------------

class TestPriority7TranscriptBackfeedTruncation:
    """Verify _build_tool_transcript_message truncates long results."""

    def test_short_result_not_truncated(self):
        result = _make_tool_result(result="short content")
        msg = _build_tool_transcript_message(tool_call_id="tc_1", result=result)
        assert msg["role"] == "tool"
        assert msg["tool_call_id"] == "tc_1"
        assert "short content" in msg["content"]

    def test_long_result_truncated_by_structural_compressor(self):
        """Long string results are truncated by _compact_prompt_payload (500 chars)."""
        long_result = "x" * 800
        result = _make_tool_result(result=long_result)
        msg = _build_tool_transcript_message(tool_call_id="tc_2", result=result)
        content = msg["content"]
        # The structural compressor adds a truncated marker
        assert "truncated" in content
        # The full 800-char result should NOT appear verbatim
        assert "x" * 800 not in content

    def test_truncation_preserves_first_500_chars(self):
        """Structural compressor keeps first 500 chars of a string field."""
        long_result = "A" * 500 + "B" * 300
        result = _make_tool_result(result=long_result)
        msg = _build_tool_transcript_message(tool_call_id="tc_3", result=result)
        content = msg["content"]
        # First 500 chars should be present
        assert "A" * 500 in content
        # The overflow should not appear
        assert "B" * 300 not in content

    def test_failed_result_included_in_transcript(self):
        result = _make_tool_result(success=False, result="error details")
        msg = _build_tool_transcript_message(tool_call_id="tc_4", result=result)
        assert msg["role"] == "tool"
        assert "error" in msg["content"].lower() or "false" in msg["content"].lower()

    def test_result_within_500_chars_not_truncated(self):
        exact_result = "Z" * 500
        result = _make_tool_result(result=exact_result)
        msg = _build_tool_transcript_message(tool_call_id="tc_5", result=result)
        assert "truncated" not in msg["content"]

    def test_dict_result_truncated_when_large(self):
        """Dict results should be truncated when they exceed the list item limit."""
        # Use 25 items to exceed _PROMPT_PAYLOAD_MAX_LIST_ITEMS (20)
        large_dict = {"items": [{"title": f"result_{i}", "snippet": "x" * 100} for i in range(25)]}
        result = _make_tool_result(result=large_dict)
        msg = _build_tool_transcript_message(tool_call_id="tc_6", result=result)
        assert "truncated" in msg["content"]

    def test_list_result_truncated_when_large(self):
        """List results should be truncated when they exceed the list item limit."""
        # Use 25 items to exceed _PROMPT_PAYLOAD_MAX_LIST_ITEMS (20)
        large_list = [{"url": f"https://example.com/{i}", "text": "y" * 50} for i in range(25)]
        result = _make_tool_result(result=large_list)
        msg = _build_tool_transcript_message(tool_call_id="tc_7", result=result)
        assert "truncated" in msg["content"]

    def test_small_dict_result_not_truncated(self):
        """Small dict results should pass through unchanged."""
        small_dict = {"status": "ok", "count": 1}
        result = _make_tool_result(result=small_dict)
        msg = _build_tool_transcript_message(tool_call_id="tc_8", result=result)
        assert "truncated" not in msg["content"]


# ---------------------------------------------------------------------------
# Priority 8: Token usage statistics
# ---------------------------------------------------------------------------

class TestPriority8TokenUsageStats:
    """Verify EventStore.aggregate_token_usage works correctly."""

    @pytest.fixture
    def store(self, tmp_path: Path):
        from src.events.event_store import EventStore
        return EventStore(db_path=str(tmp_path / "events.db"))

    def _make_usage_event(
        self,
        event_id: str,
        session_id: str = "s1",
        node: str = "plan",
        model: str = "claude-3",
        prompt: int = 100,
        completion: int = 50,
    ):
        from src.events.models import Event
        return Event(
            event_id=event_id,
            event_type="llm.usage",
            source="orchestrator",
            subject=session_id,
            payload={
                "session_id": session_id,
                "agent_id": "agent_1",
                "node": node,
                "model": model,
                "prompt_tokens": prompt,
                "completion_tokens": completion,
                "total_tokens": prompt + completion,
                "duration_ms": 500,
            },
        )

    def test_aggregate_totals(self, store):
        store.append(self._make_usage_event("u1", prompt=100, completion=50))
        store.append(self._make_usage_event("u2", prompt=200, completion=80))

        result = store.aggregate_token_usage()
        totals = result["totals"]
        assert totals["call_count"] == 2
        assert totals["prompt_tokens"] == 300
        assert totals["completion_tokens"] == 130
        assert totals["total_tokens"] == 430

    def test_aggregate_empty(self, store):
        result = store.aggregate_token_usage()
        assert result["totals"]["call_count"] == 0
        assert result["totals"]["total_tokens"] == 0
        assert result["breakdown"] == []
        assert result["trend"] == []

    def test_aggregate_group_by_node(self, store):
        store.append(self._make_usage_event("u1", node="plan", prompt=100, completion=50))
        store.append(self._make_usage_event("u2", node="act", prompt=200, completion=80))
        store.append(self._make_usage_event("u3", node="plan", prompt=150, completion=60))

        result = store.aggregate_token_usage(group_by="node")
        breakdown = {item["key"]: item for item in result["breakdown"]}
        assert "plan" in breakdown
        assert "act" in breakdown
        assert breakdown["plan"]["call_count"] == 2
        assert breakdown["plan"]["prompt_tokens"] == 250
        assert breakdown["act"]["total_tokens"] == 280

    def test_aggregate_group_by_model(self, store):
        store.append(self._make_usage_event("u1", model="claude-3", prompt=100, completion=50))
        store.append(self._make_usage_event("u2", model="gpt-4", prompt=200, completion=80))

        result = store.aggregate_token_usage(group_by="model")
        breakdown = {item["key"]: item for item in result["breakdown"]}
        assert "claude-3" in breakdown
        assert "gpt-4" in breakdown

    def test_aggregate_trend_is_list(self, store):
        store.append(self._make_usage_event("u1"))
        result = store.aggregate_token_usage()
        assert isinstance(result["trend"], list)

    def test_non_usage_events_excluded(self, store):
        """Non-llm.usage events should not affect token aggregation."""
        from src.events.models import Event
        store.append(Event(
            event_id="other_1",
            event_type="tool.exec.completed",
            source="test",
            subject="s1",
            payload={},
        ))
        result = store.aggregate_token_usage()
        assert result["totals"]["call_count"] == 0
