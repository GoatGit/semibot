"""Convert tool execution failures into unified runtime failures."""

from __future__ import annotations

from typing import Any

from src.orchestrator.runtime_middleware import RuntimeFailure
from src.orchestrator.state import ToolCallResult


def runtime_failure_from_tool_result(result: ToolCallResult) -> RuntimeFailure | None:
    if result.success:
        return None
    metadata = dict(result.metadata or {})
    error_text = str(result.error or "").strip()
    lowered = error_text.lower()
    if metadata.get("guard") in {"llm_act_validation", "act_loop_guard"}:
        kind = "validation_rejected"
        retryable = False
    elif "timeout" in lowered or "readtimeout" in lowered:
        kind = "timeout"
        retryable = True
    elif "permission" in lowered or "denied" in lowered:
        kind = "permission_denied"
        retryable = False
    elif "unavailable" in lowered or "not configured" in lowered or "connection" in lowered:
        kind = "provider_unavailable"
        retryable = True
    elif "schema" in lowered or "contract" in lowered or "invalid" in lowered or "parse" in lowered:
        kind = "contract_error"
        retryable = False
    else:
        kind = "execution_error"
        retryable = False
    return RuntimeFailure(
        family="tool",
        kind=kind,
        retryable=retryable,
        source=str(result.tool_name or "tool"),
        message=error_text or "Tool execution failed",
        meta={"params": dict(result.params or {}), "metadata": metadata},
    )


def attach_runtime_failure(result: ToolCallResult, failure: RuntimeFailure | None) -> ToolCallResult:
    if failure is None:
        return result
    metadata = dict(result.metadata or {})
    metadata["runtime_failure"] = failure.to_dict()
    result.metadata = metadata
    return result
