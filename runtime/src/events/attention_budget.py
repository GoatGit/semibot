"""In-memory attention-budget and cooldown helpers."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone


@dataclass
class BudgetState:
    day: date
    count: int = 0


class AttentionBudget:
    """Track reminder budget with daily reset."""

    def __init__(self):
        self._states: dict[str, BudgetState] = {}

    def allow(self, scope: str, limit_per_day: int) -> bool:
        if limit_per_day <= 0:
            return True

        today = datetime.now(timezone.utc).date()
        state = self._states.get(scope)
        if state is None or state.day != today:
            state = BudgetState(day=today, count=0)
            self._states[scope] = state

        if state.count >= limit_per_day:
            return False

        state.count += 1
        return True
