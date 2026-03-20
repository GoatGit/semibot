"""Feishu renderer placeholder."""

from __future__ import annotations

from src.gateway.rendering.types import ChannelRenderResult, RenderInput, RenderedMessage


class FeishuRenderer:
    def render(self, payload: RenderInput) -> ChannelRenderResult:
        text = payload.plain_text or payload.summary or payload.body_markdown or ""
        title = payload.title or "Semibot"
        return ChannelRenderResult(
            messages=[RenderedMessage(kind="text", content={"title": title, "content": text})]
        )
