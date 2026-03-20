"""Telegram renderer placeholder.

Current runtime notify/event flows still construct payloads directly in notifiers.
The renderer abstraction is introduced now so later channel-aware result rendering
can move here without touching runtime core again.
"""

from __future__ import annotations

from src.gateway.rendering.types import ChannelRenderResult, RenderInput, RenderedMessage


class TelegramRenderer:
    def render(self, payload: RenderInput) -> ChannelRenderResult:
        text = payload.plain_text or payload.summary or payload.body_markdown or ""
        return ChannelRenderResult(messages=[RenderedMessage(kind="text", content={"text": text})])
