"""Tests for approval event lifecycle in EventEngine."""

import json
from pathlib import Path

import pytest

from src.events.event_engine import EventEngine
from src.events.event_store import EventStore
from src.events.models import Event


@pytest.mark.asyncio
async def test_approval_request_and_resolve_emit_events(tmp_path: Path):
    rules_path = tmp_path / "rules.json"
    rules_path.write_text(
        json.dumps(
            [
                {
                    "id": "rule_high_risk",
                    "name": "rule_high_risk",
                    "event_type": "fund.transfer",
                    "action_mode": "auto",
                    "risk_level": "high",
                    "actions": [{"action_type": "notify"}],
                    "is_active": True,
                }
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    engine = EventEngine(
        store=EventStore(db_path=str(tmp_path / "events.db")),
        rules_path=str(rules_path),
    )

    await engine.emit(
        Event(
            event_id="evt_risk_1",
            event_type="fund.transfer",
            source="test",
            subject="acct_1",
            payload={"amount": 1000},
        )
    )

    pending = engine.list_pending_approvals()
    assert len(pending) == 1
    approval_id = pending[0].approval_id

    # request emission should produce approval.requested event.
    event_types = {item.event_type for item in engine.list_events(limit=20)}
    assert "approval.requested" in event_types

    approval = await engine.resolve_approval(approval_id, "approved")
    assert approval is not None
    assert approval.status == "approved"

    event_types = {item.event_type for item in engine.list_events(limit=50)}
    assert "approval.approved" in event_types
