"""Background trigger scheduler for heartbeat/cron-like event sources."""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import uuid4

from src.events.models import Event, utc_now

EmitEventFn = Callable[[Event], Awaitable[Any]]


@dataclass
class ScheduledTrigger:
    """Normalized periodic trigger configuration."""

    name: str
    event_type: str
    interval_seconds: float
    source: str
    subject: str | None = None
    payload: dict[str, Any] = field(default_factory=dict)
    trigger_kind: str = "cron"
    schedule: str | None = None


class TriggerScheduler:
    """Run periodic trigger jobs and emit events through EventEngine."""

    def __init__(self, *, emit_event: EmitEventFn):
        self._emit_event = emit_event
        self._tasks: list[asyncio.Task[None]] = []

    @staticmethod
    def parse_schedule_to_interval_seconds(schedule: str) -> float | None:
        """
        Parse lightweight cron schedule into interval seconds.

        Supported formats:
        - @every:<seconds>     e.g. @every:30 or @every:2.5
        - */N * * * *          every N minutes
        """
        value = schedule.strip()
        if not value:
            return None

        if value.startswith("@every:"):
            raw = value.split(":", 1)[1].strip()
            try:
                seconds = float(raw)
            except ValueError:
                return None
            return seconds if seconds > 0 else None

        minute_match = re.fullmatch(r"\*/(\d+)\s+\*\s+\*\s+\*\s+\*", value)
        if minute_match:
            minutes = int(minute_match.group(1))
            if minutes <= 0:
                return None
            return float(minutes * 60)

        return None

    def start_heartbeat(
        self,
        *,
        interval_seconds: float,
        event_type: str = "health.heartbeat.tick",
        source: str = "system.heartbeat",
        subject: str | None = "system",
        payload: dict[str, Any] | None = None,
    ) -> bool:
        if interval_seconds <= 0:
            return False
        trigger = ScheduledTrigger(
            name="heartbeat",
            event_type=event_type,
            interval_seconds=interval_seconds,
            source=source,
            subject=subject,
            payload=payload or {},
            trigger_kind="heartbeat",
            schedule=f"@every:{interval_seconds}",
        )
        self._tasks.append(asyncio.create_task(self._run_periodic(trigger)))
        return True

    def start_cron_jobs(self, jobs: list[dict[str, Any]]) -> int:
        started = 0
        for idx, raw_job in enumerate(jobs):
            if not isinstance(raw_job, dict):
                continue
            schedule = str(raw_job.get("schedule") or raw_job.get("cron") or "").strip()
            interval = self.parse_schedule_to_interval_seconds(schedule) if schedule else None
            if interval is None:
                continue

            name = str(raw_job.get("name") or f"cron_job_{idx}")
            event_type = str(raw_job.get("event_type") or f"cron.job.{name}.tick")
            source = str(raw_job.get("source") or "system.cron")
            subject_value = raw_job.get("subject")
            subject = str(subject_value) if subject_value is not None else None
            payload = raw_job.get("payload")

            trigger = ScheduledTrigger(
                name=name,
                event_type=event_type,
                interval_seconds=interval,
                source=source,
                subject=subject,
                payload=payload if isinstance(payload, dict) else {},
                trigger_kind="cron",
                schedule=schedule,
            )
            self._tasks.append(asyncio.create_task(self._run_periodic(trigger)))
            started += 1
        return started

    async def stop(self) -> None:
        if not self._tasks:
            return
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

    async def _run_periodic(self, trigger: ScheduledTrigger) -> None:
        next_due = time.monotonic() + trigger.interval_seconds
        while True:
            wait_for = next_due - time.monotonic()
            if wait_for > 0:
                await asyncio.sleep(wait_for)

            now = utc_now()
            event_payload = {
                **trigger.payload,
                "trigger_kind": trigger.trigger_kind,
                "trigger_name": trigger.name,
                "schedule": trigger.schedule,
                "interval_seconds": trigger.interval_seconds,
                "emitted_at": now.isoformat(),
            }
            event = Event(
                event_id=f"evt_trigger_{uuid4().hex}",
                event_type=trigger.event_type,
                source=trigger.source,
                subject=trigger.subject,
                payload=event_payload,
                timestamp=now,
                risk_hint="low",
            )
            await self._emit_event(event)
            next_due += trigger.interval_seconds
