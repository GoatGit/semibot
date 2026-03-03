"""Tests for rule_authoring builtin tool."""

from __future__ import annotations

from pathlib import Path

import pytest

from src.server.config_store import RuntimeConfigStore
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
async def test_rule_authoring_tool_maps_notify_action_mode_to_suggest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rules_dir = tmp_path / "rules"
    db_path = tmp_path / "events.db"
    monkeypatch.setenv("SEMIBOT_RULES_PATH", str(rules_dir))
    monkeypatch.setenv("SEMIBOT_EVENTS_DB_PATH", str(db_path))
    tool = RuleAuthoringTool()

    created = await tool.execute(
        action="create_rule",
        payload={
            "name": "mode_notify_alias",
            "event_type": "chat.message.received",
            "conditions": {"all": []},
            "action_mode": "notify",
            "actions": [{"action_type": "notify", "params": {"channel": "chat"}}],
            "risk_level": "low",
        },
    )
    assert created.success is True


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
            "gateway_id": "telegram:bot:chat",
            "enabled": True,
        },
    )
    assert result.success is True
    assert result.result.get("action") == "create_rule"
    assert result.result.get("event_type") == "cron.job.tick"


@pytest.mark.asyncio
async def test_rule_authoring_tool_accepts_send_message_action_alias(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rules_dir = tmp_path / "rules"
    db_path = tmp_path / "events.db"
    monkeypatch.setenv("SEMIBOT_RULES_PATH", str(rules_dir))
    monkeypatch.setenv("SEMIBOT_EVENTS_DB_PATH", str(db_path))
    tool = RuleAuthoringTool()

    result = await tool.execute(
        action="send_message",
        payload={
            "rule_name": "5分钟喝水提醒",
            "description": "5分钟后提醒喝热水",
            "rule_condition": "cron",
            "cron_expression": "*/5 * * * *",
            "gateway_id": "telegram:bot:chat",
        },
    )
    assert result.success is True
    assert result.result.get("action") == "create_rule"
    assert result.result.get("event_type") == "cron.job.tick"


@pytest.mark.asyncio
async def test_rule_authoring_tool_rejects_non_cron_send_message_alias(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rules_dir = tmp_path / "rules"
    db_path = tmp_path / "events.db"
    monkeypatch.setenv("SEMIBOT_RULES_PATH", str(rules_dir))
    monkeypatch.setenv("SEMIBOT_EVENTS_DB_PATH", str(db_path))
    tool = RuleAuthoringTool()

    result = await tool.execute(
        action="send_message",
        payload={
            "name": "ask_doubao_now",
            "description": "帮我问下豆包怎么看美国总统访华",
            "actions": [{"action_type": "http_client", "params": {"url": "https://example.com"}}],
        },
    )
    assert result.success is False
    assert "unsupported action: send_message" in (result.error or "")


@pytest.mark.asyncio
async def test_rule_authoring_tool_infers_legacy_create_when_action_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rules_dir = tmp_path / "rules"
    db_path = tmp_path / "events.db"
    monkeypatch.setenv("SEMIBOT_RULES_PATH", str(rules_dir))
    monkeypatch.setenv("SEMIBOT_EVENTS_DB_PATH", str(db_path))
    tool = RuleAuthoringTool()

    result = await tool.execute(
        payload={
            "rule_name": "每日10点新闻整理",
            "rule_action": "send_message",
            "rule_condition": "cron",
            "cron_expression": "0 10 * * *",
            "description": "每天10点推送新闻摘要",
            "gateway_id": "telegram:bot:chat",
        }
    )
    assert result.success is True
    assert result.result.get("action") == "create_rule"
    assert result.result.get("event_type") == "cron.job.tick"


@pytest.mark.asyncio
async def test_rule_authoring_tool_infers_cron_from_text_when_schedule_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rules_dir = tmp_path / "rules"
    db_path = tmp_path / "events.db"
    monkeypatch.setenv("SEMIBOT_RULES_PATH", str(rules_dir))
    monkeypatch.setenv("SEMIBOT_EVENTS_DB_PATH", str(db_path))
    tool = RuleAuthoringTool()

    result = await tool.execute(
        action="create",
        payload={
            "rule_name": "站立活动提醒",
            "description": "3分钟后提醒我要站起来活动一下",
            "rule_condition": "cron",
            "gateway_id": "telegram:bot:chat",
            # intentionally no cron_expression/schedule
        },
    )
    assert result.success is True
    assert result.result.get("action") == "create_rule"
    assert result.result.get("event_type") == "cron.job.tick"

    store = RuntimeConfigStore(db_path=str(db_path))
    cron = store.get_cron_job("站立活动提醒")
    assert cron is not None
    assert cron.get("schedule") == "*/3 * * * *"
    cron_payload = cron.get("payload") if isinstance(cron.get("payload"), dict) else {}
    assert cron_payload.get("one_shot") is True


@pytest.mark.asyncio
async def test_rule_authoring_tool_normalizes_natural_language_explicit_schedule(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rules_dir = tmp_path / "rules"
    db_path = tmp_path / "events.db"
    monkeypatch.setenv("SEMIBOT_RULES_PATH", str(rules_dir))
    monkeypatch.setenv("SEMIBOT_EVENTS_DB_PATH", str(db_path))
    tool = RuleAuthoringTool()

    result = await tool.execute(
        action="create",
        payload={
            "rule_name": "14分钟后提醒",
            "description": "14分钟后提醒",
            "rule_condition": "cron",
            "gateway_id": "telegram:bot:chat",
            "cron_expression": "14分钟后",
        },
    )
    assert result.success is True
    store = RuntimeConfigStore(db_path=str(db_path))
    cron = store.get_cron_job("14分钟后提醒")
    assert cron is not None
    assert cron.get("schedule") == "*/14 * * * *"
    cron_payload = cron.get("payload") if isinstance(cron.get("payload"), dict) else {}
    assert cron_payload.get("one_shot") is True


@pytest.mark.asyncio
async def test_rule_authoring_tool_auto_resolves_name_conflict(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rules_dir = tmp_path / "rules"
    db_path = tmp_path / "events.db"
    monkeypatch.setenv("SEMIBOT_RULES_PATH", str(rules_dir))
    monkeypatch.setenv("SEMIBOT_EVENTS_DB_PATH", str(db_path))
    tool = RuleAuthoringTool()

    first = await tool.execute(
        action="create",
        payload={
            "rule_name": "重名提醒",
            "description": "每5分钟提醒",
            "rule_condition": "cron",
            "gateway_id": "telegram:bot:chat",
            "cron_expression": "*/5 * * * *",
        },
    )
    assert first.success is True

    second = await tool.execute(
        action="create",
        payload={
            "rule_name": "重名提醒",
            "description": "每5分钟提醒",
            "rule_condition": "cron",
            "gateway_id": "telegram:bot:chat",
            "cron_expression": "*/5 * * * *",
        },
    )
    assert second.success is True
    assert second.result.get("conflict_resolved") is True
    assert second.result.get("original_name") == "重名提醒"
    assert str(second.result.get("resolved_name") or "").startswith("重名提醒_")


@pytest.mark.asyncio
async def test_rule_authoring_tool_new_schema_relative_cron_defaults_to_one_shot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rules_dir = tmp_path / "rules"
    db_path = tmp_path / "events.db"
    monkeypatch.setenv("SEMIBOT_RULES_PATH", str(rules_dir))
    monkeypatch.setenv("SEMIBOT_EVENTS_DB_PATH", str(db_path))
    tool = RuleAuthoringTool()

    result = await tool.execute(
        action="create_rule",
        payload={
            "name": "relative_new_schema",
            "event_type": "cron.job.tick",
            "description": "3分钟后提醒我起来活动",
            "action_mode": "auto",
            "actions": [{"action_type": "notify", "params": {"channel": "chat", "gateway_id": "telegram:bot:chat"}}],
            "risk_level": "low",
            "cron": {
                "upsert": True,
                "name": "relative_new_schema",
                "schedule": "*/3 * * * *",
                "payload": {"trigger_name": "relative_new_schema"},
            },
        },
    )
    assert result.success is True
    store = RuntimeConfigStore(db_path=str(db_path))
    cron = store.get_cron_job("relative_new_schema")
    assert cron is not None
    cron_payload = cron.get("payload") if isinstance(cron.get("payload"), dict) else {}
    assert cron_payload.get("one_shot") is True


@pytest.mark.asyncio
async def test_rule_authoring_tool_new_schema_periodic_cron_keeps_recurring(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rules_dir = tmp_path / "rules"
    db_path = tmp_path / "events.db"
    monkeypatch.setenv("SEMIBOT_RULES_PATH", str(rules_dir))
    monkeypatch.setenv("SEMIBOT_EVENTS_DB_PATH", str(db_path))
    tool = RuleAuthoringTool()

    result = await tool.execute(
        action="create_rule",
        payload={
            "name": "periodic_new_schema",
            "event_type": "cron.job.tick",
            "description": "每3分钟提醒我起来活动",
            "action_mode": "auto",
            "actions": [{"action_type": "notify", "params": {"channel": "chat", "gateway_id": "telegram:bot:chat"}}],
            "risk_level": "low",
            "cron": {
                "upsert": True,
                "name": "periodic_new_schema",
                "schedule": "*/3 * * * *",
                "payload": {"trigger_name": "periodic_new_schema"},
            },
        },
    )
    assert result.success is True
    store = RuntimeConfigStore(db_path=str(db_path))
    cron = store.get_cron_job("periodic_new_schema")
    assert cron is not None
    cron_payload = cron.get("payload") if isinstance(cron.get("payload"), dict) else {}
    assert cron_payload.get("one_shot") is not True
