from __future__ import annotations

from typing import Any

from src.execution.runtime_response import guard_rule_authoring_success_claim


def serialize_tool_results_from_runtime_events(
    runtime_events: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    serialized: list[dict[str, Any]] = []
    for item in runtime_events:
        if str(item.get("event") or "") != "tool_call_complete":
            continue
        metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
        serialized.append(
            {
                "tool_name": str(item.get("tool_name") or "").strip(),
                "params": {},
                "result": item.get("result"),
                "error": item.get("error"),
                "duration_ms": int(item.get("duration") or 0),
                "success": bool(item.get("success")),
                "metadata": metadata,
            }
        )
    return serialized


def collect_pending_approval_ids(
    tool_results: list[dict[str, Any]],
    terminal_payload: dict[str, Any] | None = None,
) -> list[str]:
    pending_approval_ids: list[str] = []
    for row in tool_results:
        if not isinstance(row, dict):
            continue
        meta = row.get("metadata")
        if not isinstance(meta, dict):
            continue
        if str(meta.get("approval_status") or "").strip().lower() != "pending":
            continue
        approval_id = str(meta.get("approval_id") or "").strip()
        if approval_id and approval_id not in pending_approval_ids:
            pending_approval_ids.append(approval_id)

    terminal = terminal_payload or {}
    terminal_pending = terminal.get("pending_approval_ids")
    if isinstance(terminal_pending, list):
        for item in terminal_pending:
            approval_id = str(item or "").strip()
            if approval_id and approval_id not in pending_approval_ids:
                pending_approval_ids.append(approval_id)
    return pending_approval_ids


def derive_runtime_facade_status(
    *,
    checkpoint_status: str | None,
    terminal_type: str | None,
    error: str | None,
    pending_approval_ids: list[str],
) -> str:
    normalized_checkpoint_status = str(checkpoint_status or "").strip().lower()
    normalized_terminal_type = str(terminal_type or "").strip()
    if pending_approval_ids:
        return "awaiting_approval"
    if normalized_terminal_type == "execution_error" or error:
        return "failed"
    if normalized_checkpoint_status in {"completed", "failed", "cancelled", "awaiting_approval"}:
        return normalized_checkpoint_status
    if normalized_checkpoint_status in {"active", "running"}:
        return "completed"
    return "failed" if error else "completed"


def build_runtime_facade_result(
    *,
    session_id: str,
    attempt_id: str | None = None,
    user_message_id: str | None = None,
    agent_id: str,
    checkpoint: dict[str, Any] | None,
    terminal_payload: dict[str, Any] | None,
    runtime_events: list[dict[str, Any]],
    llm_configured: bool,
) -> dict[str, Any]:
    resolved_checkpoint = checkpoint if isinstance(checkpoint, dict) else {}
    terminal = terminal_payload or {}
    resolved_attempt_id = (
        str(
            attempt_id
            or resolved_checkpoint.get("attempt_id")
            or terminal.get("attempt_id")
            or ""
        ).strip()
        or None
    )
    resolved_user_message_id = (
        str(
            user_message_id
            or resolved_checkpoint.get("user_message_id")
            or terminal.get("user_message_id")
            or ""
        ).strip()
        or None
    )
    tool_results = (
        resolved_checkpoint.get("tool_results")
        if isinstance(resolved_checkpoint.get("tool_results"), list)
        else []
    )
    if not tool_results:
        tool_results = serialize_tool_results_from_runtime_events(runtime_events)

    error = str(resolved_checkpoint.get("error") or "").strip() or None
    pending_approval_ids = collect_pending_approval_ids(
        tool_results if isinstance(tool_results, list) else [],
        terminal_payload=terminal_payload,
    )
    final_response = str(
        resolved_checkpoint.get("final_response")
        or terminal.get("final_response")
        or ""
    )
    awaiting_approval_message = str(
        resolved_checkpoint.get("awaiting_approval_message")
        or terminal.get("awaiting_approval_message")
        or ""
    ).strip()
    final_response = guard_rule_authoring_success_claim(
        final_response,
        tool_results if isinstance(tool_results, list) else [],
    )
    if pending_approval_ids:
        final_response = ""
    status = derive_runtime_facade_status(
        checkpoint_status=str(resolved_checkpoint.get("status") or ""),
        terminal_type=str(terminal.get("type") or ""),
        error=error,
        pending_approval_ids=pending_approval_ids,
    )
    terminal_reason = str(
        resolved_checkpoint.get("terminal_reason")
        or terminal.get("terminal_reason")
        or ""
    ).strip() or None
    resolved_revision: int | None = None
    for candidate in (
        terminal.get("revision"),
        resolved_checkpoint.get("revision"),
    ):
        if isinstance(candidate, bool):
            continue
        if isinstance(candidate, int):
            resolved_revision = int(candidate)
            break
        if isinstance(candidate, float) and candidate.is_integer():
            resolved_revision = int(candidate)
            break
        if isinstance(candidate, str):
            text = candidate.strip()
            if text.isdigit():
                resolved_revision = int(text)
                break
    return {
        "status": status,
        "session_id": session_id,
        "attempt_id": resolved_attempt_id,
        "user_message_id": resolved_user_message_id,
        "agent_id": agent_id,
        "revision": resolved_revision,
        "terminal_reason": terminal_reason,
        "final_response": final_response,
        "awaiting_approval_message": awaiting_approval_message,
        "error": error,
        "pending_approval_ids": pending_approval_ids,
        "tool_results": tool_results if isinstance(tool_results, list) else [],
        "runtime_events": runtime_events,
        "llm_configured": llm_configured,
    }
