"""Renderer protocol used by channel plugins."""

from __future__ import annotations

from typing import Protocol

from src.gateway.rendering.types import ChannelRenderResult, RenderInput


class ChannelRenderer(Protocol):
    def render(self, payload: RenderInput) -> ChannelRenderResult: ...
