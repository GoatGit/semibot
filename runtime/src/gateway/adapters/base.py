"""Gateway adapter base types."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(slots=True)
class NormalizedGatewayMessage:
    provider: str
    event_type: str
    source: str
    subject: str | None
    text: str
    chat_id: str | None
    bot_id: str | None
    sender_id: str | None
    is_mention: bool = False
    is_reply_to_bot: bool = False
    payload: dict[str, Any] | None = None
    idempotency_key: str | None = None

    def to_event_payload(self) -> dict[str, Any]:
        payload = dict(self.payload or {})
        payload.setdefault("text", self.text)
        payload.setdefault("chat_id", self.chat_id)
        payload.setdefault("bot_id", self.bot_id)
        payload.setdefault("sender_id", self.sender_id)
        payload.setdefault("is_mention", self.is_mention)
        payload.setdefault("is_reply_to_bot", self.is_reply_to_bot)
        return payload
