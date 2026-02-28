"""Telegram gateway callback normalization and callback parsing."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from src.gateway.adapters.base import NormalizedGatewayMessage


def verify_webhook_secret(headers: Mapping[str, str] | None, expected_secret: str | None) -> bool:
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


def _is_mention(text: str, entities: Any, bot_username: str | None) -> bool:
    if not text:
        return False
    if isinstance(bot_username, str) and bot_username:
        if f"@{bot_username.lower()}" in text.lower():
            return True
    if isinstance(entities, list):
        for item in entities:
            if not isinstance(item, dict):
                continue
            if str(item.get("type") or "") == "mention":
                return True
    return False


def normalize_update(
    body: dict[str, Any], *, bot_username: str | None = None, bot_id: str | None = None
) -> dict[str, Any] | None:
    update_id = body.get("update_id")
    idempotency_key = f"telegram:update:{update_id}" if update_id is not None else None

    message = body.get("message") if isinstance(body.get("message"), dict) else None
    if not message:
        message = body.get("edited_message") if isinstance(body.get("edited_message"), dict) else None
    if message:
        chat = message.get("chat") if isinstance(message.get("chat"), dict) else {}
        text = _message_text(message)
        sender = message.get("from") if isinstance(message.get("from"), dict) else {}
        mention = _is_mention(text, message.get("entities"), bot_username)
        reply_to = message.get("reply_to_message") if isinstance(message.get("reply_to_message"), dict) else None
        is_reply_to_bot = False
        if isinstance(reply_to, dict):
            from_user = reply_to.get("from") if isinstance(reply_to.get("from"), dict) else {}
            is_reply_to_bot = bool(from_user.get("is_bot"))

        normalized = NormalizedGatewayMessage(
            provider="telegram",
            event_type="chat.message.received",
            source="telegram.gateway",
            subject=str(chat.get("id")) if chat.get("id") is not None else None,
            text=text,
            chat_id=str(chat.get("id")) if chat.get("id") is not None else None,
            bot_id=str(bot_id) if bot_id else None,
            sender_id=str(sender.get("id")) if sender.get("id") is not None else None,
            is_mention=mention,
            is_reply_to_bot=is_reply_to_bot,
            payload={
                "telegram_update_id": update_id,
                "message_id": message.get("message_id"),
                "chat_id": chat.get("id"),
                "chat_type": chat.get("type"),
                "sender": sender,
                "content": {"text": text} if text else {},
                "text": text,
                "raw_update": body,
            },
            idempotency_key=idempotency_key,
        )
        return {
            "event_type": normalized.event_type,
            "source": normalized.source,
            "subject": normalized.subject,
            "payload": normalized.to_event_payload(),
            "idempotency_key": normalized.idempotency_key,
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
        sender = callback_query.get("from") if isinstance(callback_query.get("from"), dict) else {}
        normalized = NormalizedGatewayMessage(
            provider="telegram",
            event_type="chat.card.action",
            source="telegram.gateway",
            subject=subject,
            text=text,
            chat_id=chat_id,
            bot_id=str(bot_id) if bot_id else None,
            sender_id=str(sender.get("id")) if sender.get("id") is not None else None,
            payload={
                "telegram_update_id": update_id,
                "callback_query_id": callback_query.get("id"),
                "chat_id": chat_id,
                "sender": sender,
                "content": {"text": text} if text else {},
                "text": text,
                "raw_update": body,
            },
            idempotency_key=idempotency_key,
        )
        return {
            "event_type": normalized.event_type,
            "source": normalized.source,
            "subject": normalized.subject,
            "payload": normalized.to_event_payload(),
            "idempotency_key": normalized.idempotency_key,
        }

    return None


def parse_callback_action(body: dict[str, Any]) -> dict[str, str | None]:
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
