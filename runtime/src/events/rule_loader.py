"""Rule file loading and minimal mutation utilities."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from dataclasses import asdict
from pathlib import Path
from typing import Any

from src.events.models import EventRule, RuleAction

DEFAULT_RULES: list[dict[str, Any]] = [
    {
        "id": "rule_tool_exec_failed_notify",
        "name": "tool_exec_failed_notify",
        "event_type": "tool.exec.failed",
        "conditions": {"all": []},
        "action_mode": "suggest",
        "actions": [{"action_type": "notify", "params": {"channel": "runtime"}}],
        "risk_level": "low",
        "priority": 50,
        "dedupe_window_seconds": 30,
        "cooldown_seconds": 15,
        "attention_budget_per_day": 100,
        "is_active": True,
    },
    {
        "id": "rule_task_failed_notify",
        "name": "task_failed_notify",
        "event_type": "task.failed",
        "conditions": {"all": []},
        "action_mode": "suggest",
        "actions": [{"action_type": "notify", "params": {"channel": "runtime"}}],
        "risk_level": "low",
        "priority": 40,
        "dedupe_window_seconds": 60,
        "cooldown_seconds": 30,
        "attention_budget_per_day": 50,
        "is_active": True,
    },
]


def default_rules_path() -> Path:
    """Return default rules directory."""
    return Path("~/.semibot/rules").expanduser()


def _candidate_rule_files(path: Path) -> list[Path]:
    if path.is_file():
        return [path] if path.suffix == ".json" else []
    if not path.exists():
        return []
    default_file = path / "default.json"
    files = [default_file] if default_file.exists() else []
    files.extend([p for p in sorted(path.glob("*.json")) if p.name != "default.json"])
    return files


def list_rule_files(path: str | Path | None = None) -> list[Path]:
    """List rule files for a directory/file target."""
    target = Path(path).expanduser() if path else default_rules_path()
    ensure_default_rules(target)
    return _candidate_rule_files(target)


def _normalize_rule(raw: dict[str, Any]) -> EventRule | None:
    if raw.get("deleted_at"):
        return None
    rule_id = str(raw.get("id") or raw.get("name") or "").strip()
    event_type = str(raw.get("event_type") or "").strip()
    name = str(raw.get("name") or rule_id).strip()
    if not rule_id or not event_type or not name:
        return None

    actions_raw = raw.get("actions")
    actions: list[RuleAction] = []
    if isinstance(actions_raw, list):
        for action in actions_raw:
            if not isinstance(action, dict):
                continue
            action_type = str(action.get("action_type") or "").strip()
            if not action_type:
                continue
            actions.append(
                RuleAction(
                    action_type=action_type,
                    target=str(action.get("target")).strip() if action.get("target") else None,
                    params=action.get("params") if isinstance(action.get("params"), dict) else {},
                )
            )

    return EventRule(
        id=rule_id,
        name=name,
        event_type=event_type,
        conditions=raw.get("conditions") if isinstance(raw.get("conditions"), dict) else {},
        action_mode=str(raw.get("action_mode") or "auto"),
        actions=actions,
        risk_level=str(raw.get("risk_level") or "low"),
        priority=int(raw.get("priority", 0) or 0),
        dedupe_window_seconds=int(raw.get("dedupe_window_seconds", 0) or 0),
        cooldown_seconds=int(raw.get("cooldown_seconds", 0) or 0),
        attention_budget_per_day=int(raw.get("attention_budget_per_day", 0) or 0),
        is_active=bool(raw.get("is_active", True)),
    )


def load_rules(path: str | Path | None = None) -> list[EventRule]:
    """
    Load and merge rules from file or directory.

    Merge policy:
    - if same rule `name` appears multiple times, later file overrides earlier.
    - fallback key is `id`.
    """
    target = Path(path).expanduser() if path else default_rules_path()
    ensure_default_rules(target)
    files = _candidate_rule_files(target)
    merged_by_key: dict[str, EventRule] = {}
    for file in files:
        try:
            with file.open("r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            continue

        items: list[dict[str, Any]]
        if isinstance(data, list):
            items = [item for item in data if isinstance(item, dict)]
        elif isinstance(data, dict):
            items = [data]
        else:
            continue

        for raw in items:
            rule = _normalize_rule(raw)
            if rule is None:
                continue
            key = rule.name or rule.id
            merged_by_key[key] = rule

    return sorted(merged_by_key.values(), key=lambda rule: rule.priority, reverse=True)


def _iter_rule_files_for_mutation(path: Path) -> list[Path]:
    if path.is_file():
        return [path]
    if not path.exists():
        return []
    return sorted(path.glob("*.json"))


def _read_json_file(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _write_json_file(path: Path, data: Any) -> None:
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def _rule_to_raw(rule: EventRule) -> dict[str, Any]:
    return {
        "id": rule.id,
        "name": rule.name,
        "event_type": rule.event_type,
        "conditions": rule.conditions,
        "action_mode": rule.action_mode,
        "actions": [asdict(action) for action in rule.actions],
        "risk_level": rule.risk_level,
        "priority": rule.priority,
        "dedupe_window_seconds": rule.dedupe_window_seconds,
        "cooldown_seconds": rule.cooldown_seconds,
        "attention_budget_per_day": rule.attention_budget_per_day,
        "is_active": rule.is_active,
    }


def _default_mutation_file(path: Path) -> Path:
    if path.suffix == ".json":
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            _write_json_file(path, [])
        return path
    path.mkdir(parents=True, exist_ok=True)
    target = path / "custom.json"
    if not target.exists():
        _write_json_file(target, [])
    return target


def set_rule_active(path: str | Path, rule_id: str, *, active: bool) -> bool:
    """Set `is_active` for the target rule; returns True if updated."""
    target = Path(path).expanduser()
    files = _iter_rule_files_for_mutation(target)
    for file in files:
        try:
            with file.open("r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            continue

        changed = False
        if isinstance(data, list):
            for item in data:
                if not isinstance(item, dict):
                    continue
                item_id = str(item.get("id") or item.get("name") or "").strip()
                if item_id == rule_id:
                    item["is_active"] = active
                    changed = True
        elif isinstance(data, dict):
            item_id = str(data.get("id") or data.get("name") or "").strip()
            if item_id == rule_id:
                data["is_active"] = active
                changed = True

        if changed:
            with file.open("w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
                f.write("\n")
            return True
    return False


def create_rule(path: str | Path, payload: dict[str, Any]) -> EventRule:
    """Create a rule in mutable rule file and return normalized model."""
    target = Path(path).expanduser()
    ensure_default_rules(target)
    rule = _normalize_rule(payload)
    if rule is None:
        raise ValueError("invalid_rule_payload")

    existing = load_rules(target)
    for item in existing:
        if item.id == rule.id or item.name == rule.name:
            raise ValueError("rule_conflict")

    mutation_file = _default_mutation_file(target)
    raw = _read_json_file(mutation_file)
    if isinstance(raw, list):
        raw.append(_rule_to_raw(rule))
        _write_json_file(mutation_file, raw)
        return rule
    if isinstance(raw, dict):
        # Single-object file fallback: convert to list for safer future mutation.
        _write_json_file(mutation_file, [raw, _rule_to_raw(rule)])
        return rule
    _write_json_file(mutation_file, [_rule_to_raw(rule)])
    return rule


def update_rule(path: str | Path, rule_id: str, patch: dict[str, Any]) -> EventRule | None:
    """Patch a rule by id/name and return normalized model."""
    target = Path(path).expanduser()
    files = _iter_rule_files_for_mutation(target)
    for file in files:
        try:
            data = _read_json_file(file)
        except Exception:
            continue

        def _apply(item: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
            item_id = str(item.get("id") or item.get("name") or "").strip()
            if item_id != rule_id:
                return False, item
            merged = dict(item)
            for key, value in patch.items():
                merged[key] = value
            normalized = _normalize_rule(merged)
            if normalized is None:
                raise ValueError("invalid_rule_patch")
            return True, _rule_to_raw(normalized)

        changed = False
        if isinstance(data, list):
            next_items: list[Any] = []
            for item in data:
                if not isinstance(item, dict):
                    next_items.append(item)
                    continue
                applied, result_item = _apply(item)
                changed = changed or applied
                next_items.append(result_item)
            if changed:
                _write_json_file(file, next_items)
                loaded = _normalize_rule(next(i for i in next_items if isinstance(i, dict) and str(i.get("id") or i.get("name") or "").strip() == rule_id))
                return loaded
        elif isinstance(data, dict):
            applied, result_item = _apply(data)
            if applied:
                _write_json_file(file, result_item)
                return _normalize_rule(result_item)

    return None


def delete_rule(path: str | Path, rule_id: str) -> bool:
    """Soft-delete a rule (is_active=false + deleted_at)."""
    target = Path(path).expanduser()
    deleted_at = datetime.now(UTC).isoformat()
    files = _iter_rule_files_for_mutation(target)
    for file in files:
        try:
            data = _read_json_file(file)
        except Exception:
            continue
        changed = False
        if isinstance(data, list):
            for item in data:
                if not isinstance(item, dict):
                    continue
                item_id = str(item.get("id") or item.get("name") or "").strip()
                if item_id != rule_id:
                    continue
                item["is_active"] = False
                item["deleted_at"] = deleted_at
                changed = True
        elif isinstance(data, dict):
            item_id = str(data.get("id") or data.get("name") or "").strip()
            if item_id == rule_id:
                data["is_active"] = False
                data["deleted_at"] = deleted_at
                changed = True
        if changed:
            _write_json_file(file, data)
            return True
    return False


def ensure_default_rules(path: str | Path | None = None) -> Path:
    """Ensure default rules file exists, returns the default rule file path."""
    target = Path(path).expanduser() if path else default_rules_path()
    if target.suffix == ".json":
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("w", encoding="utf-8") as f:
                json.dump(DEFAULT_RULES, f, ensure_ascii=False, indent=2)
                f.write("\n")
        return target

    target.mkdir(parents=True, exist_ok=True)
    default_file = target / "default.json"
    if not default_file.exists():
        with default_file.open("w", encoding="utf-8") as f:
            json.dump(DEFAULT_RULES, f, ensure_ascii=False, indent=2)
            f.write("\n")
    return default_file


def rules_to_json(rules: list[EventRule]) -> list[dict[str, Any]]:
    """Serialize EventRule objects for JSON output."""
    payload: list[dict[str, Any]] = []
    for rule in rules:
        obj = asdict(rule)
        obj["actions"] = [asdict(action) for action in rule.actions]
        payload.append(obj)
    return payload
