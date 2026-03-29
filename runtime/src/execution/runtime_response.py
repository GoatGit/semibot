from __future__ import annotations

from typing import Any

from src.execution.runtime_result import normalize_execution_result, normalize_tool_results
from src.orchestrator.nodes_respond import (
    _build_inline_delivery_fallback,
    _extract_search_results,
    _infer_delivery_language,
    _looks_like_premature_final_response,
)
from src.utils.logging import get_logger

logger = get_logger(__name__)


def guard_rule_authoring_success_claim(final_response: str, tool_results: list[dict[str, Any]]) -> str:
    failed_rows = [
        row
        for row in tool_results
        if str(row.get("tool_name") or "").strip() in {"rule_authoring", "control_plane"}
        and not bool(row.get("success"))
    ]
    if not failed_rows:
        return final_response

    first_error = str(failed_rows[0].get("error") or "").strip() or "unknown_error"
    safe = final_response or ""
    for phrase in (
        "已创建",
        "创建成功",
        "设置成功",
        "已设置",
        "设置完成",
        "任务已设置完成",
    ):
        safe = safe.replace(phrase, "尝试创建但未成功")

    notice = (
        f"注意：控制面变更未成功落地（control_plane 执行失败：{first_error}）。"
        "请修正参数后重试。"
    )
    if not safe.strip():
        return notice
    if notice in safe:
        return safe
    return f"{notice}\n\n{safe}"


def rewrite_premature_final_response(result: dict[str, Any]) -> str:
    final_response = normalize_execution_result(result).final_response
    if not _looks_like_premature_final_response(final_response):
        return final_response

    tool_results = normalize_tool_results(result.get("tool_results"))
    if not any(r.success for r in tool_results):
        return final_response

    query = ""
    messages = result.get("messages") if isinstance(result.get("messages"), list) else []
    for message in reversed(messages):
        if not isinstance(message, dict):
            continue
        if str(message.get("role") or "").strip() != "user":
            continue
        content = str(message.get("content") or "").strip()
        if content and not content.startswith("[SYSTEM]"):
            query = content
            break

    fallback = ""
    search_rows = _extract_search_results(tool_results)
    if search_rows:
        fallback = _build_inline_delivery_fallback(
            title=query or "current request",
            source_items=[
                {
                    "title": str(item.get("title") or "").strip() or f"Result {index}",
                    "url": str(item.get("url") or "").strip(),
                    "summary": str(item.get("snippet") or item.get("content") or "").strip(),
                }
                for index, item in enumerate(search_rows[:6], start=1)
            ],
            language=_infer_delivery_language(query),
        )

    fallback = str(fallback or "").strip()
    if not fallback:
        return final_response
    if fallback == final_response.strip():
        return final_response
    logger.warning("semigraph_premature_final_response_rewritten")
    return fallback


def derive_terminal_failure_reason(result: dict[str, Any], final_response: str) -> str | None:
    tool_results = normalize_tool_results(result.get("tool_results"))
    raw_plan = result.get("plan")
    plan_steps = []
    if hasattr(raw_plan, "steps"):
        plan_steps = list(getattr(raw_plan, "steps", []) or [])
    elif isinstance(raw_plan, dict) and isinstance(raw_plan.get("steps"), list):
        plan_steps = list(raw_plan.get("steps") or [])

    normalized = str(final_response or "").strip()
    lowered = normalized.lower()
    if normalized and (
        '"tool_calls"' in normalized
        or "<function_calls>" in lowered
        or ">functions." in lowered
        or ('"decision"' in normalized and '"tool_call"' in normalized and '"selectedTool"' in normalized)
    ):
        return "Model emitted unexecuted tool-call text in the terminal response."

    if plan_steps and not tool_results:
        return "Planner produced a non-empty plan, but no act/tool results were executed."

    return None
