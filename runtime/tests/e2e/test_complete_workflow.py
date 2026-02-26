"""V2 end-to-end tests for complete collaboration workflow."""

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from src.server.api import create_app

pytestmark = [pytest.mark.e2e, pytest.mark.e2e_approval]


def _write_rules(path: Path) -> None:
    path.write_text(
        json.dumps(
            [
                {
                    "id": "rule_chat_supervisor",
                    "name": "rule_chat_supervisor",
                    "event_type": "chat.message.received",
                    "action_mode": "auto",
                    "actions": [{"action_type": "notify", "params": {"title": "Supervisor 收到新任务"}}],
                    "is_active": True,
                },
                {
                    "id": "rule_transfer_high",
                    "name": "rule_transfer_high",
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
async def test_e2e_complete_collab_flow(tmp_path: Path):
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
        feishu_webhook_url="https://default/hook",
        feishu_send_fn=_send,
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        inbound = await client.post(
            "/v1/integrations/feishu/events",
            json={
                "token": "token_123",
                "header": {"event_id": "evt_f_c1", "event_type": "im.message.receive_v1"},
                "event": {
                    "message": {
                        "message_id": "om_c1",
                        "chat_id": "oc_group_collab",
                        "chat_type": "group",
                        "message_type": "text",
                        "content": "{\"text\":\"请分析本周线索转化\"}",
                    }
                },
            },
        )
        assert inbound.status_code == 200
        assert inbound.json()["accepted"] is True
        assert inbound.json()["matched_rules"] == 1

        summary = await client.get("/v1/dashboard/summary")
        assert summary.status_code == 200
        assert summary.json()["events_total"] >= 1

        stream = await client.get("/v1/dashboard/live?interval=0.1&max_ticks=2&mode=snapshot_delta")
        assert stream.status_code == 200
        assert "\"stream_mode\": \"snapshot\"" in stream.text

    assert len(sent) >= 1


@pytest.mark.asyncio
async def test_e2e_high_risk_approval_complete_flow(tmp_path: Path):
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
            "/v1/events",
            json={"event_type": "fund.transfer", "source": "finance", "payload": {"amount": 99999}},
        )
        assert resp.status_code == 200
        assert resp.json()["matched_rules"] == 1

        approvals = await client.get("/v1/approvals?status=pending")
        assert approvals.status_code == 200
        assert len(approvals.json()["items"]) == 1
        approval_id = approvals.json()["items"][0]["approval_id"]

        resolve = await client.post(
            "/v1/integrations/feishu/card-actions",
            json={
                "token": "token_123",
                "action": {"value": {"approval_id": approval_id, "decision": "approve"}},
            },
        )
        assert resolve.status_code == 200
        assert resolve.json()["resolved"] is True
        assert resolve.json()["status"] == "approved"
        assert resolve.json()["approval_action_event_id"] is not None

        approved = await client.get("/v1/approvals?status=approved")
        assert approved.status_code == 200
        assert len(approved.json()["items"]) == 1
