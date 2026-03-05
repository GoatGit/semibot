"""Tests for planner capability filter of rule_authoring."""

from __future__ import annotations

from src.orchestrator.nodes import _filter_rule_authoring_by_intent


def _names(schemas: list[dict]) -> list[str]:
    return [str((item.get("function") or {}).get("name") or "") for item in schemas]


def test_filter_rule_authoring_removed_for_normal_chat() -> None:
    schemas = [
        {"function": {"name": "rule_authoring"}},
        {"function": {"name": "control_plane"}},
        {"function": {"name": "browser_automation"}},
    ]
    filtered = _filter_rule_authoring_by_intent(schemas, "帮我问下豆包怎么看美国总统访华")
    names = _names(filtered)
    assert "rule_authoring" not in names
    assert "control_plane" not in names
    assert "browser_automation" in names


def test_filter_rule_authoring_kept_for_reminder_intent() -> None:
    schemas = [
        {"function": {"name": "rule_authoring"}},
        {"function": {"name": "control_plane"}},
        {"function": {"name": "browser_automation"}},
    ]
    filtered = _filter_rule_authoring_by_intent(schemas, "3分钟后提醒我站起来活动一下")
    names = _names(filtered)
    assert "rule_authoring" in names
    assert "control_plane" in names
