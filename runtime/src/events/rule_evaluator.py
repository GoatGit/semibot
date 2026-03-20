"""Structured condition evaluator for event rules."""

from __future__ import annotations

from typing import Any

from src.events.models import Event


class RuleEvaluator:
    """Evaluate JSON-like rule conditions against an event."""

    def evaluate(self, condition: dict[str, Any], event: Event) -> bool:
        if not condition:
            return True
        if "all" in condition:
            return all(self.evaluate(item, event) for item in condition["all"])
        if "any" in condition:
            return any(self.evaluate(item, event) for item in condition["any"])
        if "not" in condition:
            return not self.evaluate(condition["not"], event)
        return self._evaluate_leaf(condition, event)

    def _evaluate_leaf(self, condition: dict[str, Any], event: Event) -> bool:
        field = str(condition.get("field", "")).strip()
        op = str(condition.get("op", "")).strip()
        value = condition.get("value")
        left = self._resolve_field(event, field)

        if op == "==":
            return left == value
        if op == "!=":
            return left != value
        if op == ">":
            return self._cmp(left, value, lambda a, b: a > b)
        if op == ">=":
            return self._cmp(left, value, lambda a, b: a >= b)
        if op == "<":
            return self._cmp(left, value, lambda a, b: a < b)
        if op == "<=":
            return self._cmp(left, value, lambda a, b: a <= b)
        if op == "in":
            return self._in(left, value)
        if op == "not_in":
            return not self._in(left, value)
        if op == "contains":
            return self._contains(left, value)
        if op == "not_contains":
            return not self._contains(left, value)
        if op == "exists":
            exists = left is not None
            return exists if bool(value) else not exists
        return False

    def _resolve_field(self, event: Event, field: str) -> Any:
        if field == "event_type":
            return event.event_type
        if field == "source":
            return event.source
        if field == "subject":
            return event.subject
        if field == "risk_hint":
            return event.risk_hint
        if field.startswith("payload."):
            current: Any = event.payload
            for part in field.removeprefix("payload.").split("."):
                if not isinstance(current, dict) or part not in current:
                    return None
                current = current[part]
            return current
        return None

    def _cmp(self, left: Any, right: Any, pred: Any) -> bool:
        try:
            return bool(pred(left, right))
        except Exception:
            return False

    def _in(self, left: Any, right: Any) -> bool:
        if isinstance(right, list):
            return left in right
        return False

    def _contains(self, left: Any, right: Any) -> bool:
        if isinstance(left, str) and isinstance(right, str):
            return right in left
        if isinstance(left, list):
            return right in left
        return False

