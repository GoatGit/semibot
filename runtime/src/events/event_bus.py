"""Async in-process event bus."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from src.events.models import Event

EventHandler = Callable[[Event], Awaitable[Any]]


class EventBus:
    """Simple async publish/subscribe bus."""

    def __init__(self):
        self._handlers: list[EventHandler] = []

    def subscribe(self, handler: EventHandler) -> None:
        if handler not in self._handlers:
            self._handlers.append(handler)

    async def emit(self, event: Event) -> list[Any]:
        responses: list[Any] = []
        for handler in self._handlers:
            responses.append(await handler(event))
        return responses
