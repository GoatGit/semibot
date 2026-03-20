"""Tests for structured rule conditions."""

from src.events.models import Event
from src.events.rule_evaluator import RuleEvaluator


def test_evaluator_handles_nested_payload_fields():
    evaluator = RuleEvaluator()
    event = Event(
        event_id="evt_1",
        event_type="chat.message.received",
        source="feishu",
        subject="group_1",
        payload={"message": {"text": "hello world"}, "priority": 3},
    )

    condition = {
        "all": [
            {"field": "payload.message.text", "op": "contains", "value": "hello"},
            {"field": "payload.priority", "op": ">=", "value": 2},
            {"field": "event_type", "op": "==", "value": "chat.message.received"},
        ]
    }
    assert evaluator.evaluate(condition, event) is True


def test_evaluator_handles_any_and_not():
    evaluator = RuleEvaluator()
    event = Event(
        event_id="evt_2",
        event_type="task.created",
        source="manual",
        subject=None,
        payload={"owner": "analyst", "tags": ["urgent", "review"]},
    )

    condition = {
        "all": [
            {
                "any": [
                    {"field": "payload.owner", "op": "==", "value": "manager"},
                    {"field": "payload.owner", "op": "==", "value": "analyst"},
                ]
            },
            {"not": {"field": "payload.tags", "op": "contains", "value": "blocked"}},
        ]
    }
    assert evaluator.evaluate(condition, event) is True
