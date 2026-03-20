"""Tests for Discord outbound notifier behavior."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from src.events.models import Event
from src.gateway.notifiers.discord_notifier import DiscordNotifier


@pytest.mark.asyncio
async def test_discord_notifier_plain_text() -> None:
    sent: list[dict] = []

    async def _send(token: str, channel_id: str, payload: dict, files, timeout: float) -> None:
        sent.append(
            {
                "token": token,
                "channel_id": channel_id,
                "payload": payload,
                "files": files,
                "timeout": timeout,
            }
        )

    notifier = DiscordNotifier(
        bot_token="discord_token",
        default_channel_id="chan_1",
        send_fn=_send,
    )
    ok = await notifier.send_message(text="hello discord")
    assert ok is True
    assert len(sent) == 1
    assert sent[0]["channel_id"] == "chan_1"
    assert sent[0]["payload"]["content"] == "hello discord"


@pytest.mark.asyncio
async def test_discord_notifier_formats_approval_requested_message() -> None:
    sent: list[dict] = []

    async def _send(token: str, channel_id: str, payload: dict, files, timeout: float) -> None:
        sent.append({"payload": payload, "channel_id": channel_id})

    notifier = DiscordNotifier(
        bot_token="discord_token",
        default_channel_id="chan_1",
        send_fn=_send,
    )
    event = Event(
        event_id="evt_1",
        event_type="approval.requested",
        source="runtime.approval_manager",
        subject="appr_123",
        payload={
            "approval_id": "appr_123",
            "risk_level": "high",
            "context": {
                "tool_name": "rule_authoring",
                "action": "create",
                "target": "daily_news",
            },
        },
        timestamp=datetime.now(UTC),
    )
    await notifier.handle_event(event)
    assert len(sent) == 1
    text = str(sent[0]["payload"]["content"])
    assert "appr_123" in text
    assert "rule_authoring" in text
    assert "同意" in text
