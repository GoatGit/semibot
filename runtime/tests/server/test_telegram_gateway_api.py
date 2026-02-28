"""Tests for Telegram gateway config and ingestion endpoints."""

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from src.server.api import create_app


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


@pytest.mark.asyncio
async def test_gateway_config_endpoints_and_telegram_outbound_test(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    sent: list[dict] = []

    async def _send(token: str, payload: dict, timeout: float) -> None:
        sent.append({"token": token, "payload": payload, "timeout": timeout})

    app = create_app(
        db_path=str(db_path),
        rules_path=str(rules_path),
        telegram_send_fn=_send,
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        listing = await client.get("/v1/config/gateways")
        assert listing.status_code == 200
        providers = {item["provider"] for item in listing.json()["data"]}
        assert providers == {"feishu", "telegram"}

        update = await client.put(
            "/v1/config/gateways/telegram",
            json={
                "isActive": True,
                "config": {
                    "botToken": "token_abc",
                    "defaultChatId": "-100001",
                },
            },
        )
        assert update.status_code == 200
        assert update.json()["isActive"] is True
        assert update.json()["status"] == "ready"
        assert update.json()["config"]["botToken"] == "***"

        test_resp = await client.post(
            "/v1/integrations/telegram/outbound/test",
            json={"text": "hello"},
        )
        assert test_resp.status_code == 200
        assert test_resp.json()["sent"] is True
        assert len(sent) == 1
        assert sent[0]["token"] == "token_abc"
        assert sent[0]["payload"]["chat_id"] == "-100001"


@pytest.mark.asyncio
async def test_telegram_webhook_ingestion_and_text_approval(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    sent: list[dict] = []

    async def _send(token: str, payload: dict, timeout: float) -> None:
        sent.append({"token": token, "payload": payload, "timeout": timeout})

    async def _task_runner(**kwargs):
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

    app = create_app(
        db_path=str(db_path),
        rules_path=str(rules_path),
        telegram_send_fn=_send,
        task_runner=_task_runner,
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        enable = await client.put(
            "/v1/config/gateways/telegram",
            json={"isActive": True, "config": {"botToken": "token_abc", "defaultChatId": "-100001"}},
        )
        assert enable.status_code == 200

        emit_resp = await client.post(
            "/v1/events",
            json={"event_type": "fund.transfer", "payload": {"amount": 12000}, "source": "test"},
        )
        assert emit_resp.status_code == 200

        pending = await client.get("/v1/approvals?status=pending")
        assert pending.status_code == 200
        approval_id = pending.json()["items"][0]["approval_id"]

        approve_resp = await client.post(
            "/v1/integrations/telegram/webhook",
            json={
                "update_id": 1,
                "message": {
                    "message_id": 100,
                    "chat": {"id": -100001, "type": "supergroup"},
                    "from": {"id": 7788},
                    "text": f"同意 {approval_id}",
                },
            },
        )
        assert approve_resp.status_code == 200
        approve_payload = approve_resp.json()
        assert approve_payload["accepted"] is True
        assert approve_payload["approval_command"]["resolved"] is True
        assert approve_payload["approval_command"]["status"] == "approved"

        approved = await client.get("/v1/approvals?status=approved")
        assert approved.status_code == 200
        assert len(approved.json()["items"]) == 1

        normal_resp = await client.post(
            "/v1/integrations/telegram/webhook",
            json={
                "update_id": 2,
                "message": {
                    "message_id": 101,
                    "chat": {"id": -100001, "type": "supergroup"},
                    "from": {"id": 7788},
                    "text": "hello semibot",
                },
            },
        )
        assert normal_resp.status_code == 200
        assert normal_resp.json()["event_type"] == "chat.message.received"
        assert normal_resp.json()["matched_rules"] == 1
        await asyncio.sleep(0.05)
        assert len(sent) >= 1
        assert sent[-1]["payload"]["chat_id"] == "-100001"
        assert sent[-1]["payload"]["text"] == "done: hello semibot"

        emit_resp_2 = await client.post(
            "/v1/events",
            json={"event_type": "fund.transfer", "payload": {"amount": 22000}, "source": "test"},
        )
        assert emit_resp_2.status_code == 200
        pending_2 = await client.get("/v1/approvals?status=pending")
        approval_id_2 = pending_2.json()["items"][0]["approval_id"]
        callback_resp = await client.post(
            "/v1/integrations/telegram/webhook",
            json={
                "update_id": 3,
                "callback_query": {
                    "id": "cb_1",
                    "from": {"id": 7788},
                    "data": f"approve:{approval_id_2}",
                    "message": {
                        "message_id": 102,
                        "chat": {"id": -100001, "type": "supergroup"},
                    },
                },
            },
        )
        assert callback_resp.status_code == 200
        assert callback_resp.json()["event_type"] == "chat.card.action"
        assert callback_resp.json()["approval_command"]["resolved"] is True
        assert callback_resp.json()["approval_command"]["status"] == "approved"


@pytest.mark.asyncio
async def test_telegram_webhook_secret_guard(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    app = create_app(db_path=str(db_path), rules_path=str(rules_path))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        enable = await client.put(
            "/v1/config/gateways/telegram",
            json={
                "isActive": True,
                "config": {"botToken": "token_abc", "webhookSecret": "sec_123"},
            },
        )
        assert enable.status_code == 200

        denied = await client.post(
            "/v1/integrations/telegram/webhook",
            json={"update_id": 9, "message": {"message_id": 1, "chat": {"id": 1}, "text": "hello"}},
        )
        assert denied.status_code == 401

        accepted = await client.post(
            "/v1/integrations/telegram/webhook",
            json={"update_id": 10, "message": {"message_id": 2, "chat": {"id": 1}, "text": "hello"}},
            headers={"x-telegram-bot-api-secret-token": "sec_123"},
        )
        assert accepted.status_code == 200
        assert accepted.json()["accepted"] is True


@pytest.mark.asyncio
async def test_telegram_allowed_chat_ids_guard(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    app = create_app(db_path=str(db_path), rules_path=str(rules_path))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        enable = await client.put(
            "/v1/config/gateways/telegram",
            json={
                "isActive": True,
                "config": {
                    "botToken": "token_abc",
                    "allowedChatIds": ["-100001"],
                },
            },
        )
        assert enable.status_code == 200

        blocked = await client.post(
            "/v1/integrations/telegram/webhook",
            json={
                "update_id": 11,
                "message": {"message_id": 2, "chat": {"id": -100999}, "text": "hello"},
            },
        )
        assert blocked.status_code == 200
        assert blocked.json()["accepted"] is False
        assert blocked.json()["reason"] == "chat_not_allowed"

        allowed = await client.post(
            "/v1/integrations/telegram/webhook",
            json={
                "update_id": 12,
                "message": {"message_id": 3, "chat": {"id": -100001}, "text": "hello"},
            },
        )
        assert allowed.status_code == 200
        assert allowed.json()["accepted"] is True
