"""Tests for discord adapter normalization."""

from __future__ import annotations

from src.gateway.adapters.discord_adapter import normalize_message_event


def test_normalize_message_event_extracts_attachment_and_mention() -> None:
    normalized = normalize_message_event(
        {
            "type": "message_create",
            "data": {
                "id": "msg_1",
                "channel_id": "chan_1",
                "guild_id": "guild_1",
                "content": "hello",
                "author": {"id": "user_1", "username": "alice"},
                "mentions": [{"id": "bot_1"}],
                "attachments": [
                    {
                        "id": "att_1",
                        "filename": "report.pdf",
                        "content_type": "application/pdf",
                        "size": 12345,
                        "url": "https://cdn.example/report.pdf",
                    }
                ],
            },
        },
        bot_user_id="bot_1",
    )
    assert isinstance(normalized, dict)
    payload = normalized.get("payload")
    assert isinstance(payload, dict)
    assert payload.get("text") == "hello"
    assert payload.get("is_mention") is True
    attachments = payload.get("attachments")
    assert isinstance(attachments, list)
    assert len(attachments) == 1
    item = attachments[0]
    assert item["file_id"] == "att_1"
    assert item["file_name"] == "report.pdf"
    assert item["url"] == "https://cdn.example/report.pdf"


def test_normalize_message_event_ignores_bot_self_message() -> None:
    normalized = normalize_message_event(
        {
            "type": "message_create",
            "data": {
                "id": "msg_2",
                "channel_id": "chan_1",
                "author": {"id": "bot_1"},
                "content": "self",
            },
        },
        bot_user_id="bot_1",
    )
    assert normalized is None
