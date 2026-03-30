from __future__ import annotations

from typing import Any

from src.execution.runtime_result import normalize_execution_result, normalize_tool_results
from src.orchestrator.nodes_respond import (
    _looks_like_raw_delivery_payload,
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
    notice = (
        f"注意：控制面变更未成功落地（control_plane 执行失败：{first_error}）。"
        "请修正参数后重试。"
    )
    safe = str(final_response or "")
    if not safe.strip():
        return notice
    if notice in safe:
        return safe
    return f"{safe}\n\n{notice}"


def rewrite_premature_final_response(result: dict[str, Any]) -> str:
    final_response = normalize_execution_result(result).final_response
    if not _looks_like_raw_delivery_payload(final_response):
        return final_response
    logger.warning("semigraph_raw_final_response_suppressed")
    return ""


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

    if tool_results and not any(bool(getattr(row, "success", False)) for row in tool_results):
        if normalized:
            # LLM-first: allow a user-facing degraded answer even when all tools failed.
            return None
        first_error = ""
        for row in tool_results:
            err = str(getattr(row, "error", "") or "").strip()
            if err:
                first_error = err
                break
        if first_error:
            compact = " ".join(first_error.split())
            return f"All tool calls failed: {compact[:260]}"
        return "All tool calls failed."

    return None
