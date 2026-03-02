"""Builtin rule authoring tool for runtime rule governance."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

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
            "Create, update, enable/disable, delete, and simulate Semibot event rules. "
            "Supports optional cron scheduler upsert when creating cron rules."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
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
                    "description": "Rule authoring action to execute.",
                },
                "payload": {
                    "type": "object",
                    "description": "Action payload. For update/enable/disable/delete, include rule_id.",
                    "default": {},
                },
                "options": {
                    "type": "object",
                    "description": "Optional controls: dry_run, idempotency_key, override_reason.",
                    "default": {},
                },
                "rule_id": {
                    "type": "string",
                    "description": "Shortcut field for update/enable/disable/delete when payload.rule_id is omitted.",
                },
            },
            # Keep action strongly recommended, but allow runtime inference for
            # imperfect tool-call outputs.
            "required": [],
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
        cron_expr = str(payload_obj.get("cron_expression") or payload_obj.get("schedule") or "").strip() or "0 9 * * *"
        enabled = bool(payload_obj.get("enabled", True))
        trigger_name = self._safe_cron_name(legacy_name)

        normalized: dict[str, Any] = {
            "name": legacy_name,
            "event_type": "cron.job.tick",
            "conditions": {"all": [{"field": "payload.trigger_name", "op": "==", "value": trigger_name}]},
            "action_mode": "suggest",
            "actions": [{"action_type": "notify", "params": {"channel": "chat", "summary": description}}],
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
                "payload": {"trigger_name": trigger_name},
            },
        }
        return "create_rule", normalized

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
        if not action_name:
            return ToolResult.error_result("action is required")
        action_name, payload_obj = self._normalize_legacy_payload(action_name, payload_obj)

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
                data = service.create_rule(payload_obj)
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
