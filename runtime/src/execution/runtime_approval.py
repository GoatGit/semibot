from __future__ import annotations

import hashlib
import json
from typing import Any

APPROVAL_SCOPE_ALLOWED = {"call", "action", "target", "session", "session_action", "tool"}
APPROVAL_ACTION_KEYS = ("action", "operation", "method", "mode", "type")
APPROVAL_TARGET_KEYS = (
    "url",
    "path",
    "target",
    "selector",
    "query",
    "command",
    "resource",
    "file",
    "filename",
    "name",
)
APPROVAL_SUMMARY_IGNORED_PARAMS = {
    "content",
    "text",
    "code",
    "html",
    "script",
    "prompt",
    "messages",
    "input",
    "body",
}


def to_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "y", "on"}:
            return True
        if normalized in {"0", "false", "no", "n", "off", ""}:
            return False
    return bool(value)


def short_text(value: Any, *, max_len: int = 120) -> str:
    text = str(value or "").strip()
    if len(text) <= max_len:
        return text
    return f"{text[: max_len - 1]}…"


def normalize_dedupe_keys(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    normalized: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            continue
        key = item.strip()
        if key:
            normalized.append(key)
    return normalized


def extract_first_string(params: dict[str, Any], keys: tuple[str, ...]) -> str:
    for key in keys:
        value = params.get(key)
        if value is None:
            continue
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, (int, float, bool)):
            return str(value)
    return ""


def summarize_params(params: dict[str, Any], *, max_items: int = 3) -> dict[str, str]:
    summary: dict[str, str] = {}
    for key in sorted(params.keys()):
        if key in APPROVAL_SUMMARY_IGNORED_PARAMS:
            continue
        value = params.get(key)
        if isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                continue
            summary[key] = short_text(stripped, max_len=60)
        elif isinstance(value, (int, float, bool)):
            summary[key] = str(value)
        if len(summary) >= max_items:
            break
    return summary


def build_approval_policy(
    capability_id: str,
    tool_name: str,
    params: dict[str, Any],
    risk_level: str,
    session_id: str,
    metadata_additional: dict[str, Any] | None = None,
) -> tuple[str, dict[str, Any]]:
    metadata_additional = metadata_additional or {}
    resolved_capability_id = str(
        capability_id or metadata_additional.get("capability_id") or metadata_additional.get("tool_id") or tool_name
    ).strip() or tool_name
    action = extract_first_string(params, APPROVAL_ACTION_KEYS).lower()
    target = short_text(extract_first_string(params, APPROVAL_TARGET_KEYS), max_len=120)
    params_preview = summarize_params(params)

    scope_raw = str(metadata_additional.get("approval_scope") or "").strip().lower()
    approval_scope = scope_raw if scope_raw in APPROVAL_SCOPE_ALLOWED else "session"
    dedupe_keys = normalize_dedupe_keys(metadata_additional.get("approval_dedupe_keys"))

    context: dict[str, Any] = {
        "capability_id": resolved_capability_id,
        "tool_name": tool_name,
        "action": action or None,
        "target": target or None,
        "risk_level": risk_level,
        "session_id": session_id,
        "params_preview": params_preview,
    }
    if metadata_additional.get("fake_ip_guard") == "fake_ip_dns":
        context["guard"] = "fake_ip_dns"
        context["fake_ip_host"] = metadata_additional.get("fake_ip_host")
        context["fake_ip_resolved_ip"] = metadata_additional.get("fake_ip_resolved_ip")
        context["summary"] = (
            f"工具 `{tool_name}` 访问 `{target or metadata_additional.get('fake_ip_host') or ''}` 时命中 TUN/fake-ip DNS "
            f"(`{metadata_additional.get('fake_ip_resolved_ip') or ''}`)，需要人工审批后继续。"
        ).strip()
    context["summary"] = (
        context.get("summary")
        or (
            f"工具 `{tool_name}`"
            f"{f' 执行动作 `{action}`' if action else ''}"
            f"{f'，目标 `{target}`' if target else ''}"
        )
    )

    if dedupe_keys:
        grouped_values: list[str] = []
        for key in dedupe_keys:
            value = params.get(key)
            if value is None:
                continue
            grouped_values.append(f"{key}={short_text(value, max_len=80)}")
        grouped = "|".join(grouped_values) if grouped_values else "none"
        return f"{resolved_capability_id}|risk:{risk_level}|custom:{grouped}", context

    if approval_scope == "tool":
        return f"{resolved_capability_id}|risk:{risk_level}", context
    if approval_scope == "session":
        return f"{resolved_capability_id}|risk:{risk_level}|session:{session_id}", context
    if approval_scope == "action":
        return f"{resolved_capability_id}|risk:{risk_level}|action:{action or 'none'}", context
    if approval_scope == "target":
        return f"{resolved_capability_id}|risk:{risk_level}|action:{action or 'none'}|target:{target or 'none'}", context
    if approval_scope == "call":
        try:
            serialized = json.dumps(params, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        except Exception:
            serialized = str(params)
        call_hash = hashlib.sha256(serialized.encode()).hexdigest()[:16]
        return f"{resolved_capability_id}|risk:{risk_level}|call:{call_hash}", context

    return f"{resolved_capability_id}|risk:{risk_level}|session:{session_id}|action:{action or 'none'}", context


def build_event_engine_approval_hook(
    *,
    event_engine: Any,
    default_session_id: str,
    approval_scope_id: str | None = None,
    attempt_id: str | None = None,
    user_message_id: str | None = None,
):
    async def _approval_hook(
        capability_id: str,
        params: dict[str, Any],
        metadata: Any,
    ) -> dict[str, Any]:
        metadata_additional = (
            metadata.additional if isinstance(getattr(metadata, "additional", None), dict) else {}
        )
        tool_name = str(
            metadata_additional.get("display_name")
            or metadata_additional.get("actual_tool_name")
            or capability_id
        ).strip() or capability_id
        risk_level = str(metadata_additional.get("risk_level") or "high")
        runtime_session_id = (
            str(approval_scope_id or default_session_id).strip()
            or default_session_id
        )[:80]
        scope_key, approval_context = build_approval_policy(
            capability_id,
            tool_name,
            params,
            risk_level,
            runtime_session_id,
            metadata_additional,
        )
        resolved_scope_id = str(approval_scope_id or default_session_id).strip() or default_session_id
        approval_context["runtime_session_id"] = default_session_id
        approval_context["approval_scope_id"] = resolved_scope_id
        approval_context["attempt_id"] = str(attempt_id or "").strip() or None
        approval_context["user_message_id"] = str(user_message_id or "").strip() or None
        approval_context["blocking"] = True
        internal_session_id = str(params.get("session_id") or "").strip()
        if internal_session_id and internal_session_id != runtime_session_id:
            approval_context["tool_session_id"] = internal_session_id

        event_signature = hashlib.sha256(scope_key.encode()).hexdigest()[:16]
        event_id = f"{runtime_session_id}:{event_signature}"

        approved_history = event_engine.store.list_approvals(status="approved", limit=1000)
        for approved in approved_history:
            if approved.event_id == event_id:
                return {
                    "approved": True,
                    "status": "approved",
                    "approval_id": approved.approval_id,
                    "reason": "approval already granted",
                    "tool_name": tool_name,
                    "params": params,
                }

        rejected_history = event_engine.store.list_approvals(status="rejected", limit=1000)
        for rejected in rejected_history:
            if rejected.event_id == event_id:
                return {
                    "approved": False,
                    "status": "rejected",
                    "approval_id": rejected.approval_id,
                    "reason": (
                        f"`{tool_name}` 已被人工拒绝。审批ID: {rejected.approval_id}。"
                        " 如需再次执行，请重新发起新的操作。"
                    ),
                    "tool_name": tool_name,
                    "params": params,
                }

        pending_history = event_engine.store.list_approvals(status="pending", limit=1000)
        for pending in pending_history:
            if pending.event_id == event_id:
                return {
                    "approved": False,
                    "status": "pending",
                    "approval_id": pending.approval_id,
                    "reason": (
                        f"需要人工审批后才会执行 `{tool_name}`。审批ID: {pending.approval_id}。"
                        f" 可执行 `/approve {pending.approval_id}` 或 `/reject {pending.approval_id}`。"
                    ),
                    "tool_name": tool_name,
                    "params": params,
                }

        approval = await event_engine.approval_manager.request(
            rule_id=f"capability.{capability_id}",
            event_id=event_id,
            risk_level=risk_level,
            context=approval_context,
        )
        return {
            "approved": False,
            "status": "pending",
            "approval_id": approval.approval_id,
            "reason": (
                f"需要人工审批后才会执行 `{tool_name}`。审批ID: {approval.approval_id}。"
                f" 可执行 `/approve {approval.approval_id}` 或 `/reject {approval.approval_id}`。"
            ),
            "tool_name": tool_name,
            "params": params,
        }

    return _approval_hook
