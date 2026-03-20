"""V2 end-to-end tests for event -> rule -> action flow."""

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from src.server.api import create_app

pytestmark = [pytest.mark.e2e, pytest.mark.e2e_collab]


def _write_rules(path: Path) -> None:
    path.write_text(
        json.dumps(
            [
                {
                    "id": "rule_chat_notify",
                    "name": "rule_chat_notify",
                    "event_type": "chat.message.received",
                    "action_mode": "auto",
                    "actions": [
                        {
                            "action_type": "notify",
                            "params": {
                                "channel": "ops",
                                "title": "新群消息",
                                "content": "收到一条需要处理的群消息",
                            },
                        }
                    ],
                    "is_active": True,
                },
                {
                    "id": "rule_webhook_alert",
                    "name": "rule_webhook_alert",
                    "event_type": "ops.alert",
                    "action_mode": "auto",
                    "actions": [{"action_type": "notify"}],
                    "is_active": True,
                },
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


@pytest.mark.asyncio
async def test_e2e_chat_event_triggers_notify(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    sent: list[dict[str, Any]] = []

    async def _send(url: str, payload: dict[str, Any], timeout: float) -> None:
        sent.append({"url": url, "payload": payload, "timeout": timeout})

    app = create_app(
        db_path=str(db_path),
        rules_path=str(rules_path),
        feishu_webhook_urls={"default": "https://default/hook", "ops": "https://ops/hook"},
        feishu_send_fn=_send,
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        resp = await client.post(
            "/v1/events",
            json={
                "event_type": "chat.message.received",
                "source": "e2e",
                "subject": "chat:ops",
                "payload": {"text": "请处理今日库存异常"},
            },
        )
        assert resp.status_code == 200
        assert resp.json()["matched_rules"] == 1

        events = await client.get("/v1/events?event_type=chat.message.received&limit=5")
        assert events.status_code == 200
        assert len(events.json()["items"]) == 1

    assert len(sent) == 1
    assert sent[0]["url"] == "https://ops/hook"
    assert sent[0]["payload"]["card"]["header"]["title"]["content"] == "新群消息"


@pytest.mark.asyncio
async def test_e2e_webhook_to_rule_and_metrics(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    app = create_app(db_path=str(db_path), rules_path=str(rules_path))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        resp = await client.post(
            "/v1/webhooks/ops.alert",
            json={"source": "monitor", "subject": "service:a", "payload": {"error_rate": 0.8}},
        )
        assert resp.status_code == 200
        assert resp.json()["event_type"] == "ops.alert"
        assert resp.json()["matched_rules"] == 1

        metrics = await client.get("/v1/metrics/events")
        assert metrics.status_code == 200
        payload = metrics.json()
        assert payload["events_total"] >= 1
        assert payload["rule_runs_total"] >= 1

        runs = await client.get("/v1/dashboard/rule-runs?limit=10")
        assert runs.status_code == 200
        assert len(runs.json()["items"]) >= 1


@pytest.mark.asyncio
async def test_e2e_events_cursor_resume_flow(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    app = create_app(db_path=str(db_path), rules_path=str(rules_path))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        for i in range(3):
            resp = await client.post(
                "/v1/events",
                json={"event_type": "ops.alert", "source": "e2e", "payload": {"i": i}},
            )
            assert resp.status_code == 200

        first = await client.get("/v1/dashboard/events?limit=2")
        assert first.status_code == 200
        first_payload = first.json()
        assert len(first_payload["items"]) >= 1
        cursor = first_payload["next_cursor"]
        assert cursor is not None

        second = await client.get(f"/v1/dashboard/events?resume_from={cursor}&limit=10")
        assert second.status_code == 200
        second_payload = second.json()
        assert "items" in second_payload
