"""Tests for Feishu gateway ingestion endpoints."""

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
async def test_feishu_url_verification_and_token_guard(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    app = create_app(
        db_path=str(db_path),
        rules_path=str(rules_path),
        feishu_verify_token="token_123",
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        unauthorized = await client.post(
            "/v1/integrations/feishu/events",
            json={"type": "url_verification", "challenge": "abc", "token": "bad"},
        )
        assert unauthorized.status_code == 401

        authorized = await client.post(
            "/v1/integrations/feishu/events",
            json={"type": "url_verification", "challenge": "abc", "token": "token_123"},
        )
        assert authorized.status_code == 200
        assert authorized.json()["challenge"] == "abc"


@pytest.mark.asyncio
async def test_feishu_message_event_ingestion(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    app = create_app(
        db_path=str(db_path),
        rules_path=str(rules_path),
        feishu_verify_token="token_123",
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        resp = await client.post(
            "/v1/integrations/feishu/events",
            json={
                "token": "token_123",
                "header": {
                    "event_id": "evt_f_001",
                    "event_type": "im.message.receive_v1",
                },
                "event": {
                    "sender": {"sender_id": {"open_id": "ou_xxx"}},
                    "message": {
                        "message_id": "om_xxx",
                        "chat_id": "oc_group_001",
                        "chat_type": "group",
                        "message_type": "text",
                        "content": "{\"text\":\"hello semibot\"}",
                    },
                },
            },
        )
        assert resp.status_code == 200
        payload = resp.json()
        assert payload["accepted"] is True
        assert payload["event_type"] == "chat.message.received"
        assert payload["matched_rules"] == 1

        event_id = payload["event_id"]
        get_event = await client.get(f"/v1/events/{event_id}")
        assert get_event.status_code == 200
        data = get_event.json()
        assert data["subject"] == "oc_group_001"
        assert data["payload"]["content"]["text"] == "hello semibot"


@pytest.mark.asyncio
async def test_feishu_card_action_resolves_approval(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    app = create_app(
        db_path=str(db_path),
        rules_path=str(rules_path),
        feishu_verify_token="token_123",
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        emit_resp = await client.post(
            "/v1/events",
            json={"event_type": "fund.transfer", "payload": {"amount": 12000}, "source": "test"},
        )
        assert emit_resp.status_code == 200

        pending = await client.get("/v1/approvals?status=pending")
        assert pending.status_code == 200
        approval_id = pending.json()["items"][0]["approval_id"]

        card_resp = await client.post(
            "/v1/integrations/feishu/card-actions",
            json={
                "token": "token_123",
                "operator": {"open_id": "ou_reviewer"},
                "action": {"value": {"approval_id": approval_id, "decision": "approve", "trace_id": "trace_42"}},
            },
        )
        assert card_resp.status_code == 200
        card_payload = card_resp.json()
        assert card_payload["resolved"] is True
        assert card_payload["status"] == "approved"

        approved = await client.get("/v1/approvals?status=approved")
        assert approved.status_code == 200
        assert len(approved.json()["items"]) == 1

        card_events = await client.get("/v1/events?event_type=chat.card.action&limit=5")
        assert card_events.status_code == 200
        assert len(card_events.json()["items"]) == 1
        assert card_events.json()["items"][0]["payload"]["trace_id"] == "trace_42"


@pytest.mark.asyncio
async def test_feishu_outbound_test_endpoint(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    sent: list[dict] = []

    async def _send(url: str, payload: dict, timeout: float) -> None:
        sent.append({"url": url, "payload": payload, "timeout": timeout})

    app = create_app(
        db_path=str(db_path),
        rules_path=str(rules_path),
        feishu_webhook_url="https://example.com/hook",
        feishu_send_fn=_send,
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        resp = await client.post(
            "/v1/integrations/feishu/outbound/test",
            json={"title": "hello", "content": "world", "channel": "default"},
        )
        assert resp.status_code == 200
        assert resp.json()["sent"] is True
        assert len(sent) == 1
        assert sent[0]["url"] == "https://example.com/hook"
        assert sent[0]["payload"]["card"]["header"]["title"]["content"] == "hello"


@pytest.mark.asyncio
async def test_rule_notify_action_routes_to_feishu(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    rules_path.write_text(
        json.dumps(
            [
                {
                    "id": "rule_notify_ops",
                    "name": "rule_notify_ops",
                    "event_type": "ops.alert",
                    "action_mode": "auto",
                    "actions": [
                        {
                            "action_type": "notify",
                            "params": {
                                "channel": "ops",
                                "title": "OPS告警",
                                "content": "请检查队列积压",
                            },
                        }
                    ],
                    "is_active": True,
                }
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    sent: list[dict] = []

    async def _send(url: str, payload: dict, timeout: float) -> None:
        sent.append({"url": url, "payload": payload, "timeout": timeout})

    app = create_app(
        db_path=str(db_path),
        rules_path=str(rules_path),
        feishu_webhook_urls={"default": "https://default/hook", "ops": "https://ops/hook"},
        feishu_send_fn=_send,
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        emit_resp = await client.post(
            "/v1/events",
            json={"event_type": "ops.alert", "payload": {"level": "high"}, "source": "monitor"},
        )
        assert emit_resp.status_code == 200
        assert emit_resp.json()["matched_rules"] == 1

    assert len(sent) == 1
    assert sent[0]["url"] == "https://ops/hook"
    assert sent[0]["payload"]["card"]["header"]["title"]["content"] == "OPS告警"
