"""Shared utilities for channel helpers.

Consolidates duplicated patterns across telegram/discord/whatsapp/imessage helpers:
- _query_value
- resolve_ingress_result
- build_approval_notice
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def query_value(query_params: Mapping[str, str] | None, *keys: str) -> str | None:
    """Return the first non-empty value from query_params matching any of the given keys."""
    if not query_params:
        return None
    for key in keys:
        value = str(query_params.get(key, "")).strip()
        if value:
            return value
    return None


def build_ingress_result(
    *,
    event_id: str,
    event_type: str,
    matched_rules: int,
    approval_command: dict[str, Any] | None,
    gateway_result: dict[str, Any] | None,
    resume_result: dict[str, Any] | None,
) -> dict[str, Any]:
    """Build the standard ingress return dict shared by all channel ingress functions."""
    return {
        "accepted": True,
        "event_id": event_id,
        "event_type": event_type,
        "matched_rules": matched_rules,
        "approval_command": approval_command,
        "addressed": gateway_result.get("addressed") if gateway_result else None,
        "should_execute": gateway_result.get("should_execute") if gateway_result else None,
        "address_reason": gateway_result.get("address_reason") if gateway_result else None,
        "conversation_id": gateway_result.get("conversation_id") if gateway_result else None,
        "main_context_id": gateway_result.get("main_context_id") if gateway_result else None,
        "task_run_id": gateway_result.get("task_run_id") if gateway_result else None,
        "runtime_session_id": gateway_result.get("runtime_session_id") if gateway_result else None,
        "agent_id": gateway_result.get("agent_id") if gateway_result else None,
        "resume": resume_result,
    }


def format_approval_notice(*, status: str, resolved_count: int) -> str:
    """Build the approval followup notice text."""
    action = "通过" if status == "approved" else "拒绝"
    notice = f"已{action} {resolved_count} 个审批项。"
    if status == "approved":
        notice += " 正在继续执行任务。"
    return notice
