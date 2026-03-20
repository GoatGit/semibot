"""iMessage renderer placeholder."""

from __future__ import annotations

from src.gateway.rendering.types import ChannelRenderResult, RenderInput, RenderedMessage


class IMessageRenderer:
    def render(self, payload: RenderInput) -> ChannelRenderResult:
        text = payload.plain_text or payload.summary or payload.body_markdown or ""
        return ChannelRenderResult(messages=[RenderedMessage(kind="text", content={"text": text})])
