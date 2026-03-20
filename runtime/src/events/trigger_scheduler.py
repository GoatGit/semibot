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
CronCompleteFn = Callable[[str, dict[str, Any]], Awaitable[Any] | Any]


@dataclass
class CronFieldMatcher:
    min_value: int
    max_value: int
    allow_7_as_0: bool = False
    allowed: set[int] = field(default_factory=set)

    def matches(self, value: int) -> bool:
        if self.allow_7_as_0 and value == 0 and 7 in self.allowed:
            return True
        return value in self.allowed


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
    schedule_kind: str = "interval"
    cron_matchers: tuple[CronFieldMatcher, CronFieldMatcher, CronFieldMatcher, CronFieldMatcher, CronFieldMatcher] | None = None


class TriggerScheduler:
    """Run periodic trigger jobs and emit events through EventEngine."""

    def __init__(self, *, emit_event: EmitEventFn, on_cron_completed: CronCompleteFn | None = None):
        self._emit_event = emit_event
        self._on_cron_completed = on_cron_completed
        self._tasks: list[asyncio.Task[None]] = []
        self._cron_jobs: dict[str, ScheduledTrigger] = {}
        self._cron_tasks: dict[str, asyncio.Task[None]] = {}

    @staticmethod
    def _to_bool(value: Any, default: bool = False) -> bool:
        if value is None:
            return default
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in {"1", "true", "yes", "y", "on"}:
                return True
            if normalized in {"0", "false", "no", "n", "off", ""}:
                return False
        return bool(value)

    async def _handle_one_shot_completion(self, trigger: ScheduledTrigger) -> None:
        self._cron_jobs.pop(trigger.name, None)
        self._cron_tasks.pop(trigger.name, None)
        if not self._on_cron_completed:
            return
        payload = {
            "name": trigger.name,
            "event_type": trigger.event_type,
            "schedule": trigger.schedule,
            "source": trigger.source,
            "subject": trigger.subject,
            "payload": trigger.payload,
            "trigger_kind": trigger.trigger_kind,
            "schedule_kind": trigger.schedule_kind,
        }
        maybe = self._on_cron_completed(trigger.name, payload)
        if asyncio.iscoroutine(maybe):
            await maybe

    def _is_one_shot(self, trigger: ScheduledTrigger) -> bool:
        payload = trigger.payload if isinstance(trigger.payload, dict) else {}
        return self._to_bool(payload.get("one_shot", payload.get("oneShot", False)), default=False)

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

    @staticmethod
    def _parse_cron_field(
        raw: str,
        *,
        min_value: int,
        max_value: int,
        allow_7_as_0: bool = False,
    ) -> CronFieldMatcher | None:
        token = raw.strip()
        if not token:
            return None
        matcher = CronFieldMatcher(min_value=min_value, max_value=max_value, allow_7_as_0=allow_7_as_0)

        def _normalize(value: int) -> int | None:
            if allow_7_as_0 and value == 7:
                return 0
            if value < min_value or value > max_value:
                return None
            return value

        def _add_value(value: int) -> bool:
            normalized = _normalize(value)
            if normalized is None:
                return False
            matcher.allowed.add(normalized)
            return True

        def _add_range(start: int, end: int, step: int) -> bool:
            if step <= 0:
                return False
            for value in range(start, end + 1, step):
                if not _add_value(value):
                    return False
            return True

        for part in token.split(","):
            part = part.strip()
            if not part:
                return None
            if part == "*":
                for value in range(min_value, max_value + 1):
                    if not _add_value(value):
                        return None
                continue

            if part.startswith("*/"):
                try:
                    step = int(part[2:])
                except ValueError:
                    return None
                if not _add_range(min_value, max_value, step):
                    return None
                continue

            if "/" in part:
                base, step_raw = part.split("/", 1)
                try:
                    step = int(step_raw)
                except ValueError:
                    return None
                if "-" in base:
                    start_raw, end_raw = base.split("-", 1)
                    try:
                        start = int(start_raw)
                        end = int(end_raw)
                    except ValueError:
                        return None
                elif base == "*":
                    start, end = min_value, max_value
                else:
                    try:
                        start = int(base)
                    except ValueError:
                        return None
                    end = max_value
                if start > end:
                    return None
                if not _add_range(start, end, step):
                    return None
                continue

            if "-" in part:
                start_raw, end_raw = part.split("-", 1)
                try:
                    start = int(start_raw)
                    end = int(end_raw)
                except ValueError:
                    return None
                if start > end:
                    return None
                if not _add_range(start, end, 1):
                    return None
                continue

            try:
                single = int(part)
            except ValueError:
                return None
            if not _add_value(single):
                return None

        if not matcher.allowed:
            return None
        return matcher

    @classmethod
    def parse_cron_expression(
        cls, schedule: str
    ) -> tuple[CronFieldMatcher, CronFieldMatcher, CronFieldMatcher, CronFieldMatcher, CronFieldMatcher] | None:
        parts = schedule.strip().split()
        if len(parts) != 5:
            return None
        minute = cls._parse_cron_field(parts[0], min_value=0, max_value=59)
        hour = cls._parse_cron_field(parts[1], min_value=0, max_value=23)
        dom = cls._parse_cron_field(parts[2], min_value=1, max_value=31)
        month = cls._parse_cron_field(parts[3], min_value=1, max_value=12)
        dow = cls._parse_cron_field(parts[4], min_value=0, max_value=6, allow_7_as_0=True)
        if minute is None or hour is None or dom is None or month is None or dow is None:
            return None
        return (minute, hour, dom, month, dow)

    @staticmethod
    def _cron_matches_now(
        trigger: ScheduledTrigger,
        *,
        minute: int,
        hour: int,
        day_of_month: int,
        month: int,
        day_of_week: int,
    ) -> bool:
        if trigger.cron_matchers is None:
            return False
        m_minute, m_hour, m_dom, m_month, m_dow = trigger.cron_matchers
        return (
            m_minute.matches(minute)
            and m_hour.matches(hour)
            and m_dom.matches(day_of_month)
            and m_month.matches(month)
            and m_dow.matches(day_of_week)
        )

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
            if not raw_job.get("name"):
                raw_job = {**raw_job, "name": f"cron_job_{idx}"}
            if self.upsert_cron_job(raw_job):
                started += 1
        return started

    def upsert_cron_job(self, raw_job: dict[str, Any]) -> bool:
        schedule = str(raw_job.get("schedule") or raw_job.get("cron") or "").strip()
        interval = self.parse_schedule_to_interval_seconds(schedule) if schedule else None
        cron_matchers = None
        schedule_kind = "interval"
        if interval is None:
            cron_matchers = self.parse_cron_expression(schedule) if schedule else None
            if cron_matchers is None:
                return False
            schedule_kind = "cron"
        else:
            schedule_kind = "interval"
        if interval is None and cron_matchers is None:
            return False

        name = str(raw_job.get("name") or "").strip()
        if not name:
            return False
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
            schedule_kind=schedule_kind,
            cron_matchers=cron_matchers,
        )
        previous_task = self._cron_tasks.get(name)
        if previous_task:
            previous_task.cancel()
        task = asyncio.create_task(self._run_periodic(trigger))
        self._tasks.append(task)
        self._cron_jobs[name] = trigger
        self._cron_tasks[name] = task
        return True

    def list_cron_jobs(self) -> list[dict[str, Any]]:
        return [
            {
                "name": trigger.name,
                "event_type": trigger.event_type,
                "schedule": trigger.schedule,
                "source": trigger.source,
                "subject": trigger.subject,
                "payload": trigger.payload,
                "trigger_kind": trigger.trigger_kind,
                "schedule_kind": trigger.schedule_kind,
            }
            for trigger in sorted(self._cron_jobs.values(), key=lambda item: item.name)
        ]

    def remove_cron_job(self, name: str) -> bool:
        safe_name = (name or "").strip()
        if not safe_name:
            return False
        self._cron_jobs.pop(safe_name, None)
        task = self._cron_tasks.pop(safe_name, None)
        if task:
            task.cancel()
            return True
        return False

    async def stop(self) -> None:
        if not self._tasks:
            return
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        self._cron_jobs.clear()
        self._cron_tasks.clear()

    async def _run_periodic(self, trigger: ScheduledTrigger) -> None:
        if trigger.schedule_kind == "cron":
            await self._run_cron(trigger)
            return
        if trigger.interval_seconds <= 0:
            return
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
            if trigger.trigger_kind == "cron" and trigger.event_type != "cron.job.tick":
                generic_event = Event(
                    event_id=f"evt_trigger_{uuid4().hex}",
                    event_type="cron.job.tick",
                    source=trigger.source,
                    subject=trigger.subject,
                    payload={**event_payload, "original_event_type": trigger.event_type},
                    timestamp=now,
                    risk_hint="low",
                )
                await self._emit_event(generic_event)
            if trigger.trigger_kind == "cron" and self._is_one_shot(trigger):
                await self._handle_one_shot_completion(trigger)
                break
            next_due += trigger.interval_seconds

    async def _run_cron(self, trigger: ScheduledTrigger) -> None:
        last_minute_key: int | None = None
        while True:
            now = utc_now()
            minute_key = int(now.timestamp() // 60)
            day_of_week = (now.weekday() + 1) % 7
            should_fire = self._cron_matches_now(
                trigger,
                minute=now.minute,
                hour=now.hour,
                day_of_month=now.day,
                month=now.month,
                day_of_week=day_of_week,
            )
            if should_fire and minute_key != last_minute_key:
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
                if trigger.event_type != "cron.job.tick":
                    generic_event = Event(
                        event_id=f"evt_trigger_{uuid4().hex}",
                        event_type="cron.job.tick",
                        source=trigger.source,
                        subject=trigger.subject,
                        payload={**event_payload, "original_event_type": trigger.event_type},
                        timestamp=now,
                        risk_hint="low",
                    )
                    await self._emit_event(generic_event)
                if self._is_one_shot(trigger):
                    await self._handle_one_shot_completion(trigger)
                    break
                last_minute_key = minute_key
            await asyncio.sleep(1.0)
