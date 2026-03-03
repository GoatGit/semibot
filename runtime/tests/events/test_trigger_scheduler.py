"""Tests for periodic trigger scheduler integration."""

import asyncio
from pathlib import Path

import pytest

from src.events.event_engine import EventEngine
from src.events.event_store import EventStore
from src.events.trigger_scheduler import TriggerScheduler


def test_parse_schedule_to_interval_seconds():
    assert TriggerScheduler.parse_schedule_to_interval_seconds("@every:2.5") == 2.5
    assert TriggerScheduler.parse_schedule_to_interval_seconds("*/3 * * * *") == 180.0
    assert TriggerScheduler.parse_schedule_to_interval_seconds("invalid") is None


def test_parse_cron_expression():
    assert TriggerScheduler.parse_cron_expression("0 9 * * 1-5") is not None
    assert TriggerScheduler.parse_cron_expression("*/15 8-18 * * 1,2,3,4,5") is not None
    assert TriggerScheduler.parse_cron_expression("61 * * * *") is None
    assert TriggerScheduler.parse_cron_expression("bad cron") is None


@pytest.mark.asyncio
async def test_event_engine_heartbeat_trigger_emits_events(tmp_path: Path):
    store = EventStore(db_path=str(tmp_path / "events.db"))
    engine = EventEngine(store=store, rules=[])
    started = engine.start_heartbeat(interval_seconds=0.02, payload={"node": "local"})
    assert started is True

    try:
        await asyncio.sleep(0.08)
    finally:
        await engine.stop_triggers()

    rows = store.list_events(limit=20, event_type="health.heartbeat.tick")
    assert len(rows) >= 2
    assert rows[0].payload["trigger_kind"] == "heartbeat"
    assert rows[0].payload["node"] == "local"


@pytest.mark.asyncio
async def test_event_engine_cron_jobs_emit_events(tmp_path: Path):
    store = EventStore(db_path=str(tmp_path / "events.db"))
    engine = EventEngine(store=store, rules=[])
    started = engine.start_cron_jobs(
        [
            {
                "name": "alpha",
                "schedule": "@every:0.02",
                "event_type": "cron.alpha.tick",
                "payload": {"x": 1},
            },
            {"name": "skip", "schedule": "invalid"},
        ]
    )
    assert started == 1

    try:
        await asyncio.sleep(0.08)
    finally:
        await engine.stop_triggers()

    rows = store.list_events(limit=20, event_type="cron.alpha.tick")
    assert len(rows) >= 2
    assert rows[0].payload["trigger_name"] == "alpha"
    assert rows[0].payload["x"] == 1

    generic_rows = store.list_events(limit=20, event_type="cron.job.tick")
    assert len(generic_rows) >= 2
    assert generic_rows[0].payload["trigger_name"] == "alpha"
    assert generic_rows[0].payload["original_event_type"] == "cron.alpha.tick"


@pytest.mark.asyncio
async def test_event_engine_can_upsert_list_and_remove_cron_job(tmp_path: Path):
    store = EventStore(db_path=str(tmp_path / "events.db"))
    engine = EventEngine(store=store, rules=[])

    accepted = engine.upsert_cron_job(
        {
            "name": "digest",
            "schedule": "@every:0.02",
            "event_type": "cron.job.tick",
            "payload": {"topic": "news"},
        }
    )
    assert accepted is True
    jobs = engine.list_cron_jobs()
    assert len(jobs) == 1
    assert jobs[0]["name"] == "digest"
    assert jobs[0]["schedule"] == "@every:0.02"

    # Upsert with same name should replace schedule in memory.
    accepted = engine.upsert_cron_job(
        {
            "name": "digest",
            "schedule": "@every:0.03",
            "event_type": "cron.job.tick",
        }
    )
    assert accepted is True
    jobs = engine.list_cron_jobs()
    assert len(jobs) == 1
    assert jobs[0]["schedule"] == "@every:0.03"

    removed = engine.remove_cron_job("digest")
    assert removed is True
    assert engine.list_cron_jobs() == []
    await engine.stop_triggers()


@pytest.mark.asyncio
async def test_event_engine_one_shot_cron_job_fires_once_and_auto_removes(tmp_path: Path):
    store = EventStore(db_path=str(tmp_path / "events.db"))
    completed: list[str] = []

    async def _on_completed(name: str, payload: dict[str, object]) -> None:
        completed.append(name)

    engine = EventEngine(store=store, rules=[], on_cron_completed=_on_completed)
    accepted = engine.upsert_cron_job(
        {
            "name": "oneshot_3m",
            "schedule": "@every:0.02",
            "event_type": "cron.job.tick",
            "payload": {"trigger_name": "oneshot_3m", "one_shot": True},
        }
    )
    assert accepted is True
    try:
        await asyncio.sleep(0.09)
    finally:
        await engine.stop_triggers()

    rows = store.list_events(limit=20, event_type="cron.job.tick")
    fired = [row for row in rows if row.payload.get("trigger_name") == "oneshot_3m"]
    assert len(fired) == 1
    assert completed == ["oneshot_3m"]
