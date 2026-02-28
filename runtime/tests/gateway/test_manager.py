"""Unit-ish tests for GatewayManager service layer."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from src.events.event_engine import EventEngine
from src.events.event_router import EventRouter, NoopActionExecutor
from src.events.event_store import EventStore
from src.events.models import Event
from src.gateway.context_service import GatewayContextService
from src.gateway.manager import GatewayManager, GatewayManagerError
from src.server.config_store import RuntimeConfigStore


def _write_rules(path: Path) -> None:
    path.write_text(
        json.dumps(
            [
                {
                    "id": "rule_chat_message",
                    "name": "rule_chat_message",
                    "event_type": "chat.message.received",
                    "action_mode": "suggest",
                    "actions": [{"action_type": "notify"}],
                    "is_active": True,
                },
                {
                    "id": "rule_high",
                    "name": "rule_high",
                    "event_type": "fund.transfer",
                    "action_mode": "auto",
                    "risk_level": "high",
                    "actions": [{"action_type": "notify"}],
                    "is_active": True,
                },
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


def _build_manager(
    *,
    db_path: Path,
    rules_path: Path,
    telegram_send_fn=None,
) -> GatewayManager:
    config_store = RuntimeConfigStore(db_path=str(db_path))
    engine = EventEngine(
        store=EventStore(db_path=str(db_path)),
        router=EventRouter(NoopActionExecutor()),
        rules_path=str(rules_path),
    )

    async def _task_runner(**kwargs: Any) -> dict[str, Any]:
        task = str(kwargs.get("task") or "")
        return {
            "status": "success",
            "task": task,
            "session_id": kwargs.get("session_id"),
            "agent_id": kwargs.get("agent_id"),
            "final_response": f"done: {task}",
            "runtime_events": [],
            "error": None,
        }

    gateway_context = GatewayContextService(
        db_path=str(db_path),
        config_store=config_store,
        task_runner=_task_runner,
        runtime_db_path=str(db_path),
        rules_path=str(rules_path),
    )
    return GatewayManager(
        config_store=config_store,
        gateway_context=gateway_context,
        engine=engine,
        telegram_send_fn=telegram_send_fn,
    )


@pytest.mark.asyncio
async def test_gateway_manager_config_and_test_send(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    sent: list[dict[str, Any]] = []

    async def _send(token: str, payload: dict[str, Any], timeout: float) -> None:
        sent.append({"token": token, "payload": payload, "timeout": timeout})

    manager = _build_manager(db_path=db_path, rules_path=rules_path, telegram_send_fn=_send)
    listing = manager.list_gateway_configs()
    providers = {item["provider"] for item in listing}
    assert providers == {"feishu", "telegram"}

    updated = manager.upsert_gateway_config(
        "telegram",
        {
            "isActive": True,
            "config": {
                "botToken": "123456:abc",
                "defaultChatId": "-100001",
            },
        },
    )
    assert updated["status"] == "ready"
    assert updated["config"]["botToken"] == "***"

    result = await manager.test_gateway("telegram", {"text": "gateway test"})
    assert result["sent"] is True
    assert len(sent) == 1
    assert sent[0]["payload"]["chat_id"] == "-100001"
    assert sent[0]["payload"]["text"] == "gateway test"

    with pytest.raises(GatewayManagerError) as exc:
        manager.get_gateway_config("unknown")
    assert exc.value.detail == "unsupported_gateway_provider"


@pytest.mark.asyncio
async def test_gateway_manager_telegram_ingest_with_addressing_policy(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    sent: list[dict[str, Any]] = []

    async def _send(token: str, payload: dict[str, Any], timeout: float) -> None:
        sent.append({"token": token, "payload": payload, "timeout": timeout})

    manager = _build_manager(db_path=db_path, rules_path=rules_path, telegram_send_fn=_send)
    manager.upsert_gateway_config(
        "telegram",
        {
            "isActive": True,
            "config": {
                "botToken": "123456:abc",
                "addressingPolicy": {"mode": "mention_only", "executeOnUnaddressed": False},
            },
        },
    )

    no_exec = await manager.ingest_telegram_webhook(
        {
            "update_id": 1,
            "message": {
                "message_id": 100,
                "chat": {"id": -100001, "type": "supergroup"},
                "from": {"id": 7788},
                "text": "hello semibot",
            },
        },
        headers={},
    )
    assert no_exec["accepted"] is True
    assert no_exec["should_execute"] is False
    assert no_exec["task_run_id"] is None
    await asyncio.sleep(0.05)
    assert sent == []

    with_exec = await manager.ingest_telegram_webhook(
        {
            "update_id": 2,
            "message": {
                "message_id": 101,
                "chat": {"id": -100001, "type": "supergroup"},
                "from": {"id": 7788},
                "text": "@semibot hello again",
                "entities": [{"type": "mention", "offset": 0, "length": 8}],
            },
        },
        headers={},
    )
    assert with_exec["accepted"] is True
    assert with_exec["should_execute"] is True
    assert with_exec["task_run_id"] is not None

    await asyncio.sleep(0.05)
    assert sent[-1]["payload"]["chat_id"] == "-100001"
    assert sent[-1]["payload"]["text"] == "done: @semibot hello again"

    convs = manager.list_gateway_conversations(provider="telegram", limit=10)["data"]
    assert len(convs) == 1
    conv_id = convs[0]["conversation_id"]
    runs = manager.list_gateway_conversation_runs(conv_id, limit=10)["data"]
    assert len(runs) == 1


@pytest.mark.asyncio
async def test_gateway_manager_text_approval_command(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    manager = _build_manager(db_path=db_path, rules_path=rules_path)

    event = Event(
        event_id="evt_fund_1",
        event_type="fund.transfer",
        source="test",
        subject="session_a",
        payload={"amount": 12000, "session_id": "session_a"},
    )
    await manager.engine.emit(event)

    pending = manager.engine.list_approvals(status="pending", limit=10)
    assert len(pending) == 1
    approval_id = pending[0].approval_id

    result = await manager.handle_text_approval_command(
        text=f"同意 {approval_id}",
        source="telegram.gateway",
        subject="session_a",
        trace_payload={"from": "test"},
    )
    assert result is not None
    assert result["resolved"] is True
    assert result["status"] == "approved"
    assert result["approval_ids"] == [approval_id]

    approved = manager.engine.list_approvals(status="approved", limit=10)
    assert len(approved) == 1
    assert approved[0].approval_id == approval_id
