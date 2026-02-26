"""Semibot event engine package."""

__all__ = [
    "ApprovalManager",
    "AttentionBudget",
    "ApprovalRequest",
    "DuplicateEventError",
    "Event",
    "EventBus",
    "EventEngine",
    "EventRouter",
    "EventRule",
    "EventStore",
    "NoopActionExecutor",
    "OrchestratorBridge",
    "ReplayManager",
    "RouteReport",
    "RuleAction",
    "RuleLoader",
    "RuleDecision",
    "RuleEvaluator",
    "RuleExecutionResult",
    "RuleRun",
    "RulesEngine",
    "RuntimeActionExecutor",
    "RuntimeEventEmitter",
    "TriggerScheduler",
    "ensure_default_rules",
    "emit_runtime_event",
    "list_rule_files",
    "load_rules",
    "set_rule_active",
]


def __getattr__(name: str):
    if name in {"ApprovalRequest", "Event", "EventRule", "RuleAction", "RuleDecision", "RuleRun"}:
        from src.events.models import (
            ApprovalRequest,
            Event,
            EventRule,
            RuleAction,
            RuleDecision,
            RuleRun,
        )

        return {
            "ApprovalRequest": ApprovalRequest,
            "Event": Event,
            "EventRule": EventRule,
            "RuleAction": RuleAction,
            "RuleDecision": RuleDecision,
            "RuleRun": RuleRun,
        }[name]

    if name in {"EventStore", "DuplicateEventError"}:
        from src.events.event_store import DuplicateEventError, EventStore

        return {"EventStore": EventStore, "DuplicateEventError": DuplicateEventError}[name]

    if name in {"EventRouter", "NoopActionExecutor", "RouteReport"}:
        from src.events.event_router import EventRouter, NoopActionExecutor, RouteReport

        return {
            "EventRouter": EventRouter,
            "NoopActionExecutor": NoopActionExecutor,
            "RouteReport": RouteReport,
        }[name]

    if name == "EventBus":
        from src.events.event_bus import EventBus

        return EventBus

    if name == "RuleEvaluator":
        from src.events.rule_evaluator import RuleEvaluator

        return RuleEvaluator

    if name in {"RuleLoader", "load_rules", "set_rule_active", "ensure_default_rules", "list_rule_files"}:
        from src.events.rule_loader import (
            ensure_default_rules,
            list_rule_files,
            load_rules,
            set_rule_active,
        )

        if name == "RuleLoader":
            # Backward-compatible symbolic alias.
            return load_rules
        return {
            "load_rules": load_rules,
            "set_rule_active": set_rule_active,
            "ensure_default_rules": ensure_default_rules,
            "list_rule_files": list_rule_files,
        }[name]

    if name in {"RulesEngine", "RuleExecutionResult"}:
        from src.events.rules_engine import RuleExecutionResult, RulesEngine

        return {"RulesEngine": RulesEngine, "RuleExecutionResult": RuleExecutionResult}[name]

    if name == "OrchestratorBridge":
        from src.events.orchestrator_bridge import OrchestratorBridge

        return OrchestratorBridge

    if name == "ApprovalManager":
        from src.events.approval_manager import ApprovalManager

        return ApprovalManager

    if name == "AttentionBudget":
        from src.events.attention_budget import AttentionBudget

        return AttentionBudget

    if name == "ReplayManager":
        from src.events.replay_manager import ReplayManager

        return ReplayManager

    if name == "EventEngine":
        from src.events.event_engine import EventEngine

        return EventEngine

    if name == "RuntimeActionExecutor":
        from src.events.runtime_action_executor import RuntimeActionExecutor

        return RuntimeActionExecutor

    if name == "TriggerScheduler":
        from src.events.trigger_scheduler import TriggerScheduler

        return TriggerScheduler

    if name in {"RuntimeEventEmitter", "emit_runtime_event"}:
        from src.events.runtime_emitter import RuntimeEventEmitter, emit_runtime_event

        return {
            "RuntimeEventEmitter": RuntimeEventEmitter,
            "emit_runtime_event": emit_runtime_event,
        }[name]

    raise AttributeError(name)
