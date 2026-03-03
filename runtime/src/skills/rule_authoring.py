"""Builtin rule authoring tool for runtime rule governance."""

from __future__ import annotations

import os
import re
from copy import deepcopy
from pathlib import Path
from typing import Any
from uuid import uuid4

from src.events.trigger_scheduler import TriggerScheduler
from src.services.rule_service import RuleService, RuleServiceError
from src.skills.base import BaseTool, ToolResult


class RuleAuthoringTool(BaseTool):
    """Create/update/simulate/enable/disable/delete event rules."""

    def __init__(self) -> None:
        self.rules_path = os.getenv("SEMIBOT_RULES_PATH") or str(Path("~/.semibot/rules").expanduser())
        self.db_path = os.getenv("SEMIBOT_EVENTS_DB_PATH")

    def _get_service(self) -> RuleService:
        return RuleService(rules_path=self.rules_path, db_path=self.db_path)

    @property
    def name(self) -> str:
        return "rule_authoring"

    @property
    def description(self) -> str:
        return (
            "Author Semibot rules with full lifecycle operations: "
            "create_rule, update_rule, enable_rule, disable_rule, delete_rule, simulate_rule, list_rules. "
            "Use action + payload. Supports cron linkage (payload.cron.upsert=true) when event_type=cron.job.tick.\n\n"
            "Minimal examples:\n"
            "1) create_rule (cron reminder)\n"
            '{"action":"create_rule","payload":{"name":"drink_water","event_type":"cron.job.tick","action_mode":"auto","actions":[{"action_type":"notify","params":{"channel":"chat","summary":"喝水提醒"}}],"risk_level":"low","cron":{"upsert":true,"name":"drink_water","schedule":"*/5 * * * *","payload":{"trigger_name":"drink_water"}}}}\n'
            "2) update_rule (patch mode/risk)\n"
            '{"action":"update_rule","payload":{"rule_id":"rule_xxx","action_mode":"notify","risk_level":"medium"}}\n'
            "3) enable/disable/delete\n"
            '{"action":"enable_rule","payload":{"rule_id":"rule_xxx"}}\n'
            '{"action":"disable_rule","payload":{"rule_id":"rule_xxx"}}\n'
            '{"action":"delete_rule","payload":{"rule_id":"rule_xxx"}}\n'
            "4) simulate_rule\n"
            '{"action":"simulate_rule","payload":{"rule_id":"rule_xxx","event":{"event_type":"chat.message.received","source":"test","subject":"sess_1","payload":{"text":"hello"}}}}\n'
            "5) list_rules\n"
            '{"action":"list_rules","payload":{}}'
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "additionalProperties": True,
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "create_rule",
                        "update_rule",
                        "enable_rule",
                        "disable_rule",
                        "delete_rule",
                        "simulate_rule",
                        "list_rules",
                    ],
                    "description": (
                        "Operation name.\n"
                        "- create_rule: create a new rule\n"
                        "- update_rule: patch an existing rule (requires rule_id)\n"
                        "- enable_rule/disable_rule/delete_rule: lifecycle ops (requires rule_id)\n"
                        "- simulate_rule: test a rule against an event\n"
                        "- list_rules: return all rules"
                    ),
                },
                "payload": {
                    "type": "object",
                    "description": (
                        "Action payload. Field requirements by action:\n"
                        "1) create_rule required: name, event_type, action_mode, actions\n"
                        "   optional: conditions, risk_level, priority, dedupe_window_seconds, "
                        "cooldown_seconds, attention_budget_per_day, is_active, override_reason, cron\n"
                        "2) update_rule required: rule_id; optional: any patch fields above\n"
                        "3) enable_rule/disable_rule/delete_rule required: rule_id\n"
                        "4) simulate_rule required: rule_id OR rule, and event\n"
                        "5) list_rules: payload may be empty\n"
                        "Cron linkage (create/update): set payload.cron = {upsert:true,name,schedule,...}"
                    ),
                    "default": {},
                    "properties": {
                        "rule_id": {"type": "string", "description": "Target rule id for update/enable/disable/delete/simulate."},
                        "name": {"type": "string", "description": "Rule display name (create/update)."},
                        "event_type": {"type": "string", "description": "Event type to match, e.g. chat.message.received / cron.job.tick."},
                        "conditions": {"type": "object", "description": "Condition tree, usually {all:[{field,op,value}, ...]}."},
                        "action_mode": {
                            "type": "string",
                            "enum": ["ask", "suggest", "auto", "skip"],
                            "description": "Execution mode. Optional; defaults to auto if omitted.",
                        },
                        "actions": {
                            "type": "array",
                            "description": (
                                "Action list. Each item: {action_type,target?,params?}. "
                                "For cron + notify, params.gateway_id is required."
                            ),
                            "items": {
                                "type": "object",
                                "properties": {
                                    "action_type": {"type": "string", "description": "Action type, e.g. notify."},
                                    "target": {"type": "string", "description": "Optional action target."},
                                    "params": {
                                        "type": "object",
                                        "description": (
                                            "Action parameters, e.g. {channel:'chat',summary:'...'}; "
                                            "for cron notify include gateway_id."
                                        ),
                                    },
                                },
                            },
                        },
                        "risk_level": {"type": "string", "enum": ["low", "medium", "high", "critical"], "description": "Rule risk level."},
                        "priority": {"type": "integer", "description": "Higher value executes first."},
                        "dedupe_window_seconds": {"type": "integer", "description": "Dedupe window in seconds."},
                        "cooldown_seconds": {"type": "integer", "description": "Cooldown window in seconds."},
                        "attention_budget_per_day": {"type": "integer", "description": "Daily execution budget."},
                        "is_active": {"type": "boolean", "description": "Whether the rule is active."},
                        "override_reason": {"type": "string", "description": "Required for auto+high-risk updates/creates."},
                        "cron": {
                            "type": "object",
                            "description": "Optional cron scheduler linkage.",
                            "properties": {
                                "upsert": {"type": "boolean", "description": "When true, create/update scheduler entry."},
                                "name": {"type": "string", "description": "Scheduler trigger name; must be stable/unique."},
                                "schedule": {
                                    "type": "string",
                                    "description": "Cron expression (5-field) or @every:<seconds>.",
                                },
                                "event_type": {"type": "string", "description": "Emitted event type, default cron.job.tick."},
                                "source": {"type": "string", "description": "Event source, default system.cron."},
                                "subject": {"type": "string", "description": "Event subject, default system."},
                                "payload": {"type": "object", "description": "Event payload; usually include trigger_name."},
                            },
                        },
                        "event": {
                            "type": "object",
                            "description": "Simulation event object for simulate_rule.",
                            "properties": {
                                "event_type": {"type": "string"},
                                "source": {"type": "string"},
                                "subject": {"type": "string"},
                                "payload": {"type": "object"},
                            },
                        },
                        "rule": {"type": "object", "description": "Inline rule object for simulate_rule (optional alternative to rule_id)."},
                    },
                },
                "options": {
                    "type": "object",
                    "description": (
                        "Optional controls:\n"
                        "- dry_run: validate/normalize only, do not persist\n"
                        "- idempotency_key: caller-side dedupe key (reserved)\n"
                        "- override_reason: explicit reason for sensitive changes"
                    ),
                    "default": {},
                    "properties": {
                        "dry_run": {"type": "boolean"},
                        "idempotency_key": {"type": "string"},
                        "override_reason": {"type": "string"},
                    },
                },
                "rule_id": {
                    "type": "string",
                    "description": "Shortcut for payload.rule_id.",
                },
            },
            "required": ["action"],
        }

    def _normalize_action(self, action: str) -> str:
        alias_map = {
            "create": "create_rule",
            "update": "update_rule",
            "enable": "enable_rule",
            "disable": "disable_rule",
            "delete": "delete_rule",
            "simulate": "simulate_rule",
            "list": "list_rules",
        }
        return alias_map.get(action, action)

    def _is_legacy_create_intent(self, action_name: str, payload_obj: dict[str, Any]) -> bool:
        if action_name not in {"send_message", "remind", "set_reminder"}:
            return False
        if any(key in payload_obj for key in ("cron_expression", "schedule", "cron", "rule_condition", "trigger_type")):
            return True
        event_type = str(payload_obj.get("event_type") or "").strip()
        if event_type.startswith("cron."):
            return True
        intent_text = self._merge_intent_text(payload_obj)
        return self._looks_like_relative_intent(intent_text) or self._looks_like_periodic_intent(intent_text)

    def _infer_action(self, payload_obj: dict[str, Any]) -> str:
        # Case 1: nested envelope accidentally put inside payload.
        nested_action = str(payload_obj.get("action") or "").strip()
        if nested_action:
            return self._normalize_action(nested_action)

        # Case 2: explicit simulate signature.
        if "event" in payload_obj and ("rule" in payload_obj or "rule_id" in payload_obj):
            return "simulate_rule"

        # Case 3: create signature.
        has_create_fields = all(
            key in payload_obj for key in ("name", "event_type", "action_mode", "actions")
        )
        if has_create_fields:
            return "create_rule"

        # Case 3.1: legacy reminder/news shorthand.
        has_legacy_create_fields = any(
            key in payload_obj for key in ("cron_expression", "schedule", "rule_action", "rule_condition", "rule_name")
        )
        if has_legacy_create_fields:
            return "create_rule"

        # Case 4: enable/disable shortcut.
        if "rule_id" in payload_obj and isinstance(payload_obj.get("is_active"), bool):
            return "enable_rule" if payload_obj.get("is_active") else "disable_rule"

        # Case 5: generic patch update.
        if "rule_id" in payload_obj:
            return "update_rule"

        # Case 6: empty payload list query.
        if not payload_obj:
            return "list_rules"

        return ""

    @staticmethod
    def _safe_cron_name(raw: str) -> str:
        base = "".join(ch if ch.isalnum() or ch in {"_", "-"} else "_" for ch in raw.strip())
        base = base.strip("_") or "daily_digest"
        return base[:120]

    @staticmethod
    def _minutes_to_cron(value: int) -> str:
        safe = max(1, min(59, int(value)))
        return f"*/{safe} * * * *"

    def _looks_like_periodic_intent(self, text: str) -> bool:
        content = (text or "").strip()
        if not content:
            return False
        patterns = [
            r"每\s*(\d{1,2})\s*分钟",
            r"every\s+(\d{1,2})\s+minutes?",
        ]
        return any(re.search(pattern, content, flags=re.IGNORECASE) for pattern in patterns)

    def _looks_like_relative_intent(self, text: str) -> bool:
        content = (text or "").strip()
        if not content:
            return False
        patterns = [
            r"(\d{1,2})\s*分钟\s*后",
            r"in\s+(\d{1,2})\s+minutes?",
        ]
        return any(re.search(pattern, content, flags=re.IGNORECASE) for pattern in patterns)

    def _merge_intent_text(self, payload_obj: dict[str, Any]) -> str:
        cron_obj = payload_obj.get("cron") if isinstance(payload_obj.get("cron"), dict) else {}
        candidates = [
            payload_obj.get("name"),
            payload_obj.get("rule_name"),
            payload_obj.get("target"),
            payload_obj.get("description"),
            payload_obj.get("message"),
            payload_obj.get("task"),
            payload_obj.get("query"),
            payload_obj.get("prompt"),
            payload_obj.get("schedule"),
            payload_obj.get("cron_expression"),
            cron_obj.get("schedule"),
        ]
        return " ".join(str(item) for item in candidates if item)

    def _apply_one_shot_hint_for_cron(self, payload_obj: dict[str, Any]) -> dict[str, Any]:
        """Force one-shot for relative reminders (e.g. '3分钟后') in both schemas."""

        event_type = str(payload_obj.get("event_type") or "").strip()
        if event_type != "cron.job.tick":
            return payload_obj

        cron_obj = payload_obj.get("cron")
        if not isinstance(cron_obj, dict):
            return payload_obj

        intent_text = self._merge_intent_text(payload_obj)
        has_relative = self._looks_like_relative_intent(intent_text)
        has_periodic = self._looks_like_periodic_intent(intent_text)
        if not has_relative or has_periodic:
            return payload_obj

        cron_payload = cron_obj.get("payload")
        if not isinstance(cron_payload, dict):
            cron_payload = {}

        # Relative-time reminders should be one-shot by default.
        payload_obj["cron"] = {**cron_obj, "payload": {**cron_payload, "one_shot": True}}
        return payload_obj

    def _infer_cron_from_text(self, text: str) -> tuple[str, bool]:
        content = (text or "").strip()
        if not content:
            return "", False
        # every/每N分钟（含“X分钟后”兜底转为周期）
        periodic_patterns = [
            r"每\s*(\d{1,2})\s*分钟",
            r"every\s+(\d{1,2})\s+minutes?",
        ]
        for pattern in periodic_patterns:
            m = re.search(pattern, content, flags=re.IGNORECASE)
            if m:
                return self._minutes_to_cron(int(m.group(1))), False

        one_shot_patterns = [
            r"(\d{1,2})\s*分钟\s*后",
            r"in\s+(\d{1,2})\s+minutes?",
        ]
        for pattern in one_shot_patterns:
            m = re.search(pattern, content, flags=re.IGNORECASE)
            if m:
                return self._minutes_to_cron(int(m.group(1))), True

        # 每天 HH:MM / HH点
        m = re.search(r"(?:每天|每日).{0,8}?(\d{1,2})\s*[:：]\s*(\d{1,2})", content)
        if m:
            hour = max(0, min(23, int(m.group(1))))
            minute = max(0, min(59, int(m.group(2))))
            return f"{minute} {hour} * * *", False

        m = re.search(r"(?:每天|每日).{0,8}?(\d{1,2})\s*点", content)
        if m:
            hour = max(0, min(23, int(m.group(1))))
            return f"0 {hour} * * *", False

        # daily at HH(:MM)
        m = re.search(r"daily\s+at\s+(\d{1,2})(?::(\d{1,2}))?", content, flags=re.IGNORECASE)
        if m:
            hour = max(0, min(23, int(m.group(1))))
            minute = max(0, min(59, int(m.group(2) or 0)))
            return f"{minute} {hour} * * *", False
        return "", False

    def _infer_cron_expression(self, payload_obj: dict[str, Any]) -> tuple[str, bool]:
        explicit = str(
            payload_obj.get("cron_expression")
            or payload_obj.get("schedule")
            or (
                payload_obj.get("cron", {}).get("schedule")
                if isinstance(payload_obj.get("cron"), dict)
                else ""
            )
            or ""
        ).strip()
        if explicit:
            # Keep valid explicit schedules as-is.
            interval = TriggerScheduler.parse_schedule_to_interval_seconds(explicit)
            cron_expr = TriggerScheduler.parse_cron_expression(explicit)
            if interval is not None or cron_expr is not None:
                return explicit, False
            # If explicit value is natural language ("14分钟后"), normalize it.
            normalized, one_shot = self._infer_cron_from_text(explicit)
            if normalized:
                return normalized, one_shot
        candidates = [
            payload_obj.get("name"),
            payload_obj.get("rule_name"),
            payload_obj.get("target"),
            payload_obj.get("description"),
            payload_obj.get("message"),
            payload_obj.get("task"),
            payload_obj.get("query"),
            payload_obj.get("prompt"),
        ]
        merged = " ".join(str(item) for item in candidates if item)
        inferred, one_shot = self._infer_cron_from_text(merged)
        return (inferred or "0 9 * * *"), one_shot

    def _normalize_legacy_payload(self, action_name: str, payload_obj: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        # Backward-compatible path for legacy planner outputs:
        # action=create + rule_name/cron_expression/... schema.
        if action_name not in {"create_rule", "create", "search_and_summarize_news"}:
            return action_name, payload_obj

        has_new_schema = "event_type" in payload_obj and ("actions" in payload_obj or "action_mode" in payload_obj)
        if has_new_schema:
            return action_name, payload_obj

        legacy_name = str(
            payload_obj.get("name")
            or payload_obj.get("rule_name")
            or payload_obj.get("target")
            or "daily_news_digest"
        ).strip()
        description = str(payload_obj.get("description") or "定时任务").strip()
        cron_expr, inferred_one_shot = self._infer_cron_expression(payload_obj)
        existing_cron_payload = payload_obj.get("cron")
        explicit_one_shot = False
        if isinstance(existing_cron_payload, dict):
            explicit_one_shot = bool(existing_cron_payload.get("one_shot", existing_cron_payload.get("oneShot", False)))
        one_shot = explicit_one_shot or inferred_one_shot
        enabled = bool(payload_obj.get("enabled", True))
        trigger_name = self._safe_cron_name(legacy_name)

        gateway_id = str(
            payload_obj.get("gateway_id")
            or payload_obj.get("gatewayId")
            or payload_obj.get("target_gateway_id")
            or ""
        ).strip()

        notify_params: dict[str, Any] = {"channel": "chat", "summary": description}
        if gateway_id:
            notify_params["gateway_id"] = gateway_id

        normalized: dict[str, Any] = {
            "name": legacy_name,
            "event_type": "cron.job.tick",
            "conditions": {"all": [{"field": "payload.trigger_name", "op": "==", "value": trigger_name}]},
            "action_mode": "auto",
            "actions": [{"action_type": "notify", "params": notify_params}],
            "risk_level": "low",
            "priority": 50,
            "dedupe_window_seconds": 300,
            "cooldown_seconds": 600,
            "attention_budget_per_day": 10,
            "is_active": enabled,
            "cron": {
                "upsert": True,
                "name": trigger_name,
                "schedule": cron_expr,
                "event_type": "cron.job.tick",
                "source": "system.cron",
                "subject": "system",
                "payload": {
                    "trigger_name": trigger_name,
                    **({"one_shot": True} if one_shot else {}),
                },
            },
        }
        return "create_rule", normalized

    @staticmethod
    def _create_payload_with_unique_name(payload_obj: dict[str, Any], suffix: str) -> dict[str, Any]:
        patched = deepcopy(payload_obj)
        original_name = str(patched.get("name") or "").strip()
        if original_name:
            patched["name"] = f"{original_name}_{suffix}"

        cron = patched.get("cron")
        if isinstance(cron, dict):
            original_cron_name = str(cron.get("name") or "").strip()
            if original_cron_name:
                patched["cron"] = {**cron, "name": f"{original_cron_name}_{suffix}"}
                # Keep rule condition aligned with trigger_name when generated this way.
                conditions = patched.get("conditions")
                if isinstance(conditions, dict):
                    all_list = conditions.get("all")
                    if isinstance(all_list, list):
                        for cond in all_list:
                            if (
                                isinstance(cond, dict)
                                and str(cond.get("field") or "") == "payload.trigger_name"
                                and str(cond.get("value") or "") == original_cron_name
                            ):
                                cond["value"] = f"{original_cron_name}_{suffix}"
        return patched

    async def execute(
        self,
        action: str | None = None,
        payload: dict[str, Any] | None = None,
        options: dict[str, Any] | None = None,
        rule_id: str | None = None,
        **kwargs: Any,
    ) -> ToolResult:
        payload_obj = dict(payload) if isinstance(payload, dict) else {}
        if rule_id and "rule_id" not in payload_obj:
            payload_obj["rule_id"] = rule_id
        if options and isinstance(options, dict):
            if "override_reason" in options and "override_reason" not in payload_obj:
                payload_obj["override_reason"] = options.get("override_reason")
        for key, value in kwargs.items():
            if key not in payload_obj:
                payload_obj[key] = value

        # Handle nested envelope format:
        # {"payload": {"action": "...", "payload": {...}, "options": {...}}}
        if "action" in payload_obj and "payload" in payload_obj and isinstance(payload_obj.get("payload"), dict):
            nested = dict(payload_obj.get("payload") or {})
            nested_options = payload_obj.get("options")
            if isinstance(nested_options, dict):
                options = {**(options or {}), **nested_options}
            payload_obj = nested

        dry_run = bool((options or {}).get("dry_run")) if isinstance(options, dict) else False
        action_name = self._normalize_action((action or "").strip())
        if not action_name:
            action_name = self._infer_action(payload_obj)
        elif self._is_legacy_create_intent(action_name, payload_obj):
            # Keep backward compatibility for reminder-style legacy actions only.
            action_name = "create_rule"
        if not action_name:
            return ToolResult.error_result("action is required")

        # Backward compatibility: some planners still use `notify` as action_mode.
        # RuleService only accepts ask/suggest/auto/skip.
        raw_mode = payload_obj.get("action_mode")
        if isinstance(raw_mode, str) and raw_mode.strip().lower() == "notify":
            payload_obj["action_mode"] = "suggest"
        elif action_name in {"create_rule", "update_rule"} and (
            raw_mode is None or (isinstance(raw_mode, str) and not raw_mode.strip())
        ):
            # Product policy: default mode should be auto instead of letting model decide.
            payload_obj["action_mode"] = "auto"

        action_name, payload_obj = self._normalize_legacy_payload(action_name, payload_obj)
        payload_obj = self._apply_one_shot_hint_for_cron(payload_obj)

        if dry_run:
            return ToolResult.success_result(
                {
                    "ok": True,
                    "action": action_name,
                    "dry_run": True,
                    "validated_payload": payload_obj,
                }
            )

        try:
            service = self._get_service()
            if action_name == "list_rules":
                data = service.list_rules()
                return ToolResult.success_result({"ok": True, "action": action_name, "items": data})
            if action_name == "create_rule":
                try:
                    data = service.create_rule(payload_obj)
                except RuleServiceError as exc:
                    if exc.code != "RULE_NAME_CONFLICT":
                        raise
                    # Auto-resolve name conflict for better tool robustness.
                    retried = False
                    original_name = str(payload_obj.get("name") or "").strip()
                    for _ in range(3):
                        suffix = uuid4().hex[:6]
                        patched = self._create_payload_with_unique_name(payload_obj, suffix)
                        try:
                            data = service.create_rule(patched)
                            data["conflict_resolved"] = True
                            data["original_name"] = original_name
                            data["resolved_name"] = str(patched.get("name") or "")
                            retried = True
                            break
                        except RuleServiceError as retry_exc:
                            if retry_exc.code != "RULE_NAME_CONFLICT":
                                raise
                    if not retried:
                        raise
            elif action_name == "update_rule":
                safe_rule_id = str(payload_obj.get("rule_id") or "").strip()
                data = service.update_rule(safe_rule_id, payload_obj)
            elif action_name == "enable_rule":
                safe_rule_id = str(payload_obj.get("rule_id") or "").strip()
                data = service.enable_rule(safe_rule_id)
            elif action_name == "disable_rule":
                safe_rule_id = str(payload_obj.get("rule_id") or "").strip()
                data = service.disable_rule(safe_rule_id)
            elif action_name == "delete_rule":
                safe_rule_id = str(payload_obj.get("rule_id") or "").strip()
                data = service.delete_rule(safe_rule_id)
            elif action_name == "simulate_rule":
                data = service.simulate_rule(payload_obj)
            else:
                return ToolResult.error_result(f"unsupported action: {action_name}")
        except RuleServiceError as exc:
            return ToolResult.error_result(
                f"{exc.code}: {exc.message}",
                error_code=exc.code,
                status_code=exc.status_code,
                action=action_name,
            )
        except Exception as exc:
            return ToolResult.error_result(str(exc), action=action_name, error_code="RULE_TOOL_FAILED")

        return ToolResult.success_result({"ok": True, "action": action_name, **data})
