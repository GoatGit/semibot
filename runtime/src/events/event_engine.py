"""High-level event engine composition root."""

from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path

from src.events.approval_manager import ApprovalManager
from src.events.attention_budget import AttentionBudget
from src.events.event_bus import EventBus
from src.events.event_router import EventRouter, NoopActionExecutor
from src.events.event_store import EventStore
from src.events.models import ApprovalRequest, Event, EventRule
from src.events.models import RuleRun
from src.events.rule_loader import list_rule_files, load_rules
from src.events.replay_manager import ReplayManager
from src.events.rule_evaluator import RuleEvaluator
from src.events.rules_engine import RuleExecutionResult, RulesEngine
from src.events.trigger_scheduler import TriggerScheduler


class EventEngine:
    """Facade over EventBus + RulesEngine + EventStore."""

    def __init__(
        self,
        *,
        store: EventStore | None = None,
        bus: EventBus | None = None,
        evaluator: RuleEvaluator | None = None,
        router: EventRouter | None = None,
        approval_manager: ApprovalManager | None = None,
        attention_budget: AttentionBudget | None = None,
        rules: list[EventRule] | None = None,
        rules_path: str | None = None,
    ):
        self.store = store or EventStore()
        self.bus = bus or EventBus()
        self.evaluator = evaluator or RuleEvaluator()
        self.router = router or EventRouter(NoopActionExecutor())
        self.rules_path = str(Path(rules_path).expanduser()) if rules_path else None
        self._rule_files_mtime: dict[str, int] = {}
        self._rule_watch_task: asyncio.Task[None] | None = None
        self.approval_manager = approval_manager or ApprovalManager(self.store, emit_event=self.emit)
        self.attention_budget = attention_budget or AttentionBudget()
        loaded_rules = rules or load_rules(self.rules_path) if self.rules_path else rules or []
        self.rules_engine = RulesEngine(
            store=self.store,
            evaluator=self.evaluator,
            router=self.router,
            approval_manager=self.approval_manager,
            attention_budget=self.attention_budget,
            rules=loaded_rules,
        )
        self.replay_manager = ReplayManager(store=self.store, rules_engine=self.rules_engine)
        self.trigger_scheduler = TriggerScheduler(emit_event=self.emit)
        self.bus.subscribe(self._on_event)
        self._refresh_rule_files_snapshot()

    async def _on_event(self, event: Event) -> list[RuleExecutionResult]:
        return await self.rules_engine.handle_event(event)

    async def emit(self, event: Event) -> list[RuleExecutionResult]:
        """Emit an event to bus and return execution result snapshot."""
        self.reload_rules_if_changed()
        responses = await self.bus.emit(event)
        if not responses:
            return []
        first = responses[0]
        if isinstance(first, list):
            return first
        return []

    def set_rules(self, rules: list[EventRule]) -> None:
        self.rules_engine.set_rules(rules)

    def add_rule(self, rule: EventRule) -> None:
        self.rules_engine.add_rule(rule)

    def reload_rules(self) -> int:
        """Reload rules from rules_path, returns loaded count."""
        if not self.rules_path:
            return len(self.rules_engine.list_rules())
        rules = load_rules(self.rules_path)
        self.rules_engine.set_rules(rules)
        self._refresh_rule_files_snapshot()
        return len(rules)

    def reload_rules_if_changed(self) -> bool:
        """Reload rules when rule files changed on disk."""
        if not self.rules_path:
            return False
        current = self._capture_rule_files_mtime()
        if current != self._rule_files_mtime:
            self.reload_rules()
            return True
        return False

    def list_rules(self) -> list[EventRule]:
        self.reload_rules_if_changed()
        return self.rules_engine.list_rules()

    def list_events(
        self,
        *,
        limit: int = 100,
        event_type: str | None = None,
        event_types: list[str] | None = None,
    ) -> list[Event]:
        return self.store.list_events(limit=limit, event_type=event_type, event_types=event_types)

    def list_events_after(
        self,
        *,
        cursor_created_at: str | None = None,
        cursor_event_id: str | None = None,
        limit: int = 100,
        event_type: str | None = None,
        event_types: list[str] | None = None,
    ) -> list[Event]:
        return self.store.list_events_after(
            cursor_created_at=cursor_created_at,
            cursor_event_id=cursor_event_id,
            limit=limit,
            event_type=event_type,
            event_types=event_types,
        )

    def list_pending_approvals(self) -> list[ApprovalRequest]:
        return self.approval_manager.list_pending()

    def list_approvals(self, *, status: str | None = None, limit: int = 100) -> list[ApprovalRequest]:
        return self.store.list_approvals(status=status, limit=limit)

    def list_rule_runs(
        self,
        *,
        rule_id: str | None = None,
        event_id: str | None = None,
        status: str | None = None,
        limit: int = 100,
    ) -> list[RuleRun]:
        return self.store.list_rule_runs(
            rule_id=rule_id,
            event_id=event_id,
            status=status,
            limit=limit,
        )

    def metrics(self, *, since: datetime | None = None) -> dict[str, object]:
        """Get current event-engine metrics snapshot."""
        return self.store.get_metrics(since=since)

    async def resolve_approval(self, approval_id: str, decision: str):
        return await self.approval_manager.resolve(approval_id, decision)

    async def replay_event(self, event_id: str) -> list[RuleExecutionResult]:
        return await self.replay_manager.replay_event(event_id)

    async def replay_by_type(self, event_type: str, since: datetime) -> int:
        return await self.replay_manager.replay_by_type(event_type, since)

    def start_heartbeat(
        self,
        *,
        interval_seconds: float,
        event_type: str = "health.heartbeat.tick",
        source: str = "system.heartbeat",
        subject: str | None = "system",
        payload: dict[str, object] | None = None,
    ) -> bool:
        return self.trigger_scheduler.start_heartbeat(
            interval_seconds=interval_seconds,
            event_type=event_type,
            source=source,
            subject=subject,
            payload=payload,
        )

    def start_cron_jobs(self, jobs: list[dict[str, object]]) -> int:
        return self.trigger_scheduler.start_cron_jobs(jobs)

    async def stop_triggers(self) -> None:
        await self.trigger_scheduler.stop()

    def _capture_rule_files_mtime(self) -> dict[str, int]:
        if not self.rules_path:
            return {}
        snapshots: dict[str, int] = {}
        for file in list_rule_files(self.rules_path):
            try:
                snapshots[str(file)] = int(file.stat().st_mtime_ns)
            except FileNotFoundError:
                continue
        return snapshots

    def _refresh_rule_files_snapshot(self) -> None:
        self._rule_files_mtime = self._capture_rule_files_mtime()

    def start_rule_watch(self, *, poll_interval: float = 1.0) -> None:
        """Start background rule-file watch loop."""
        if self._rule_watch_task and not self._rule_watch_task.done():
            return
        self._rule_watch_task = asyncio.create_task(self._rule_watch_loop(poll_interval))

    async def stop_rule_watch(self) -> None:
        """Stop background rule-file watch loop."""
        if not self._rule_watch_task:
            return
        self._rule_watch_task.cancel()
        try:
            await self._rule_watch_task
        except asyncio.CancelledError:
            pass
        self._rule_watch_task = None

    async def _rule_watch_loop(self, poll_interval: float) -> None:
        while True:
            await asyncio.sleep(max(poll_interval, 0.1))
            self.reload_rules_if_changed()
