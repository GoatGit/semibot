"""Tests for rule_authoring builtin tool."""

from __future__ import annotations

from pathlib import Path

import pytest

from src.skills.rule_authoring import RuleAuthoringTool


@pytest.mark.asyncio
async def test_rule_authoring_tool_create_and_simulate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    rules_dir = tmp_path / "rules"
    db_path = tmp_path / "events.db"
    monkeypatch.setenv("SEMIBOT_RULES_PATH", str(rules_dir))
    monkeypatch.setenv("SEMIBOT_EVENTS_DB_PATH", str(db_path))
    tool = RuleAuthoringTool()

    created = await tool.execute(
        action="create_rule",
        payload={
            "name": "tool_rule_a",
            "event_type": "chat.message.received",
            "conditions": {"all": [{"field": "subject", "op": "exists", "value": True}]},
            "action_mode": "suggest",
            "actions": [{"action_type": "notify", "params": {"channel": "chat"}}],
            "risk_level": "low",
        },
    )
    assert created.success is True
    rule_id = created.result.get("id")
    assert isinstance(rule_id, str)

    simulated = await tool.execute(
        action="simulate_rule",
        payload={
            "rule_id": rule_id,
            "event": {
                "event_type": "chat.message.received",
                "source": "test",
                "subject": "sess_1",
                "payload": {"message": "hello"},
            },
        },
    )
    assert simulated.success is True
    assert simulated.result.get("matched") is True


@pytest.mark.asyncio
async def test_rule_authoring_tool_reports_service_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    rules_dir = tmp_path / "rules"
    db_path = tmp_path / "events.db"
    monkeypatch.setenv("SEMIBOT_RULES_PATH", str(rules_dir))
    monkeypatch.setenv("SEMIBOT_EVENTS_DB_PATH", str(db_path))
    tool = RuleAuthoringTool()

    result = await tool.execute(
        action="create_rule",
        payload={
            "name": "bad_mode",
            "event_type": "chat.message.received",
            "action_mode": "invalid",
            "actions": [{"action_type": "notify"}],
            "risk_level": "low",
        },
    )
    assert result.success is False
    assert "INVALID_ACTION_MODE" in (result.error or "")


@pytest.mark.asyncio
async def test_rule_authoring_tool_infers_action_when_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    rules_dir = tmp_path / "rules"
    db_path = tmp_path / "events.db"
    monkeypatch.setenv("SEMIBOT_RULES_PATH", str(rules_dir))
    monkeypatch.setenv("SEMIBOT_EVENTS_DB_PATH", str(db_path))
    tool = RuleAuthoringTool()

    # No explicit action: infer create_rule from payload shape.
    created = await tool.execute(
        payload={
            "name": "tool_rule_infer",
            "event_type": "chat.message.received",
            "conditions": {"all": []},
            "action_mode": "suggest",
            "actions": [{"action_type": "notify", "params": {"channel": "chat"}}],
            "risk_level": "low",
        },
    )
    assert created.success is True
    assert created.result.get("action") == "create_rule"


@pytest.mark.asyncio
async def test_rule_authoring_tool_accepts_legacy_create_payload(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    rules_dir = tmp_path / "rules"
    db_path = tmp_path / "events.db"
    monkeypatch.setenv("SEMIBOT_RULES_PATH", str(rules_dir))
    monkeypatch.setenv("SEMIBOT_EVENTS_DB_PATH", str(db_path))
    tool = RuleAuthoringTool()

    result = await tool.execute(
        action="create",
        payload={
            "rule_name": "每日10点新闻整理",
            "description": "每天早上10点触发，整理当日最新新闻并发送给用户",
            "trigger_type": "cron",
            "cron_expression": "0 10 * * *",
            "enabled": True,
        },
    )
    assert result.success is True
    assert result.result.get("action") == "create_rule"
    assert result.result.get("event_type") == "cron.job.tick"
