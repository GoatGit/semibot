"""Tests for Telegram outbound notifier behavior."""

from __future__ import annotations

import pytest

from src.server.telegram_notifier import TelegramNotifier


@pytest.mark.asyncio
async def test_telegram_notifier_plain_text_without_parse_mode():
    sent: list[dict] = []

    async def _send(token: str, payload: dict, timeout: float) -> None:
        sent.append({"token": token, "payload": payload, "timeout": timeout})

    notifier = TelegramNotifier(
        bot_token="token_abc",
        default_chat_id="-100001",
        send_fn=_send,
    )
    ok = await notifier.send_message(text="hello")
    assert ok is True
    assert len(sent) == 1
    assert sent[0]["payload"]["text"] == "hello"
    assert "parse_mode" not in sent[0]["payload"]


@pytest.mark.asyncio
async def test_telegram_notifier_splits_long_messages():
    sent: list[dict] = []

    async def _send(token: str, payload: dict, timeout: float) -> None:
        sent.append({"token": token, "payload": payload, "timeout": timeout})

    notifier = TelegramNotifier(
        bot_token="token_abc",
        default_chat_id="-100001",
        send_fn=_send,
    )
    text = "A" * 7600
    ok = await notifier.send_message(text=text)
    assert ok is True
    assert len(sent) >= 3
    assert sum(len(item["payload"]["text"]) for item in sent) == len(text)
    assert all(len(item["payload"]["text"]) <= 3500 for item in sent)

