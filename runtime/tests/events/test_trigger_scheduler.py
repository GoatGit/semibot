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
