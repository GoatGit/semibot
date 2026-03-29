from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from src.orchestrator.state import ToolCallResult


@dataclass
class NormalizedExecutionResult:
    final_response: str
    awaiting_approval_message: str | None
    error: str | None
    tool_results: list[dict[str, Any]]
    pending_approval_ids: list[str]
    runtime_events: list[dict[str, Any]]
    terminal_failure_reason: str | None = None


def extract_final_response(result: dict[str, Any]) -> str:
    messages = result.get("messages")
    if not isinstance(messages, list) or not messages:
        return ""
    last = messages[-1]
    if isinstance(last, dict):
        return str(last.get("content") or "")
    return str(getattr(last, "content", ""))


def serialize_tool_results(result: dict[str, Any]) -> list[dict[str, Any]]:
    rows = result.get("tool_results")
    if not isinstance(rows, list):
        return []
    serialized: list[dict[str, Any]] = []
    for item in rows:
        if hasattr(item, "model_dump"):
            serialized.append(dict(item.model_dump()))
            continue
        if isinstance(item, dict):
            serialized.append(dict(item))
            continue
        tool_name = getattr(item, "tool_name", None)
        params = getattr(item, "params", None)
        serialized.append(
            {
                "tool_name": str(tool_name or ""),
                "params": dict(params) if isinstance(params, dict) else {},
                "result": getattr(item, "result", None),
                "error": getattr(item, "error", None),
                "duration_ms": int(getattr(item, "duration_ms", 0) or 0),
                "success": bool(getattr(item, "success", False)),
                "metadata": getattr(item, "metadata", {}) or {},
            }
        )
    return serialized


def normalize_tool_results(raw_results: Any) -> list[ToolCallResult]:
    if not isinstance(raw_results, list):
        return []
    normalized: list[ToolCallResult] = []
    for row in raw_results:
        if isinstance(row, ToolCallResult):
            normalized.append(row)
            continue
        if not isinstance(row, dict):
            continue
        tool_name = str(row.get("tool_name") or "").strip()
        params = row.get("params") if isinstance(row.get("params"), dict) else {}
        result = row.get("result")
        error = str(row.get("error") or "") or None
        duration_ms_raw = row.get("duration_ms")
        duration_ms = int(duration_ms_raw) if isinstance(duration_ms_raw, (int, float)) else 0
        success_raw = row.get("success")
        success = bool(success_raw) if isinstance(success_raw, bool) else error is None
        metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        normalized.append(
            ToolCallResult(
                tool_name=tool_name or "unknown",
                params=params,
                result=result,
                error=error,
                duration_ms=duration_ms,
                success=success,
                metadata=metadata,
            )
        )
    return normalized


def pending_approval_ids_from_tool_results(tool_results: list[dict[str, Any]] | None) -> list[str]:
    if not isinstance(tool_results, list):
        return []
    approval_ids: list[str] = []
    for row in tool_results:
        if not isinstance(row, dict):
            continue
        metadata = row.get("metadata")
        if not isinstance(metadata, dict):
            continue
        if str(metadata.get("approval_status") or "").strip().lower() != "pending":
            continue
        approval_id = str(metadata.get("approval_id") or "").strip()
        if approval_id:
            approval_ids.append(approval_id)
    return list(dict.fromkeys(approval_ids))


def pending_approval_ids_from_result(result: dict[str, Any]) -> list[str]:
    approval_ids = pending_approval_ids_from_tool_results(serialize_tool_results(result))
    metadata = result.get("metadata")
    if isinstance(metadata, dict):
        for item in metadata.get("pending_approval_ids") or []:
            approval_id = str(item or "").strip()
            if approval_id:
                approval_ids.append(approval_id)
    return list(dict.fromkeys(approval_ids))


def normalize_execution_result(
    raw_result: dict[str, Any],
    *,
    final_response: str | None = None,
    error: str | None = None,
    runtime_events: list[dict[str, Any]] | None = None,
    terminal_failure_reason: str | None = None,
) -> NormalizedExecutionResult:
    tool_results = serialize_tool_results(raw_result)
    normalized_error = str(error or raw_result.get("error") or "").strip() or None
    pending_approval_ids = pending_approval_ids_from_result(raw_result)
    metadata = raw_result.get("metadata")
    awaiting_approval_message = (
        str(metadata.get("awaiting_approval_message") or "").strip()
        if isinstance(metadata, dict)
        else ""
    )
    normalized_final_response = str(final_response or "").strip() or extract_final_response(raw_result)
    if pending_approval_ids:
        if not awaiting_approval_message:
            awaiting_approval_message = normalized_final_response
        normalized_final_response = ""
    return NormalizedExecutionResult(
        final_response=normalized_final_response,
        awaiting_approval_message=awaiting_approval_message or None,
        error=normalized_error,
        tool_results=tool_results,
        pending_approval_ids=pending_approval_ids,
        runtime_events=list(runtime_events or []),
        terminal_failure_reason=str(terminal_failure_reason or "").strip() or None,
    )
