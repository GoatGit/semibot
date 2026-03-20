"""Common rendering types for channel plugins."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class RenderInput:
    """Provider-agnostic render input produced by runtime/gateway."""

    message_type: str
    title: str | None = None
    summary: str | None = None
    body_markdown: str | None = None
    plain_text: str | None = None
    citations: list[dict[str, Any]] = field(default_factory=list)
    attachments: list[dict[str, Any]] = field(default_factory=list)
    approval: dict[str, Any] | None = None
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class RenderedMessage:
    """Single channel-specific outbound message unit."""

    kind: str
    content: dict[str, Any]
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ChannelRenderResult:
    """Set of rendered messages to send through a channel."""

    messages: list[RenderedMessage] = field(default_factory=list)
