"""Helpers for Telegram gateway callback normalization."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any


def verify_webhook_secret(headers: Mapping[str, str] | None, expected_secret: str | None) -> bool:
    """Validate Telegram webhook secret token when configured."""
    if not expected_secret:
        return True
    if not headers:
        return False
    token = (
        headers.get("x-telegram-bot-api-secret-token")
        or headers.get("X-Telegram-Bot-Api-Secret-Token")
    )
    return isinstance(token, str) and token == expected_secret


def _message_text(message: dict[str, Any]) -> str:
    text = message.get("text")
    if isinstance(text, str) and text.strip():
        return text.strip()
    caption = message.get("caption")
    if isinstance(caption, str) and caption.strip():
        return caption.strip()
    return ""


def normalize_update(body: dict[str, Any]) -> dict[str, Any] | None:
    """Normalize Telegram update payload into Semibot event fields."""
    update_id = body.get("update_id")
    idempotency_key = f"telegram:update:{update_id}" if update_id is not None else None

    message = body.get("message") if isinstance(body.get("message"), dict) else None
    if not message:
        message = body.get("edited_message") if isinstance(body.get("edited_message"), dict) else None
    if message:
        chat = message.get("chat") if isinstance(message.get("chat"), dict) else {}
        text = _message_text(message)
        return {
            "event_type": "chat.message.received",
            "source": "telegram.gateway",
            "subject": str(chat.get("id")) if chat.get("id") is not None else None,
            "payload": {
                "telegram_update_id": update_id,
                "message_id": message.get("message_id"),
                "chat_id": chat.get("id"),
                "chat_type": chat.get("type"),
                "sender": message.get("from"),
                "content": {"text": text} if text else {},
                "text": text,
                "raw_update": body,
            },
            "idempotency_key": idempotency_key,
        }

    callback_query = body.get("callback_query")
    if isinstance(callback_query, dict):
        data = callback_query.get("data")
        text = str(data).strip() if isinstance(data, str) else ""
        callback_message = callback_query.get("message")
        chat_id: str | None = None
        if isinstance(callback_message, dict):
            chat = callback_message.get("chat")
            if isinstance(chat, dict) and chat.get("id") is not None:
                chat_id = str(chat.get("id"))

        subject = chat_id or (
            str(callback_query.get("from", {}).get("id"))
            if isinstance(callback_query.get("from"), dict)
            else None
        )

        return {
            "event_type": "chat.card.action",
            "source": "telegram.gateway",
            "subject": subject,
            "payload": {
                "telegram_update_id": update_id,
                "callback_query_id": callback_query.get("id"),
                "chat_id": chat_id,
                "sender": callback_query.get("from"),
                "content": {"text": text} if text else {},
                "text": text,
                "raw_update": body,
            },
            "idempotency_key": idempotency_key,
        }

    return None


def parse_callback_action(body: dict[str, Any]) -> dict[str, str | None]:
    """Extract approval intent from Telegram callback payload."""
    callback_query = body.get("callback_query")
    if not isinstance(callback_query, dict):
        return {
            "approval_id": None,
            "decision": "",
            "raw_decision": "",
            "trace_id": None,
        }

    data = callback_query.get("data")
    raw_data = str(data).strip() if isinstance(data, str) else ""
    approval_id: str | None = None
    decision = ""
    trace_id: str | None = None

    if raw_data:
        try:
            parsed = json.loads(raw_data)
            if isinstance(parsed, dict):
                raw_decision = str(
                    parsed.get("decision") or parsed.get("action") or parsed.get("result") or ""
                ).strip()
                approval_id = (
                    str(parsed.get("approval_id")).strip()
                    if parsed.get("approval_id") is not None
                    else None
                )
                trace_id = (
                    str(parsed.get("trace_id")).strip()
                    if parsed.get("trace_id") is not None
                    else None
                )
                raw_data = raw_decision or raw_data
        except json.JSONDecodeError:
            pass

    lower = raw_data.lower()
    if ":" in lower and not approval_id:
        prefix, _, suffix = lower.partition(":")
        if prefix in {"approve", "approved", "pass", "ok"}:
            decision = "approved"
            approval_id = suffix.strip() or None
        elif prefix in {"reject", "rejected", "deny", "no"}:
            decision = "rejected"
            approval_id = suffix.strip() or None

    if not decision:
        if lower in {"approve", "approved", "pass", "ok"}:
            decision = "approved"
        elif lower in {"reject", "rejected", "deny", "no"}:
            decision = "rejected"
        elif lower.startswith("/approve"):
            decision = "approved"
            if not approval_id:
                approval_id = lower.replace("/approve", "", 1).strip() or None
        elif lower.startswith("/reject"):
            decision = "rejected"
            if not approval_id:
                approval_id = lower.replace("/reject", "", 1).strip() or None

    return {
        "approval_id": approval_id,
        "decision": decision,
        "raw_decision": lower,
        "trace_id": trace_id,
    }
