"""Tests for SQLite-backed EventStore."""

from pathlib import Path

import pytest

from src.events.event_store import DuplicateEventError, EventStore
from src.events.models import ApprovalRequest, Event, RuleRun


@pytest.fixture
def store(tmp_path: Path) -> EventStore:
    return EventStore(db_path=str(tmp_path / "events.db"))


def test_append_and_get_event(store: EventStore):
    event = Event(
        event_id="evt_1",
        event_type="agent.lifecycle.pre_execute",
        source="runtime.base_agent",
        subject="agent_1",
        payload={"session_id": "s_1"},
        idempotency_key="k_1",
    )
    store.append(event)

    loaded = store.get("evt_1")
    assert loaded is not None
    assert loaded.event_type == event.event_type
    assert loaded.payload["session_id"] == "s_1"
    assert store.exists_idempotency("k_1") is True


def test_idempotency_raises_duplicate_error(store: EventStore):
    store.append(
        Event(
            event_id="evt_1",
            event_type="task.created",
            source="test",
            subject=None,
            payload={},
            idempotency_key="dup_key",
        )
    )

    with pytest.raises(DuplicateEventError):
        store.append(
            Event(
                event_id="evt_2",
                event_type="task.created",
                source="test",
                subject=None,
                payload={},
                idempotency_key="dup_key",
            )
        )


def test_rule_run_and_approval_persistence(store: EventStore):
    store.append(
        Event(
            event_id="evt_rule",
            event_type="task.created",
            source="test",
            subject="thread_1",
            payload={},
        )
    )
    store.insert_rule_run(
        RuleRun(
            run_id="run_1",
            rule_id="rule_1",
            event_id="evt_rule",
            decision="ask",
            reason="high_risk_requires_approval",
            status="awaiting_approval",
        )
    )
    store.update_rule_run("run_1", status="completed", reason="approved", duration_ms=10)
    assert store.has_rule_event_run("rule_1", "evt_rule") is True

    approval = ApprovalRequest(
        approval_id="appr_1",
        rule_id="rule_1",
        event_id="evt_rule",
        risk_level="high",
        context={"summary": "测试审批"},
    )
    store.insert_approval(approval)
    pending = store.list_pending_approvals()
    assert len(pending) == 1
    assert pending[0].approval_id == "appr_1"

    store.update_approval("appr_1", "approved")
    loaded = store.get_approval("appr_1")
    assert loaded is not None
    assert loaded.status == "approved"
    assert loaded.context == {"summary": "测试审批"}
    assert loaded.resolved_at is not None


def test_metrics_snapshot(store: EventStore):
    store.append(
        Event(
            event_id="evt_m1",
            event_type="tool.exec.failed",
            source="test",
            subject="s1",
            payload={},
        )
    )
    store.insert_rule_run(
        RuleRun(
            run_id="run_m1",
            rule_id="rule_m1",
            event_id="evt_m1",
            decision="suggest",
            reason="rule_match",
            status="completed",
            duration_ms=12,
        )
    )
    store.insert_approval(
        ApprovalRequest(
            approval_id="appr_m1",
            rule_id="rule_m1",
            event_id="evt_m1",
            risk_level="high",
            status="pending",
        )
    )
    metrics = store.get_metrics()
    assert metrics["events_total"] == 1
    assert metrics["rule_runs_total"] == 1
    assert metrics["approvals_total"] == 1
    assert metrics["rule_runs_completed"] == 1
    assert metrics["approvals_pending"] == 1


def test_list_events_after_supports_event_types_filter(store: EventStore):
    store.append(
        Event(
            event_id="evt_filter_1",
            event_type="alpha",
            source="test",
            subject=None,
            payload={},
        )
    )
    store.append(
        Event(
            event_id="evt_filter_2",
            event_type="beta",
            source="test",
            subject=None,
            payload={},
        )
    )
    rows = store.list_events_after(event_types=["beta"], limit=10)
    assert len(rows) == 1
    assert rows[0].event_type == "beta"


def test_list_events_supports_capability_filter(store: EventStore):
    store.append(
        Event(
            event_id="evt_capability_1",
            event_type="tool.exec.started",
            source="test",
            subject=None,
            payload={"capability_id": "mcp:browser.open_url"},
        )
    )
    store.append(
        Event(
            event_id="evt_capability_2",
            event_type="tool.exec.started",
            source="test",
            subject=None,
            payload={"capability_id": "tool:bash.exec"},
        )
    )

    rows = store.list_events(limit=10, capability_id="browser")
    assert len(rows) == 1
    assert rows[0].event_id == "evt_capability_1"


def test_list_approvals_supports_capability_filter(store: EventStore):
    store.insert_approval(
        ApprovalRequest(
            approval_id="appr_capability_1",
            rule_id="rule_1",
            event_id="evt_1",
            risk_level="high",
            context={"capability_id": "mcp:browser.open_url"},
        )
    )
    store.insert_approval(
        ApprovalRequest(
            approval_id="appr_capability_2",
            rule_id="rule_2",
            event_id="evt_2",
            risk_level="high",
            context={"capability_id": "tool:bash.exec"},
        )
    )

    rows = store.list_approvals(limit=10, capability_id="browser")
    assert len(rows) == 1
    assert rows[0].approval_id == "appr_capability_1"


def _make_llm_usage_event(event_id: str, session_id: str, node: str, model: str, prompt: int, completion: int) -> Event:
    return Event(
        event_id=event_id,
        event_type="llm.usage",
        source="orchestrator",
        subject=session_id,
        payload={
            "session_id": session_id,
            "agent_id": "agent_1",
            "node": node,
            "model": model,
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "total_tokens": prompt + completion,
            "duration_ms": 500,
        },
    )


def test_aggregate_token_usage_totals(store: EventStore):
    store.append(_make_llm_usage_event("u1", "s1", "plan", "claude-3", 100, 50))
    store.append(_make_llm_usage_event("u2", "s1", "act", "claude-3", 200, 80))
    store.append(_make_llm_usage_event("u3", "s2", "plan", "gpt-4", 150, 60))

    result = store.aggregate_token_usage()
    totals = result["totals"]
    assert totals["call_count"] == 3
    assert totals["prompt_tokens"] == 450
    assert totals["completion_tokens"] == 190
    assert totals["total_tokens"] == 640
    assert result["breakdown"] == []
    assert isinstance(result["trend"], list)


def test_aggregate_token_usage_group_by_node(store: EventStore):
    store.append(_make_llm_usage_event("u1", "s1", "plan", "claude-3", 100, 50))
    store.append(_make_llm_usage_event("u2", "s1", "act", "claude-3", 200, 80))
    store.append(_make_llm_usage_event("u3", "s2", "plan", "gpt-4", 150, 60))

    result = store.aggregate_token_usage(group_by="node")
    breakdown = {item["key"]: item for item in result["breakdown"]}
    assert "plan" in breakdown
    assert "act" in breakdown
    assert breakdown["plan"]["call_count"] == 2
    assert breakdown["plan"]["prompt_tokens"] == 250
    assert breakdown["act"]["total_tokens"] == 280


def test_aggregate_token_usage_group_by_model(store: EventStore):
    store.append(_make_llm_usage_event("u1", "s1", "plan", "claude-3", 100, 50))
    store.append(_make_llm_usage_event("u2", "s1", "act", "gpt-4", 200, 80))

    result = store.aggregate_token_usage(group_by="model")
    breakdown = {item["key"]: item for item in result["breakdown"]}
    assert "claude-3" in breakdown
    assert "gpt-4" in breakdown


def test_aggregate_token_usage_empty(store: EventStore):
    result = store.aggregate_token_usage()
    assert result["totals"]["call_count"] == 0
    assert result["totals"]["total_tokens"] == 0
    assert result["breakdown"] == []
    assert result["trend"] == []
