"""Tests for runtime RuleService."""

from __future__ import annotations

from pathlib import Path

import pytest

from src.services.rule_service import RuleService, RuleServiceError


def test_rule_service_create_update_delete_and_simulate(tmp_path: Path) -> None:
    rules_dir = tmp_path / "rules"
    db_path = tmp_path / "events.db"
    service = RuleService(rules_path=str(rules_dir), db_path=str(db_path))

    created = service.create_rule(
        {
            "name": "my_manual_rule",
            "event_type": "chat.message.received",
            "conditions": {"all": [{"field": "subject", "op": "exists", "value": True}]},
            "action_mode": "suggest",
            "actions": [{"action_type": "notify", "params": {"channel": "chat"}}],
            "risk_level": "low",
            "priority": 60,
            "dedupe_window_seconds": 10,
            "cooldown_seconds": 20,
            "attention_budget_per_day": 30,
            "is_active": True,
        }
    )
    assert created["id"].startswith("rule_")
    assert created["name"] == "my_manual_rule"

    updated = service.update_rule(created["id"], {"priority": 90})
    assert updated["priority"] == 90

    sim = service.simulate_rule(
        {
            "rule_id": created["id"],
            "event": {
                "event_type": "chat.message.received",
                "source": "test",
                "subject": "sess_1",
                "payload": {"message": "hello"},
            },
        }
    )
    assert sim["matched"] is True
    assert sim["decision"] == "suggest"

    disabled = service.disable_rule(created["id"])
    assert disabled["active"] is False
    enabled = service.enable_rule(created["id"])
    assert enabled["active"] is True

    deleted = service.delete_rule(created["id"])
    assert deleted["rule_id"] == created["id"]


def test_rule_service_cron_upsert_and_validation(tmp_path: Path) -> None:
    rules_dir = tmp_path / "rules"
    db_path = tmp_path / "events.db"
    service = RuleService(rules_path=str(rules_dir), db_path=str(db_path))

    created = service.create_rule(
        {
            "name": "workday_digest",
            "event_type": "cron.job.tick",
            "action_mode": "suggest",
            "actions": [{"action_type": "notify", "params": {"channel": "chat", "gateway_id": "telegram:bot:chat"}}],
            "risk_level": "low",
            "cron": {
                "upsert": True,
                "name": "workday_digest",
                "schedule": "0 9 * * 1-5",
                "source": "system.cron",
                "subject": "system",
            },
        }
    )
    assert created["event_type"] == "cron.job.tick"
    cron_jobs = service.config_store.list_cron_jobs(active_only=False)
    assert any(job["name"] == "workday_digest" for job in cron_jobs)

    with pytest.raises(RuleServiceError) as excinfo:
        service.create_rule(
            {
                "name": "bad_cron",
                "event_type": "cron.job.tick",
                "action_mode": "suggest",
                "actions": [{"action_type": "notify", "params": {"channel": "chat", "gateway_id": "telegram:bot:chat"}}],
                "risk_level": "low",
                "cron": {"upsert": True, "name": "bad_cron", "schedule": "bad cron"},
            }
        )
    assert excinfo.value.code == "INVALID_CRON_SCHEDULE"


def test_rule_service_cron_notify_requires_gateway_id(tmp_path: Path) -> None:
    rules_dir = tmp_path / "rules"
    db_path = tmp_path / "events.db"
    service = RuleService(rules_path=str(rules_dir), db_path=str(db_path))
    with pytest.raises(RuleServiceError) as excinfo:
        service.create_rule(
            {
                "name": "cron_notify_no_gateway",
                "event_type": "cron.job.tick",
                "action_mode": "auto",
                "actions": [{"action_type": "notify", "params": {"channel": "chat"}}],
                "risk_level": "low",
                "cron": {"upsert": True, "name": "cron_notify_no_gateway", "schedule": "*/5 * * * *"},
            }
        )
    assert excinfo.value.code == "INVALID_NOTIFY_TARGET"


def test_rule_service_cron_notify_auto_uses_single_active_gateway(tmp_path: Path) -> None:
    rules_dir = tmp_path / "rules"
    db_path = tmp_path / "events.db"
    service = RuleService(rules_path=str(rules_dir), db_path=str(db_path))
    gw = service.config_store.create_gateway_instance(
        {
            "provider": "telegram",
            "display_name": "tg-main",
            "is_active": True,
            "is_default": True,
            "config": {
                "botToken": "8646880953:abc",
                "defaultChatId": "-5223952677",
            },
        }
    )
    assert gw["is_active"] is True

    created = service.create_rule(
        {
            "name": "cron_notify_auto_gateway",
            "event_type": "cron.job.tick",
            "action_mode": "auto",
            "actions": [{"action_type": "notify", "params": {"channel": "chat"}}],
            "risk_level": "low",
            "cron": {"upsert": True, "name": "cron_notify_auto_gateway", "schedule": "*/5 * * * *"},
        }
    )
    assert created["actions"][0]["params"]["gateway_id"] == "telegram:8646880953:-5223952677"
