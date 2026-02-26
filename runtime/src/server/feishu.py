"""Helpers for Feishu gateway callback normalization."""

from __future__ import annotations

import json
from typing import Any


def verify_callback_token(body: dict[str, Any], expected_token: str | None) -> bool:
    """Validate Feishu callback token when configured."""
    if not expected_token:
        return True
    candidates = [
        body.get("token"),
        body.get("header", {}).get("token") if isinstance(body.get("header"), dict) else None,
    ]
    for value in candidates:
        if isinstance(value, str) and value == expected_token:
            return True
    return False


def maybe_url_verification(body: dict[str, Any]) -> str | None:
    """Return challenge for url_verification callbacks."""
    if str(body.get("type") or "") != "url_verification":
        return None
    challenge = body.get("challenge")
    if isinstance(challenge, str) and challenge:
        return challenge
    return None


def _parse_message_content(message_type: str, raw_content: Any) -> dict[str, Any]:
    if not isinstance(raw_content, str):
        return {"raw": raw_content}
    if message_type == "text":
        try:
            parsed = json.loads(raw_content)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass
    return {"raw": raw_content}


def normalize_message_event(body: dict[str, Any]) -> dict[str, Any] | None:
    """
    Normalize Feishu `im.message.receive_v1` callback to Semibot event fields.
    """
    header = body.get("header")
    if not isinstance(header, dict):
        return None
    if str(header.get("event_type") or "") != "im.message.receive_v1":
        return None

    event_data = body.get("event")
    if not isinstance(event_data, dict):
        return None
    message = event_data.get("message")
    if not isinstance(message, dict):
        return None

    message_type = str(message.get("message_type") or "")
    parsed_content = _parse_message_content(message_type, message.get("content"))
    message_id = message.get("message_id")
    event_id = str(header.get("event_id") or "")
    idempotency_key = None
    if isinstance(message_id, str) and message_id:
        idempotency_key = f"feishu:message:{message_id}"
    elif event_id:
        idempotency_key = f"feishu:event:{event_id}"

    return {
        "event_type": "chat.message.received",
        "source": "feishu.gateway",
        "subject": message.get("chat_id"),
        "payload": {
            "feishu_event_type": "im.message.receive_v1",
            "feishu_event_id": event_id,
            "tenant_key": header.get("tenant_key"),
            "chat_id": message.get("chat_id"),
            "chat_type": message.get("chat_type"),
            "message_id": message_id,
            "message_type": message_type,
            "content": parsed_content,
            "mentions": message.get("mentions"),
            "sender": event_data.get("sender"),
            "raw_event": event_data,
        },
        "idempotency_key": idempotency_key,
    }


def parse_card_action(body: dict[str, Any]) -> dict[str, Any]:
    """Extract approval intent from Feishu card callback payload."""
    action = body.get("action")
    action_value = action.get("value") if isinstance(action, dict) else {}
    if not isinstance(action_value, dict):
        action_value = {}

    raw_decision = (
        action_value.get("decision")
        or action_value.get("result")
        or action_value.get("action")
        or body.get("decision")
    )
    decision = str(raw_decision or "").strip().lower()
    if decision in {"approve", "approved", "pass", "ok"}:
        normalized_decision = "approved"
    elif decision in {"reject", "rejected", "deny", "no"}:
        normalized_decision = "rejected"
    else:
        normalized_decision = ""

    approval_id = (
        action_value.get("approval_id")
        or body.get("approval_id")
    )
    trace_id = action_value.get("trace_id") or body.get("trace_id")

    return {
        "approval_id": approval_id if isinstance(approval_id, str) else None,
        "decision": normalized_decision,
        "raw_decision": decision,
        "trace_id": trace_id if isinstance(trace_id, str) and trace_id else None,
    }
