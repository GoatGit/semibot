"""Tests for rules engine decision and routing."""

from pathlib import Path

import pytest

from src.events.approval_manager import ApprovalManager
from src.events.event_router import EventRouter
from src.events.event_store import EventStore
from src.events.models import Event, EventRule, RuleAction
from src.events.rule_evaluator import RuleEvaluator
from src.events.rules_engine import RulesEngine


class RecordingExecutor:
    """Capture action calls for assertions."""

    def __init__(self):
        self.calls: list[tuple[str, dict]] = []

    async def notify(self, payload: dict) -> None:
        self.calls.append(("notify", payload))

    async def run_agent(self, payload: dict) -> None:
        self.calls.append(("run_agent", payload))

    async def execute_plan(self, payload: dict) -> None:
        self.calls.append(("execute_plan", payload))

    async def call_webhook(self, payload: dict) -> None:
        self.calls.append(("call_webhook", payload))

    async def log_only(self, payload: dict) -> None:
        self.calls.append(("log_only", payload))


@pytest.fixture
def store(tmp_path: Path) -> EventStore:
    return EventStore(db_path=str(tmp_path / "events.db"))


@pytest.mark.asyncio
async def test_auto_rule_executes_actions(store: EventStore):
    executor = RecordingExecutor()
    engine = RulesEngine(
        store=store,
        evaluator=RuleEvaluator(),
        router=EventRouter(executor),
        approval_manager=ApprovalManager(store),
        rules=[
            EventRule(
                id="rule_auto",
                name="auto-run",
                event_type="task.created",
                action_mode="auto",
                risk_level="low",
                actions=[RuleAction(action_type="notify"), RuleAction(action_type="run_agent")],
            )
        ],
    )

    outcomes = await engine.handle_event(
        Event(
            event_id="evt_1",
            event_type="task.created",
            source="test",
            subject="s_1",
            payload={},
        )
    )
    assert len(outcomes) == 1
    assert outcomes[0].decision == "auto"
    assert outcomes[0].status == "completed"
    assert [call[0] for call in executor.calls] == ["notify", "run_agent"]


@pytest.mark.asyncio
async def test_high_risk_auto_downgrades_to_ask(store: EventStore):
    executor = RecordingExecutor()
    approval_manager = ApprovalManager(store)
    engine = RulesEngine(
        store=store,
        evaluator=RuleEvaluator(),
        router=EventRouter(executor),
        approval_manager=approval_manager,
        rules=[
            EventRule(
                id="rule_high",
                name="high-risk",
                event_type="fund.transfer",
                action_mode="auto",
                risk_level="high",
                actions=[RuleAction(action_type="run_agent"), RuleAction(action_type="notify")],
            )
        ],
    )

    outcomes = await engine.handle_event(
        Event(
            event_id="evt_2",
            event_type="fund.transfer",
            source="test",
            subject="acct_1",
            payload={"amount": 10000},
        )
    )
    assert len(outcomes) == 1
    assert outcomes[0].decision == "ask"
    assert outcomes[0].status == "awaiting_approval"
    assert outcomes[0].approval_id is not None
    assert [call[0] for call in executor.calls] == ["notify"]
    assert len(approval_manager.list_pending()) == 1


@pytest.mark.asyncio
async def test_cooldown_skips_follow_up_event(store: EventStore):
    executor = RecordingExecutor()
    engine = RulesEngine(
        store=store,
        evaluator=RuleEvaluator(),
        router=EventRouter(executor),
        rules=[
            EventRule(
                id="rule_cooldown",
                name="cooldown",
                event_type="alert.triggered",
                action_mode="auto",
                risk_level="low",
                cooldown_seconds=3600,
                actions=[RuleAction(action_type="notify")],
            )
        ],
    )

    first = await engine.handle_event(
        Event(
            event_id="evt_3",
            event_type="alert.triggered",
            source="test",
            subject="machine_1",
            payload={},
        )
    )
    second = await engine.handle_event(
        Event(
            event_id="evt_4",
            event_type="alert.triggered",
            source="test",
            subject="machine_1",
            payload={},
        )
    )

    assert first[0].status == "completed"
    assert second[0].status == "skipped"
    assert "cooldown_active" in second[0].reason


@pytest.mark.asyncio
async def test_approval_event_never_requires_approval_again(store: EventStore):
    executor = RecordingExecutor()
    approval_manager = ApprovalManager(store)
    engine = RulesEngine(
        store=store,
        evaluator=RuleEvaluator(),
        router=EventRouter(executor),
        approval_manager=approval_manager,
        rules=[
            EventRule(
                id="rule_approval_guard",
                name="approval-guard",
                event_type="approval.requested",
                action_mode="auto",
                risk_level="high",
                actions=[RuleAction(action_type="notify")],
            )
        ],
    )

    outcomes = await engine.handle_event(
        Event(
            event_id="evt_appr_req",
            event_type="approval.requested",
            source="test",
            subject="appr_1",
            payload={"approval_id": "appr_1"},
        )
    )
    assert len(outcomes) == 1
    assert outcomes[0].decision == "suggest"
    assert outcomes[0].status == "completed"
