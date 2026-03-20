"""Plan rewriting: fallback plan generation and time context application."""

from typing import Any

from src.orchestrator.nodes_respond import _infer_delivery_language
from src.orchestrator.state import ExecutionPlan, PlanStep, resolve_time_context
from src.utils.logging import get_logger

logger = get_logger(__name__)


def _build_fresh_research_fallback_plan(request: str) -> ExecutionPlan:
    clean_request = str(request or "").strip() or "latest updates"
    delivery_language = _infer_delivery_language(clean_request)
    delivery_goal = (
        f"{clean_request}的最新信息总结"
        if delivery_language == "zh"
        else f"Summary of latest information for {clean_request}"
    )
    return ExecutionPlan(
        plan_type="plan",
        goal=clean_request,
        round_goal=f"Research and summarize up-to-date information for: {clean_request}",
        intent_decomposition={
            "requested_operation": clean_request,
            "delivery_goal": delivery_goal,
            "execution_preference": {
                "preferred_tools": ["search"],
                "must_use_tools": False,
            },
        },
        final_delivery_contract={
            "delivery_goal": delivery_goal,
        },
        steps=[
            PlanStep(
                id="step-1",
                title=f"检索并整理最新信息：{clean_request}",
                phase="retrieve",
                intent=(
                    "Use current search/retrieval tools to gather up-to-date information that directly answers "
                    "the user request, with explicit publication dates and source links."
                ),
                expected_outputs=[
                    "A concise set of current, relevant findings",
                    "Source links for each finding",
                    "Explicit publication dates or freshness evidence",
                ],
                completion_criteria=[
                    "Freshness-sensitive claims are backed by current sources",
                    "Results directly address the user's request without asking an unnecessary clarification question",
                ],
            )
        ],
    )


def _apply_plan_time_context(
    plan: ExecutionPlan,
    metadata: dict[str, Any] | None,
) -> ExecutionPlan:
    current_date, current_weekday, current_timezone = resolve_time_context(metadata, plan)
    plan.current_date = current_date
    plan.current_weekday = current_weekday
    plan.current_timezone = current_timezone
    return plan
