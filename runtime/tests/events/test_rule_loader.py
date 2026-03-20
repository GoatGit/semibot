"""Tests for JSON rule loading and mutation."""

import json
from pathlib import Path

from src.events.rule_loader import load_rules, set_rule_active


def test_load_rules_merges_and_overrides_by_name(tmp_path: Path):
    rules_dir = tmp_path / "rules"
    rules_dir.mkdir()
    (rules_dir / "default.json").write_text(
        json.dumps(
            [
                {
                    "id": "r1",
                    "name": "tool_failed_alert",
                    "event_type": "tool.exec.failed",
                    "action_mode": "suggest",
                    "actions": [{"action_type": "notify"}],
                    "priority": 10,
                }
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (rules_dir / "custom.json").write_text(
        json.dumps(
            [
                {
                    "id": "r1_custom",
                    "name": "tool_failed_alert",
                    "event_type": "tool.exec.failed",
                    "action_mode": "ask",
                    "actions": [{"action_type": "notify"}],
                    "priority": 20,
                    "is_active": False,
                }
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    rules = load_rules(rules_dir)
    assert len(rules) == 1
    assert rules[0].name == "tool_failed_alert"
    assert rules[0].action_mode == "ask"
    assert rules[0].is_active is False


def test_set_rule_active_updates_json(tmp_path: Path):
    rules_file = tmp_path / "rules.json"
    rules_file.write_text(
        json.dumps(
            [
                {
                    "id": "rule_test",
                    "name": "rule_test",
                    "event_type": "chat.message.received",
                    "action_mode": "auto",
                    "actions": [{"action_type": "notify"}],
                    "is_active": True,
                }
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    updated = set_rule_active(rules_file, "rule_test", active=False)
    assert updated is True
    rules = load_rules(rules_file)
    assert len(rules) == 1
    assert rules[0].is_active is False
