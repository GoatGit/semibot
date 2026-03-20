"""V2 end-to-end tests for event-driven workflows."""

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from src.server.api import create_app

pytestmark = [pytest.mark.e2e]


def _write_rules(path: Path) -> None:
    path.write_text(
        json.dumps(
            [
                {
                    "id": "rule_chat_notify_ops",
                    "name": "rule_chat_notify_ops",
                    "event_type": "chat.message.received",
                    "action_mode": "auto",
                    "actions": [
                        {
                            "action_type": "notify",
                            "params": {
                                "channel": "ops",
                                "title": "群消息提醒",
                                "content": "收到群消息，请处理。",
                            },
                        }
                    ],
                    "is_active": True,
                },
                {
                    "id": "rule_fund_transfer_high",
                    "name": "rule_fund_transfer_high",
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
@pytest.mark.e2e_collab
async def test_v2_e2e_feishu_message_to_rule_notify(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    sent: list[dict[str, Any]] = []

    async def _send(url: str, payload: dict[str, Any], timeout: float) -> None:
        sent.append({"url": url, "payload": payload, "timeout": timeout})

    app = create_app(
        db_path=str(db_path),
        rules_path=str(rules_path),
        feishu_verify_token="token_123",
        feishu_webhook_urls={"default": "https://default/hook", "ops": "https://ops/hook"},
        feishu_send_fn=_send,
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        resp = await client.post(
            "/v1/integrations/feishu/events",
            json={
                "token": "token_123",
                "header": {"event_id": "evt_f_100", "event_type": "im.message.receive_v1"},
                "event": {
                    "message": {
                        "message_id": "om_100",
                        "chat_id": "oc_group_100",
                        "chat_type": "group",
                        "message_type": "text",
                        "content": "{\"text\":\"请处理本周销售数据\"}",
                    }
                },
            },
        )
        assert resp.status_code == 200
        payload = resp.json()
        assert payload["accepted"] is True
        assert payload["matched_rules"] == 1

        events_resp = await client.get("/v1/events?event_type=chat.message.received&limit=10")
        assert events_resp.status_code == 200
        assert len(events_resp.json()["items"]) == 1

    assert len(sent) == 1
    assert sent[0]["url"] == "https://ops/hook"
    assert sent[0]["payload"]["card"]["header"]["title"]["content"] == "群消息提醒"


@pytest.mark.asyncio
@pytest.mark.e2e_approval
async def test_v2_e2e_approval_flow_with_feishu_card_action(tmp_path: Path):
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
            json={"event_type": "fund.transfer", "payload": {"amount": 50000}, "source": "finance"},
        )
        assert emit_resp.status_code == 200
        assert emit_resp.json()["matched_rules"] == 1

        pending = await client.get("/v1/approvals?status=pending")
        assert pending.status_code == 200
        assert len(pending.json()["items"]) == 1
        approval_id = pending.json()["items"][0]["approval_id"]

        action_resp = await client.post(
            "/v1/integrations/feishu/card-actions",
            json={
                "token": "token_123",
                "action": {"value": {"approval_id": approval_id, "decision": "approve", "trace_id": "trace_e2e"}},
            },
        )
        assert action_resp.status_code == 200
        assert action_resp.json()["resolved"] is True
        assert action_resp.json()["status"] == "approved"
        assert action_resp.json()["approval_action_event_id"] is not None

        approved = await client.get("/v1/approvals?status=approved")
        assert approved.status_code == 200
        assert len(approved.json()["items"]) == 1

        card_events = await client.get("/v1/events?event_type=chat.card.action&limit=5")
        assert card_events.status_code == 200
        assert len(card_events.json()["items"]) == 1
        assert card_events.json()["items"][0]["payload"]["trace_id"] == "trace_e2e"

        approval_action_events = await client.get("/v1/events?event_type=approval.action&limit=5")
        assert approval_action_events.status_code == 200
        assert len(approval_action_events.json()["items"]) == 1
        assert approval_action_events.json()["items"][0]["payload"]["decision"] == "approved"


@pytest.mark.asyncio
@pytest.mark.e2e_dashboard
async def test_v2_e2e_live_dashboard_and_heartbeat(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    app = create_app(
        db_path=str(db_path),
        rules_path=str(rules_path),
        heartbeat_interval_seconds=0.02,
    )
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            await asyncio.sleep(0.08)
            heartbeat = await client.get("/v1/events?event_type=health.heartbeat.tick&limit=10")
            assert heartbeat.status_code == 200
            assert len(heartbeat.json()["items"]) >= 1

            live = await client.get(
                "/v1/dashboard/live?interval=0.1&max_ticks=2&channels=summary,events&mode=snapshot_delta"
            )
            assert live.status_code == 200
            text = live.text
            assert "\"stream_mode\": \"snapshot\"" in text
            assert "\"stream_mode\": \"delta\"" in text
