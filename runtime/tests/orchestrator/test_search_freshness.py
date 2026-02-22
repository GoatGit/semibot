from datetime import datetime

from src.orchestrator.nodes import (
    _enforce_freshness_on_plan_steps,
    _is_latest_intent,
)
from src.orchestrator.state import PlanStep


def test_is_latest_intent_detects_chinese_and_english_keywords():
    assert _is_latest_intent("搜索最新的AI行业动态")
    assert _is_latest_intent("find latest ai news today")
    assert not _is_latest_intent("解释什么是Transformer")


def test_enforce_freshness_on_search_steps_only():
    steps = [
        PlanStep(
            id="1",
            title="搜索AI新闻",
            tool="tavily-search",
            params={"query": "AI 行业新闻"},
            parallel=False,
        ),
        PlanStep(
            id="2",
            title="生成PDF",
            tool="pdf",
            params={},
            parallel=False,
        ),
    ]

    _enforce_freshness_on_plan_steps(
        steps=steps,
        user_text="搜索最新的AI新闻并总结",
        now=datetime(2026, 2, 22, 12, 0, 0),
        session_id="test-session",
    )

    assert "最近30天" in steps[0].params["query"]
    assert "2026-02-22" in steps[0].params["query"]
    assert "发布日期" in steps[0].params["query"]
    assert steps[1].params == {}


def test_enforce_freshness_skip_non_latest_intent():
    step = PlanStep(
        id="1",
        title="搜索背景知识",
        tool="tavily-search",
        params={"query": "人工智能历史"},
        parallel=False,
    )

    _enforce_freshness_on_plan_steps(
        steps=[step],
        user_text="介绍人工智能发展史",
        now=datetime(2026, 2, 22, 12, 0, 0),
        session_id="test-session",
    )

    assert step.params["query"] == "人工智能历史"
