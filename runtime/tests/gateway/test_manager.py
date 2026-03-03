"""Unit-ish tests for GatewayManager service layer."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest

from src.events.event_engine import EventEngine
from src.events.event_router import EventRouter, NoopActionExecutor
from src.events.event_store import EventStore
from src.events.models import ApprovalRequest, Event
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
    telegram_send_document_fn=None,
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
        telegram_send_document_fn=telegram_send_document_fn,
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
async def test_gateway_manager_notify_routes_by_gateway_id_for_telegram(tmp_path: Path):
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
                "defaultChatId": "-100001",
            },
        },
    )

    await manager.handle_runtime_notify_payload(
        {
            "summary": "notify by gateway id",
            "gateway_id": "telegram:123456:-200002",
        }
    )
    assert len(sent) == 1
    assert sent[0]["payload"]["chat_id"] == "-200002"
    assert sent[0]["payload"]["text"] == "notify by gateway id"


@pytest.mark.asyncio
async def test_gateway_manager_test_gateway_telegram_with_files(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    file_path = tmp_path / "demo.pdf"
    file_path.write_bytes(b"%PDF-1.4 gateway test")

    sent_json: list[dict[str, Any]] = []
    sent_doc: list[dict[str, Any]] = []

    async def _send_json(token: str, payload: dict[str, Any], timeout: float) -> None:
        sent_json.append({"token": token, "payload": payload, "timeout": timeout})

    async def _send_doc(token: str, data: dict[str, Any], file_upload, timeout: float) -> None:
        sent_doc.append({"token": token, "data": data, "file_upload": file_upload, "timeout": timeout})

    manager = _build_manager(
        db_path=db_path,
        rules_path=rules_path,
        telegram_send_fn=_send_json,
        telegram_send_document_fn=_send_doc,
    )
    manager.upsert_gateway_config(
        "telegram",
        {
            "isActive": True,
            "config": {
                "botToken": "123456:abc",
                "defaultChatId": "-100001",
            },
        },
    )
    result = await manager.test_gateway(
        "telegram",
        {
            "text": "gateway file test",
            "files": [{"local_path": str(file_path), "filename": "demo.pdf", "mime_type": "application/pdf"}],
        },
    )
    assert result["sent"] is True
    assert sent_json == []
    assert len(sent_doc) == 1
    assert sent_doc[0]["data"]["chat_id"] == "-100001"


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
    assert "@semibot hello again" in sent[-1]["payload"]["text"]
    assert "gateway_id=telegram:" in sent[-1]["payload"]["text"]

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


@pytest.mark.asyncio
async def test_gateway_manager_text_approval_command_approves_all_in_subject_scope(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    manager = _build_manager(db_path=db_path, rules_path=rules_path)

    for idx in range(2):
        manager.engine.store.insert_approval(
            ApprovalRequest(
                approval_id=f"appr_{uuid4().hex[:12]}",
                rule_id="rule_high",
                event_id=f"evt_fund_scope_{idx}",
                risk_level="high",
                context={"chat_id": "chat_scope_1", "tool_name": "file_io", "action": "read"},
                status="pending",
                created_at=datetime.now(UTC),
            )
        )

    pending = manager.engine.list_approvals(status="pending", limit=10)
    assert len(pending) == 2

    result = await manager.handle_text_approval_command(
        text="同意",
        source="telegram.gateway",
        subject="chat_scope_1",
        trace_payload={"from": "test"},
    )
    assert result is not None
    assert result["resolved"] is True
    assert result["resolved_count"] == 2
    assert len(result["approval_ids"]) == 2

    approved = manager.engine.list_approvals(status="approved", limit=10)
    assert len(approved) == 2


@pytest.mark.asyncio
async def test_gateway_manager_text_approval_command_uses_approval_scope_hint(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    manager = _build_manager(db_path=db_path, rules_path=rules_path)

    scope_id = "gmsg_scope_1"
    other_scope_id = "gmsg_scope_2"
    for item_scope in (scope_id, scope_id, other_scope_id):
        manager.engine.store.insert_approval(
            ApprovalRequest(
                approval_id=f"appr_{uuid4().hex[:12]}",
                rule_id="tool.file_io",
                event_id=f"{item_scope}:{uuid4().hex[:8]}",
                risk_level="high",
                context={
                    "tool_name": "file_io",
                    "action": "read",
                    "approval_scope_id": item_scope,
                },
                status="pending",
                created_at=datetime.now(UTC),
            )
        )

    pending = manager.engine.list_approvals(status="pending", limit=20)
    assert len(pending) == 3

    result = await manager.handle_text_approval_command(
        text="同意",
        source="telegram.gateway",
        subject="-100001",
        trace_payload={"approval_scope_ids": [scope_id]},
    )
    assert result is not None
    assert result["resolved"] is True
    assert result["resolved_count"] == 2

    approved = manager.engine.list_approvals(status="approved", limit=20)
    assert len(approved) == 2
    assert all((item.context or {}).get("approval_scope_id") == scope_id for item in approved)

    pending_after = manager.engine.list_approvals(status="pending", limit=20)
    assert len(pending_after) == 1
    assert (pending_after[0].context or {}).get("approval_scope_id") == other_scope_id


@pytest.mark.asyncio
async def test_gateway_manager_multi_instance_create_update_delete(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    manager = _build_manager(db_path=db_path, rules_path=rules_path)

    created = manager.create_gateway_instance(
        {
            "provider": "telegram",
            "instanceKey": "tg-ops",
            "displayName": "Telegram Ops",
            "isActive": True,
            "config": {"botToken": "987654:token_ops"},
        }
    )
    assert created["provider"] == "telegram"
    assert created["instanceKey"] == "tg-ops"
    assert created["displayName"] == "Telegram Ops"

    listing = manager.list_gateway_instances("telegram")
    keys = {item.get("instanceKey") for item in listing}
    assert "tg-ops" in keys

    updated = manager.update_gateway_instance(
        str(created["id"]),
        {
            "displayName": "Telegram Ops V2",
            "isDefault": True,
            "config": {
                "defaultChatId": "-100001",
                "allowedChatIds": ["-100001", " -100002 ", "-100001"],
                "chatBindings": [
                    {"chatId": "-100001", "agentId": "ops"},
                    {"chatId": "-100001", "agentId": "ops-v2"},
                    {"chatId": "-100002", "agentId": "risk"},
                    {"chatId": "-100003", "agentId": ""},
                ],
            },
        },
    )
    assert updated["displayName"] == "Telegram Ops V2"
    assert updated["isDefault"] is True
    assert updated["config"]["allowedChatIds"] == ["-100001", "-100002"]
    assert updated["config"]["chatBindings"] == [
        {"chatId": "-100001", "agentId": "ops-v2"},
        {"chatId": "-100002", "agentId": "risk"},
    ]

    removed = manager.delete_gateway_instance(str(created["id"]))
    assert removed["deleted"] is True
