"""V2 end-to-end tests for scheduler and integration boundaries."""

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from src.server.api import create_app

pytestmark = [pytest.mark.e2e, pytest.mark.e2e_scheduler]


def _write_rules(path: Path) -> None:
    path.write_text(
        json.dumps(
            [
                {
                    "id": "rule_heartbeat_notify",
                    "name": "rule_heartbeat_notify",
                    "event_type": "health.heartbeat.tick",
                    "action_mode": "suggest",
                    "actions": [{"action_type": "log_only"}],
                    "is_active": True,
                },
                {
                    "id": "rule_cron_notify",
                    "name": "rule_cron_notify",
                    "event_type": "cron.ops.tick",
                    "action_mode": "auto",
                    "actions": [{"action_type": "notify", "params": {"title": "Cron Tick"}}],
                    "is_active": True,
                },
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


@pytest.mark.asyncio
async def test_e2e_background_heartbeat_and_cron(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    app = create_app(
        db_path=str(db_path),
        rules_path=str(rules_path),
        heartbeat_interval_seconds=0.02,
        cron_jobs=[
            {
                "name": "ops",
                "schedule": "@every:0.02",
                "event_type": "cron.ops.tick",
                "payload": {"from": "test"},
            }
        ],
    )

    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            await asyncio.sleep(0.1)

            hb = await client.get("/v1/events?event_type=health.heartbeat.tick&limit=20")
            assert hb.status_code == 200
            assert len(hb.json()["items"]) >= 2

            cron = await client.get("/v1/events?event_type=cron.ops.tick&limit=20")
            assert cron.status_code == 200
            assert len(cron.json()["items"]) >= 2


@pytest.mark.asyncio
async def test_e2e_live_delta_with_resume_from(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    app = create_app(db_path=str(db_path), rules_path=str(rules_path))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        for i in range(4):
            emit = await client.post(
                "/v1/events",
                json={"event_type": "cron.ops.tick", "source": "test", "payload": {"idx": i}},
            )
            assert emit.status_code == 200

        page_1 = await client.get("/v1/dashboard/events?event_type=cron.ops.tick&limit=2")
        assert page_1.status_code == 200
        cursor = page_1.json()["next_cursor"]
        assert cursor is not None

        live = await client.get(
            f"/v1/dashboard/live?interval=0.1&max_ticks=1&mode=delta&event_type=cron.ops.tick&resume_from={cursor}"
        )
        assert live.status_code == 200
        assert "\"stream_mode\": \"delta\"" in live.text


@pytest.mark.asyncio
async def test_e2e_feishu_url_verification_boundary(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    app = create_app(
        db_path=str(db_path),
        rules_path=str(rules_path),
        feishu_verify_token="verify_123",
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        unauthorized = await client.post(
            "/v1/integrations/feishu/events",
            json={"type": "url_verification", "challenge": "ok", "token": "wrong"},
        )
        assert unauthorized.status_code == 401

        authorized = await client.post(
            "/v1/integrations/feishu/events",
            json={"type": "url_verification", "challenge": "ok", "token": "verify_123"},
        )
        assert authorized.status_code == 200
        assert authorized.json()["challenge"] == "ok"
