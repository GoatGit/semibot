"""Outbound Telegram notifier for key Semibot events."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

import httpx

from src.events.models import Event

SendFn = Callable[[str, dict[str, Any], float], Awaitable[None]]


async def default_send_json(token: str, payload: dict[str, Any], timeout: float) -> None:
    """POST JSON payload to Telegram bot API."""
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    async with httpx.AsyncClient(timeout=timeout) as client:
        await client.post(url, json=payload)


class TelegramNotifier:
    """Convert selected internal events into Telegram messages."""

    def __init__(
        self,
        *,
        bot_token: str | None = None,
        default_chat_id: str | None = None,
        timeout: float = 10.0,
        send_fn: SendFn | None = None,
        subscribed_event_types: set[str] | None = None,
        parse_mode: str | None = None,
        disable_link_preview: bool = False,
    ):
        self.bot_token = bot_token
        self.default_chat_id = default_chat_id
        self.timeout = timeout
        self.send_fn = send_fn or default_send_json
        self.subscribed_event_types = subscribed_event_types or {
            "approval.requested",
            "task.completed",
            "rule.run_agent.executed",
        }
        self.parse_mode = parse_mode
        self.disable_link_preview = disable_link_preview

    @staticmethod
    def _split_text(text: str, max_len: int = 3500) -> list[str]:
        raw = text or ""
        if len(raw) <= max_len:
            return [raw]
        chunks: list[str] = []
        remaining = raw
        while len(remaining) > max_len:
            cut = remaining.rfind("\n", 0, max_len)
            if cut <= 0:
                cut = max_len
            chunks.append(remaining[:cut].strip())
            remaining = remaining[cut:].lstrip()
        if remaining:
            chunks.append(remaining)
        return [chunk for chunk in chunks if chunk]

    async def send_message(self, *, text: str, chat_id: str | None = None) -> bool:
        token = self.bot_token
        target_chat_id = chat_id or self.default_chat_id
        if not token or not target_chat_id:
            return False

        chunks = self._split_text(text)
        if not chunks:
            return False
        for chunk in chunks:
            payload: dict[str, Any] = {
                "chat_id": target_chat_id,
                "text": chunk,
                "disable_web_page_preview": self.disable_link_preview,
            }
            if self.parse_mode:
                payload["parse_mode"] = self.parse_mode
            await self.send_fn(token, payload, self.timeout)
        return True

    async def send_notify_payload(self, payload: dict[str, Any]) -> bool:
        text = str(
            payload.get("content")
            or payload.get("summary")
            or payload.get("message")
            or f"event_type={payload.get('event_type')}"
        )
        chat_id = str(payload.get("chat_id")) if payload.get("chat_id") else None
        return await self.send_message(text=text, chat_id=chat_id)

    async def handle_event(self, event: Event) -> None:
        if event.event_type not in self.subscribed_event_types:
            return

        payload = event.payload if isinstance(event.payload, dict) else {}
        text = (
            f"*Semibot* `{event.event_type}`\n"
            f"subject: `{event.subject or payload.get('session_id') or 'n/a'}`\n"
            f"summary: {payload.get('summary') or payload.get('final_response') or payload.get('message') or '任务已完成。'}"
        )
        chat_id = str(payload.get("chat_id")) if payload.get("chat_id") else None
        await self.send_message(text=text, chat_id=chat_id)
