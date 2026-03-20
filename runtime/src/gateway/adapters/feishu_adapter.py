"""Feishu gateway callback normalization and callback parsing."""

from __future__ import annotations

import json
from typing import Any


def verify_callback_token(body: dict[str, Any], expected_token: str | None) -> bool:
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


def normalize_message_event(body: dict[str, Any], *, app_id: str | None = None) -> dict[str, Any] | None:
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

    sender = event_data.get("sender") if isinstance(event_data.get("sender"), dict) else {}
    sender_id = None
    sender_id_obj = sender.get("sender_id") if isinstance(sender.get("sender_id"), dict) else {}
    if sender_id_obj:
        sender_id = sender_id_obj.get("open_id") or sender_id_obj.get("union_id") or sender_id_obj.get("user_id")

    return {
        "event_type": "chat.message.received",
        "source": "feishu.gateway",
        "subject": message.get("chat_id"),
        "payload": {
            "feishu_event_type": "im.message.receive_v1",
            "feishu_event_id": event_id,
            "tenant_key": header.get("tenant_key"),
            "app_id": app_id,
            "chat_id": message.get("chat_id"),
            "chat_type": message.get("chat_type"),
            "message_id": message_id,
            "message_type": message_type,
            "content": parsed_content,
            "mentions": message.get("mentions"),
            "sender": sender,
            "sender_id": sender_id,
            "raw_event": event_data,
            "is_mention": bool(message.get("mentions")),
            "is_reply_to_bot": False,
        },
        "idempotency_key": idempotency_key,
    }


def parse_card_action(body: dict[str, Any]) -> dict[str, Any]:
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

    approval_id = action_value.get("approval_id") or body.get("approval_id")
    trace_id = action_value.get("trace_id") or body.get("trace_id")

    return {
        "approval_id": approval_id if isinstance(approval_id, str) else None,
        "decision": normalized_decision,
        "raw_decision": decision,
        "trace_id": trace_id if isinstance(trace_id, str) and trace_id else None,
    }
