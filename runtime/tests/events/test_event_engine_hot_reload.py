"""Tests for automatic rule hot reload."""

import asyncio
import json
from pathlib import Path

import pytest

from src.events.event_engine import EventEngine
from src.events.event_store import EventStore
from src.events.models import Event


@pytest.mark.asyncio
async def test_event_engine_reload_rules_if_changed(tmp_path: Path):
    rules_file = tmp_path / "rules.json"
    rules_file.write_text(
        json.dumps(
            [
                {
                    "id": "rule_a",
                    "name": "rule_a",
                    "event_type": "event.a",
                    "action_mode": "suggest",
                    "actions": [{"action_type": "log_only"}],
                    "is_active": True,
                }
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    engine = EventEngine(
        store=EventStore(db_path=str(tmp_path / "events.db")),
        rules_path=str(rules_file),
    )
    outcomes = await engine.emit(
        Event(
            event_id="evt_a_1",
            event_type="event.a",
            source="test",
            subject=None,
            payload={},
        )
    )
    assert len(outcomes) == 1

    await asyncio.sleep(0.01)
    rules_file.write_text(
        json.dumps(
            [
                {
                    "id": "rule_b",
                    "name": "rule_b",
                    "event_type": "event.b",
                    "action_mode": "suggest",
                    "actions": [{"action_type": "log_only"}],
                    "is_active": True,
                }
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    outcomes = await engine.emit(
        Event(
            event_id="evt_b_1",
            event_type="event.b",
            source="test",
            subject=None,
            payload={},
        )
    )
    assert len(outcomes) == 1


@pytest.mark.asyncio
async def test_event_engine_watch_loop_reloads_without_emit(tmp_path: Path):
    rules_file = tmp_path / "rules-watch.json"
    rules_file.write_text(
        json.dumps(
            [
                {
                    "id": "rule_old",
                    "name": "rule_old",
                    "event_type": "event.old",
                    "action_mode": "suggest",
                    "actions": [{"action_type": "log_only"}],
                    "is_active": True,
                }
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    engine = EventEngine(
        store=EventStore(db_path=str(tmp_path / "events-watch.db")),
        rules_path=str(rules_file),
    )
    engine.start_rule_watch(poll_interval=0.05)
    try:
        await asyncio.sleep(0.06)
        rules_file.write_text(
            json.dumps(
                [
                    {
                        "id": "rule_new",
                        "name": "rule_new",
                        "event_type": "event.new",
                        "action_mode": "suggest",
                        "actions": [{"action_type": "log_only"}],
                        "is_active": True,
                    }
                ],
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        await asyncio.sleep(0.12)
        ids = [rule.id for rule in engine.list_rules()]
        assert "rule_new" in ids
        assert "rule_old" not in ids
    finally:
        await engine.stop_rule_watch()
