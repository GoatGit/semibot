"""Compatibility helpers for Discord message normalization."""

from __future__ import annotations

from typing import Any


def normalize_message_event(body: dict[str, Any], *, bot_user_id: str | None = None) -> dict[str, Any] | None:
    """Normalize Discord webhook payload into the lightweight adapter shape used in tests."""
    data = body.get("data") if isinstance(body, dict) else None
    message = data if isinstance(data, dict) else {}
    author = message.get("author")
    author_map = author if isinstance(author, dict) else {}
    sender_id = str(author_map.get("id") or "").strip()
    if bot_user_id and sender_id == bot_user_id:
        return None

    mentions_raw = message.get("mentions")
    mentions = [item for item in mentions_raw if isinstance(item, dict)] if isinstance(mentions_raw, list) else []
    attachments_raw = message.get("attachments")
    attachments = [item for item in attachments_raw if isinstance(item, dict)] if isinstance(attachments_raw, list) else []

    normalized_attachments = [
        {
            "file_id": str(item.get("id") or "").strip(),
            "file_name": str(item.get("filename") or "").strip(),
            "mime_type": str(item.get("content_type") or "").strip() or None,
            "size": item.get("size"),
            "url": str(item.get("url") or "").strip() or None,
        }
        for item in attachments
    ]

    return {
        "type": "chat.message.received",
        "payload": {
            "text": str(message.get("content") or ""),
            "chat_id": str(message.get("channel_id") or "").strip() or None,
            "guild_id": str(message.get("guild_id") or "").strip() or None,
            "message_id": str(message.get("id") or "").strip() or None,
            "sender_id": sender_id or None,
            "sender_name": str(author_map.get("username") or "").strip() or None,
            "is_mention": bool(
                bot_user_id and any(str(item.get("id") or "").strip() == bot_user_id for item in mentions)
            ),
            "attachments": normalized_attachments,
        },
    }
