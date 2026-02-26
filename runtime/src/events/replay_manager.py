"""Event replay utilities."""

from __future__ import annotations

from datetime import datetime

from src.events.event_store import EventStore
from src.events.rules_engine import RuleExecutionResult, RulesEngine


class ReplayManager:
    """Replay historical events through the current ruleset."""

    def __init__(self, *, store: EventStore, rules_engine: RulesEngine):
        self.store = store
        self.rules_engine = rules_engine

    async def replay_event(self, event_id: str) -> list[RuleExecutionResult]:
        """Replay one event by ID."""
        event = self.store.get(event_id)
        if event is None:
            return []
        return await self.rules_engine.handle_event(event, persist_event=False)

    async def replay_by_type(self, event_type: str, since: datetime) -> int:
        """Replay events by event type since timestamp."""
        events = self.store.list_events(limit=10000, event_type=event_type, since=since)
        replayed = 0
        for event in events:
            await self.rules_engine.handle_event(event, persist_event=False)
            replayed += 1
        return replayed
