from __future__ import annotations

from datetime import datetime, timezone

from src.orchestrator.act_tool_validators import validate_act_tool_call
from src.orchestrator.state import PlanStep, ToolCallResult


def test_validate_search_stale_year_is_advisory(monkeypatch):
    monkeypatch.setattr(
        "src.orchestrator.act_tool_executor._get_freshness_validation_flag",
        lambda: True,
    )
    monkeypatch.setattr(
        "src.orchestrator.act_tool_executor._is_latest_research_intent",
        lambda _text: True,
    )
    monkeypatch.setattr(
        "src.orchestrator.act_tool_executor._search_query_contains_stale_year",
        lambda _query, today: True,
    )

    action = PlanStep(
        id="step-1",
        title="检索最新 AI 行业动态",
        tool="search",
        params={"queries": ["AI industry trends 2024"]},
    )

    result = validate_act_tool_call(
        action=action,
        prior_results=[],
        current_step_results=[],
        runtime_context=None,
        latest_user_text="搜索最新 AI 行业动态并总结",
        today=datetime(2026, 3, 30, tzinfo=timezone.utc),
    )
    assert result is None


def test_validate_search_repeated_failures_is_advisory(monkeypatch):
    monkeypatch.setattr(
        "src.orchestrator.act_tool_executor._has_same_step_search_provider_failures",
        lambda _rows: True,
    )

    action = PlanStep(
        id="step-1",
        title="继续检索",
        tool="search",
        params={"queries": ["latest AI updates"]},
    )
    current_step_results = [
        ToolCallResult(
            tool_name="search",
            params={"queries": ["latest AI updates"]},
            result=None,
            error="provider failed",
            success=False,
        )
    ]

    result = validate_act_tool_call(
        action=action,
        prior_results=[],
        current_step_results=current_step_results,
        runtime_context=None,
        latest_user_text="搜索最新 AI 行业动态并总结",
    )
    assert result is None
