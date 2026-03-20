"""Rule matching, governance decisioning, and action execution."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from uuid import uuid4

from src.events.approval_manager import ApprovalManager
from src.events.attention_budget import AttentionBudget
from src.events.event_router import EventRouter
from src.events.event_store import DuplicateEventError, EventStore
from src.events.models import Event, EventRule, RuleDecision, RuleRun
from src.events.rule_evaluator import RuleEvaluator

ALLOWED_DECISIONS = {"skip", "ask", "suggest", "auto"}


@dataclass
class RuleExecutionResult:
    """Runtime status for one rule execution against one event."""

    run_id: str
    rule_id: str
    event_id: str
    decision: str
    status: str
    reason: str
    approval_id: str | None = None
    errors: list[str] = field(default_factory=list)


class RulesEngine:
    """Evaluate rules and route actions for incoming events."""

    def __init__(
        self,
        *,
        store: EventStore,
        evaluator: RuleEvaluator,
        router: EventRouter,
        approval_manager: ApprovalManager | None = None,
        attention_budget: AttentionBudget | None = None,
        rules: list[EventRule] | None = None,
    ):
        self.store = store
        self.evaluator = evaluator
        self.router = router
        self.approval_manager = approval_manager
        self.attention_budget = attention_budget or AttentionBudget()
        self._rules: list[EventRule] = []
        if rules:
            self.set_rules(rules)

    def set_rules(self, rules: list[EventRule]) -> None:
        """Replace ruleset."""
        self._rules = list(rules)

    def add_rule(self, rule: EventRule) -> None:
        """Append one rule."""
        self._rules.append(rule)

    def list_rules(self) -> list[EventRule]:
        """Return active rules sorted by priority desc."""
        return sorted(
            [rule for rule in self._rules if rule.is_active],
            key=lambda rule: rule.priority,
            reverse=True,
        )

    def match_rules(self, event: Event) -> list[EventRule]:
        """Match active rules by event_type."""
        matches = [
            rule
            for rule in self.list_rules()
            if rule.event_type == event.event_type or rule.event_type == "*"
        ]
        return matches

    def decide(self, rule: EventRule, event: Event) -> RuleDecision:
        """Compute final decision (skip/ask/suggest/auto)."""
        if not self.evaluator.evaluate(rule.conditions, event):
            return RuleDecision(decision="skip", reason="condition_not_met", rule_id=rule.id)

        if self.store.has_rule_event_run(rule.id, event.event_id):
            return RuleDecision(decision="skip", reason="rule_event_already_processed", rule_id=rule.id)

        if (
            rule.dedupe_window_seconds > 0
            and event.subject
            and self.store.has_recent_rule_subject_run(rule.id, event.subject, rule.dedupe_window_seconds)
        ):
            return RuleDecision(decision="skip", reason="dedupe_window_hit", rule_id=rule.id)

        if rule.cooldown_seconds > 0:
            last_run_at = self.store.get_last_rule_run_at(rule.id)
            if last_run_at is not None:
                elapsed = time.time() - last_run_at.timestamp()
                if elapsed < rule.cooldown_seconds:
                    return RuleDecision(
                        decision="skip",
                        reason=f"cooldown_active:{int(rule.cooldown_seconds - elapsed)}s",
                        rule_id=rule.id,
                    )

        scope = f"{rule.id}:{event.subject or '_'}"
        if rule.attention_budget_per_day > 0 and not self.attention_budget.allow(
            scope,
            rule.attention_budget_per_day,
        ):
            return RuleDecision(decision="skip", reason="attention_budget_exceeded", rule_id=rule.id)

        decision = rule.action_mode if rule.action_mode in ALLOWED_DECISIONS else "suggest"
        reason = "rule_match"
        if rule.risk_level == "high" and decision == "auto":
            decision = "ask"
            reason = "high_risk_requires_approval"
        # Prevent recursive approval loops caused by approval.* events requiring ask again.
        if event.event_type.startswith("approval.") and decision == "ask":
            decision = "suggest"
            reason = "approval_event_cannot_require_approval_again"

        return RuleDecision(decision=decision, reason=reason, rule_id=rule.id)

    async def handle_event(self, event: Event, *, persist_event: bool = True) -> list[RuleExecutionResult]:
        """Process one event end-to-end."""
        if persist_event:
            if event.idempotency_key and self.store.exists_idempotency(event.idempotency_key):
                return []
            try:
                self.store.append(event)
            except DuplicateEventError:
                return []

        outcomes: list[RuleExecutionResult] = []
        for rule in self.match_rules(event):
            started = time.time()
            decision = self.decide(rule, event)
            run_id = f"run_{uuid4().hex}"

            run = RuleRun(
                run_id=run_id,
                rule_id=rule.id,
                event_id=event.event_id,
                decision=decision.decision,
                reason=decision.reason,
                status="running",
            )
            self.store.insert_rule_run(run)

            if decision.decision == "skip":
                self.store.update_rule_run(run_id, status="skipped", reason=decision.reason, duration_ms=0)
                outcomes.append(
                    RuleExecutionResult(
                        run_id=run_id,
                        rule_id=rule.id,
                        event_id=event.event_id,
                        decision=decision.decision,
                        status="skipped",
                        reason=decision.reason,
                    )
                )
                continue

            approval_id: str | None = None
            if decision.decision == "ask" and self.approval_manager:
                approval = await self.approval_manager.request(
                    rule_id=rule.id,
                    event_id=event.event_id,
                    risk_level=rule.risk_level,
                )
                approval_id = approval.approval_id

            route_report = await self.router.route(decision, event, rule)
            duration_ms = int((time.time() - started) * 1000)

            status = "completed"
            if decision.decision == "ask" and approval_id:
                status = "awaiting_approval"
            elif route_report.failed > 0 and route_report.executed > 0:
                status = "partial"
            elif route_report.failed > 0:
                status = "failed"

            reason = decision.reason
            if route_report.errors:
                reason = f"{reason};errors={len(route_report.errors)}"

            self.store.update_rule_run(
                run_id,
                status=status,
                reason=reason,
                duration_ms=duration_ms,
                action_trace_id=route_report.trace_id,
            )

            outcomes.append(
                RuleExecutionResult(
                    run_id=run_id,
                    rule_id=rule.id,
                    event_id=event.event_id,
                    decision=decision.decision,
                    status=status,
                    reason=reason,
                    approval_id=approval_id,
                    errors=route_report.errors,
                )
            )

        return outcomes
