"""Rule domain service for runtime CRUD/simulate flows."""

from __future__ import annotations

from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from src.events.models import Event, EventRule
from src.events.rule_evaluator import RuleEvaluator
from src.events.rule_loader import (
    create_rule,
    delete_rule,
    load_rules,
    rules_to_json,
    set_rule_active,
    update_rule,
)
from src.events.trigger_scheduler import TriggerScheduler
from src.server.config_store import RuntimeConfigStore

ALLOWED_ACTION_MODES = {"ask", "suggest", "auto", "skip"}
ALLOWED_RISK_LEVELS = {"low", "medium", "high"}
ALLOWED_RULE_ACTION_TYPES = {"notify", "run_agent", "execute_plan", "call_webhook", "log_only"}
ALLOWED_EVENT_TYPES = {
    "chat.message.received",
    "chat.card.action",
    "tool.exec.started",
    "tool.exec.completed",
    "tool.exec.failed",
    "approval.requested",
    "approval.approved",
    "approval.rejected",
    "approval.action",
    "session.deleted",
    "cron.job.tick",
    "task.completed",
    "task.failed",
    "task.cancelled",
    "health.heartbeat.tick",
    "health.heartbeat.manual",
    "rule.queue.accepted",
    "rule.queue.dropped",
    "rule.queue.telemetry",
    "rule.worker.started",
    "rule.worker.completed",
    "rule.worker.failed",
    "memory.write.manual",
    "memory.write.important",
    "agent.lifecycle.pre_execute",
    "agent.lifecycle.post_execute",
    "agent.lifecycle.failed",
    "sandbox_execution",
    "policy_violation",
}


class RuleServiceError(Exception):
    """Structured rule service error."""

    def __init__(self, code: str, message: str, status_code: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class RuleService:
    """Rule service for create/update/delete/enable/disable/simulate."""

    def __init__(self, *, rules_path: str | Path, db_path: str | None = None):
        self.rules_path = str(Path(rules_path).expanduser())
        self.evaluator = RuleEvaluator()
        self.config_store = RuntimeConfigStore(db_path=db_path or None)

    def list_rules(self) -> list[dict[str, Any]]:
        return rules_to_json(load_rules(self.rules_path))

    @staticmethod
    def _gateway_id_from_instance(item: dict[str, Any]) -> str | None:
        provider = str(item.get("provider") or "").strip().lower()
        config = item.get("config") if isinstance(item.get("config"), dict) else {}
        if provider == "telegram":
            token = str(config.get("botToken") or "").strip()
            bot_id = token.split(":", 1)[0].strip() if ":" in token else ""
            chat_id = str(config.get("defaultChatId") or "").strip()
            if bot_id and chat_id:
                return f"telegram:{bot_id}:{chat_id}"
            if bot_id:
                return f"telegram:{bot_id}"
            return None
        if provider == "feishu":
            app_id = str(
                config.get("appId")
                or config.get("app_id")
                or config.get("cli_aid")
                or ""
            ).strip()
            chat_id = str(config.get("defaultChatId") or config.get("default_chat_id") or "").strip()
            if app_id and chat_id:
                return f"feishu:{app_id}:{chat_id}"
            if app_id:
                return f"feishu:{app_id}"
            return None
        return None

    def _resolve_single_active_gateway_id(self) -> str | None:
        instances = [item for item in self.config_store.list_gateway_instances() if bool(item.get("is_active"))]
        if len(instances) != 1:
            return None
        return self._gateway_id_from_instance(instances[0])

    def _validate_actions(self, actions: Any, *, event_type: str | None = None) -> list[dict[str, Any]]:
        if not isinstance(actions, list) or not actions:
            raise RuleServiceError("INVALID_ACTION_PARAMS", "actions must be a non-empty array")
        normalized: list[dict[str, Any]] = []
        is_cron_rule = isinstance(event_type, str) and event_type.startswith("cron.")
        for item in actions:
            if not isinstance(item, dict):
                raise RuleServiceError("INVALID_ACTION_PARAMS", "actions item must be object")
            action_type = str(item.get("action_type") or item.get("actionType") or "").strip()
            if not action_type:
                raise RuleServiceError("INVALID_ACTION_PARAMS", "action_type is required")
            if action_type not in ALLOWED_RULE_ACTION_TYPES:
                raise RuleServiceError("INVALID_ACTION_PARAMS", f"unsupported action_type: {action_type}")
            params = item.get("params")
            params_map = params if isinstance(params, dict) else {}
            if "gatewayId" in params_map and "gateway_id" not in params_map:
                params_map = {**params_map, "gateway_id": params_map.get("gatewayId")}
            if is_cron_rule and action_type == "notify":
                gateway_id = str(params_map.get("gateway_id") or "").strip()
                if not gateway_id:
                    fallback_gateway_id = self._resolve_single_active_gateway_id()
                    if fallback_gateway_id:
                        params_map = {**params_map, "gateway_id": fallback_gateway_id}
                    else:
                        raise RuleServiceError(
                            "INVALID_NOTIFY_TARGET",
                            "cron notify action requires params.gateway_id",
                        )
            normalized.append(
                {
                    "action_type": action_type,
                    "target": item.get("target"),
                    "params": params_map,
                }
            )
        return normalized

    def _validate_core_rule_fields(self, payload: dict[str, Any], *, is_update: bool) -> dict[str, Any]:
        out = dict(payload)

        if not is_update or "event_type" in out:
            event_type = str(out.get("event_type") or out.get("eventType") or "").strip()
            if not event_type:
                raise RuleServiceError("INVALID_EVENT_TYPE", "event_type is required")
            if event_type not in ALLOWED_EVENT_TYPES and not event_type.startswith("cron.job."):
                raise RuleServiceError("INVALID_EVENT_TYPE", f"unsupported event_type: {event_type}")
            out["event_type"] = event_type

        if not is_update or "name" in out:
            name = str(out.get("name") or "").strip()
            if not name:
                raise RuleServiceError("INVALID_RULE_NAME", "name is required")
            if len(name) > 120:
                raise RuleServiceError("INVALID_RULE_NAME", "name too long")
            out["name"] = name

        if "action_mode" in out or "actionMode" in out or not is_update:
            action_mode = str(out.get("action_mode") or out.get("actionMode") or "").strip().lower()
            if action_mode not in ALLOWED_ACTION_MODES:
                raise RuleServiceError("INVALID_ACTION_MODE", "action_mode must be ask/suggest/auto/skip")
            out["action_mode"] = action_mode

        if "risk_level" in out or "riskLevel" in out or not is_update:
            risk_level = str(out.get("risk_level") or out.get("riskLevel") or "").strip().lower()
            if risk_level not in ALLOWED_RISK_LEVELS:
                raise RuleServiceError("INVALID_RISK_LEVEL", "risk_level must be low/medium/high")
            out["risk_level"] = risk_level

        if "actions" in out or not is_update:
            out["actions"] = self._validate_actions(out.get("actions"), event_type=out.get("event_type"))

        if "conditions" in out:
            if not isinstance(out.get("conditions"), dict):
                raise RuleServiceError("INVALID_CONDITIONS", "conditions must be object")
        elif not is_update:
            out["conditions"] = {"all": []}

        for field_name, min_value, max_value, code in (
            ("priority", 0, 1000, "INVALID_PRIORITY"),
            ("dedupe_window_seconds", 0, 86400, "INVALID_DEDUPE"),
            ("cooldown_seconds", 0, 86400, "INVALID_COOLDOWN"),
            ("attention_budget_per_day", 0, 10000, "INVALID_BUDGET"),
        ):
            if field_name not in out and is_update:
                continue
            if field_name not in out and not is_update:
                defaults = {
                    "priority": 50,
                    "dedupe_window_seconds": 300,
                    "cooldown_seconds": 600,
                    "attention_budget_per_day": 10,
                }
                out[field_name] = defaults[field_name]
            try:
                value = int(out.get(field_name))
            except Exception as exc:
                raise RuleServiceError(code, f"{field_name} must be integer") from exc
            if value < min_value or value > max_value:
                raise RuleServiceError(code, f"{field_name} out of range")
            out[field_name] = value

        if "is_active" in out:
            out["is_active"] = bool(out.get("is_active"))
        elif not is_update:
            out["is_active"] = True

        if (
            str(out.get("action_mode", "")).lower() == "auto"
            and str(out.get("risk_level", "")).lower() == "high"
            and not str(out.get("override_reason") or "").strip()
        ):
            raise RuleServiceError(
                "APPROVAL_REQUIRED",
                "auto + high risk requires override_reason and approval",
                status_code=403,
            )
        return out

    def _build_rule_id(self, name: str) -> str:
        return f"rule_{name.strip().lower().replace(' ', '_')}_{uuid4().hex[:8]}"

    def _upsert_cron_if_requested(self, payload: dict[str, Any], event_type: str) -> None:
        cron = payload.get("cron")
        if not isinstance(cron, dict):
            return
        if not bool(cron.get("upsert")):
            return
        name = str(cron.get("name") or "").strip()
        schedule = str(cron.get("schedule") or "").strip()
        if not name or not schedule:
            raise RuleServiceError("INVALID_CRON_SCHEDULE", "cron.name and cron.schedule are required")
        interval = TriggerScheduler.parse_schedule_to_interval_seconds(schedule)
        cron_expr = TriggerScheduler.parse_cron_expression(schedule)
        if interval is None and cron_expr is None:
            raise RuleServiceError("INVALID_CRON_SCHEDULE", "unsupported cron schedule")
        cron_payload = cron.get("payload") if isinstance(cron.get("payload"), dict) else {}
        raw_one_shot = cron.get("one_shot", cron.get("oneShot", None))
        if raw_one_shot is not None and "one_shot" not in cron_payload and "oneShot" not in cron_payload:
            cron_payload = {**cron_payload, "one_shot": bool(raw_one_shot)}
        self.config_store.upsert_cron_job(
            {
                "name": name,
                "schedule": schedule,
                "event_type": str(cron.get("event_type") or event_type or "cron.job.tick"),
                "source": str(cron.get("source") or "system.cron"),
                "subject": cron.get("subject", "system"),
                "payload": cron_payload,
                "is_active": True,
            }
        )

    def create_rule(self, payload: dict[str, Any]) -> dict[str, Any]:
        normalized = self._validate_core_rule_fields(payload, is_update=False)
        rule_id = str(normalized.get("id") or self._build_rule_id(normalized["name"]))
        normalized["id"] = rule_id
        self._upsert_cron_if_requested(payload, normalized["event_type"])
        if (
            normalized["event_type"].startswith("cron.")
            and isinstance(payload.get("cron"), dict)
            and bool(payload["cron"].get("upsert"))
        ):
            cron_name = str(payload["cron"].get("name") or "").strip()
            if cron_name:
                normalized["conditions"] = {
                    "all": [
                        {"field": "payload.trigger_name", "op": "==", "value": cron_name},
                    ]
                }
        try:
            created = create_rule(self.rules_path, normalized)
        except ValueError as exc:
            if "conflict" in str(exc):
                raise RuleServiceError("RULE_NAME_CONFLICT", "rule id or name already exists", 409) from exc
            raise RuleServiceError("RULE_CREATE_FAILED", str(exc)) from exc
        data = asdict(created)
        data["actions"] = [asdict(action) for action in created.actions]
        data["version"] = 1
        data["audit_event"] = "rule.authored"
        return data

    def update_rule(self, rule_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        safe_id = str(rule_id or "").strip()
        if not safe_id:
            raise RuleServiceError("RULE_NOT_FOUND", "rule_id is required", 404)
        normalized = self._validate_core_rule_fields(patch, is_update=True)
        if "actions" in normalized and "event_type" not in normalized:
            existing = next((rule for rule in load_rules(self.rules_path) if rule.id == safe_id), None)
            if existing is None:
                raise RuleServiceError("RULE_NOT_FOUND", "rule not found", 404)
            normalized["actions"] = self._validate_actions(
                normalized.get("actions"),
                event_type=str(existing.event_type),
            )
        self._upsert_cron_if_requested(normalized, str(normalized.get("event_type") or "cron.job.tick"))
        try:
            updated = update_rule(self.rules_path, safe_id, normalized)
        except ValueError as exc:
            raise RuleServiceError("RULE_UPDATE_FAILED", str(exc)) from exc
        if updated is None:
            raise RuleServiceError("RULE_NOT_FOUND", "rule not found", 404)
        data = asdict(updated)
        data["actions"] = [asdict(action) for action in updated.actions]
        data["version"] = 2
        data["audit_event"] = "rule.updated"
        return data

    def enable_rule(self, rule_id: str) -> dict[str, Any]:
        if not set_rule_active(self.rules_path, rule_id, active=True):
            raise RuleServiceError("RULE_NOT_FOUND", "rule not found", 404)
        return {"rule_id": rule_id, "active": True, "audit_event": "rule.updated"}

    def disable_rule(self, rule_id: str) -> dict[str, Any]:
        if not set_rule_active(self.rules_path, rule_id, active=False):
            raise RuleServiceError("RULE_NOT_FOUND", "rule not found", 404)
        return {"rule_id": rule_id, "active": False, "audit_event": "rule.updated"}

    def delete_rule(self, rule_id: str) -> dict[str, Any]:
        if not delete_rule(self.rules_path, rule_id):
            raise RuleServiceError("RULE_NOT_FOUND", "rule not found", 404)
        return {
            "rule_id": rule_id,
            "active": False,
            "deleted_at": datetime.now(UTC).isoformat(),
            "audit_event": "rule.deleted",
        }

    def simulate_rule(self, payload: dict[str, Any]) -> dict[str, Any]:
        event_payload = payload.get("event")
        if not isinstance(event_payload, dict):
            raise RuleServiceError("INVALID_EVENT", "simulate requires event object")
        source = str(event_payload.get("source") or "simulate")
        event_type = str(event_payload.get("event_type") or "").strip()
        if not event_type:
            raise RuleServiceError("INVALID_EVENT", "event.event_type is required")
        event = Event(
            event_id=f"evt_sim_{uuid4().hex}",
            event_type=event_type,
            source=source,
            subject=str(event_payload.get("subject")) if event_payload.get("subject") else None,
            payload=event_payload.get("payload") if isinstance(event_payload.get("payload"), dict) else {},
            risk_hint=str(event_payload.get("risk_hint") or "low"),
        )

        target_rule: EventRule | None = None
        rule_obj = payload.get("rule")
        if isinstance(rule_obj, dict):
            normalized = self._validate_core_rule_fields(rule_obj, is_update=False)
            normalized["id"] = str(normalized.get("id") or self._build_rule_id(normalized["name"]))
            target_rule = EventRule(
                id=normalized["id"],
                name=normalized["name"],
                event_type=normalized["event_type"],
                conditions=normalized.get("conditions") if isinstance(normalized.get("conditions"), dict) else {"all": []},
                action_mode=normalized.get("action_mode", "suggest"),
                actions=[],
                risk_level=normalized.get("risk_level", "low"),
                priority=int(normalized.get("priority", 50) or 50),
                dedupe_window_seconds=int(normalized.get("dedupe_window_seconds", 300) or 300),
                cooldown_seconds=int(normalized.get("cooldown_seconds", 600) or 600),
                attention_budget_per_day=int(normalized.get("attention_budget_per_day", 10) or 10),
                is_active=bool(normalized.get("is_active", True)),
            )
        else:
            rule_id = str(payload.get("rule_id") or "").strip()
            if not rule_id:
                raise RuleServiceError("INVALID_RULE", "simulate requires rule or rule_id")
            for item in load_rules(self.rules_path):
                if item.id == rule_id or item.name == rule_id:
                    target_rule = item
                    break
        if target_rule is None:
            raise RuleServiceError("RULE_NOT_FOUND", "rule not found", 404)

        matched = self.evaluator.evaluate(target_rule.conditions, event)
        decision = target_rule.action_mode if matched else "skip"
        return {
            "matched": matched,
            "decision": decision,
            "reason": "condition_matched" if matched else "condition_not_matched",
            "would_require_approval": target_rule.risk_level == "high" or target_rule.action_mode == "ask",
            "rule_id": target_rule.id,
            "event_type": event.event_type,
            "audit_event": "rule.simulated",
        }
