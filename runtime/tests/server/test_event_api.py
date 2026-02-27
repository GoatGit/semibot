"""Tests for Event API endpoints."""

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
                    "id": "rule_manual_notify",
                    "name": "rule_manual_notify",
                    "event_type": "manual.event",
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
async def test_event_api_emit_and_list(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    app = create_app(db_path=str(db_path), rules_path=str(rules_path))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        emit_resp = await client.post(
            "/v1/events",
            json={"event_type": "manual.event", "payload": {"k": "v"}, "source": "test"},
        )
        assert emit_resp.status_code == 200
        assert emit_resp.json()["matched_rules"] == 1

        list_resp = await client.get("/v1/events?event_type=manual.event")
        assert list_resp.status_code == 200
        items = list_resp.json()["items"]
        assert len(items) == 1
        assert items[0]["payload"]["k"] == "v"

        webhook_resp = await client.post(
            "/v1/webhooks/manual.event",
            json={"subject": "chat:group_1", "payload": {"channel": "feishu"}},
        )
        assert webhook_resp.status_code == 200
        assert webhook_resp.json()["event_type"] == "manual.event"
        assert webhook_resp.json()["matched_rules"] == 1

        heartbeat_resp = await client.post(
            "/v1/system/heartbeat", json={"payload": {"node": "local"}}
        )
        assert heartbeat_resp.status_code == 200
        heartbeat_event_id = heartbeat_resp.json()["event_id"]
        loaded_heartbeat = await client.get(f"/v1/events/{heartbeat_event_id}")
        assert loaded_heartbeat.status_code == 200
        assert loaded_heartbeat.json()["event_type"] == "health.heartbeat.manual"

        metrics_resp = await client.get("/v1/metrics/events")
        assert metrics_resp.status_code == 200
        assert metrics_resp.json()["events_total"] >= 1

        summary_resp = await client.get("/v1/dashboard/summary")
        assert summary_resp.status_code == 200
        assert "events_total" in summary_resp.json()

        runs_resp = await client.get("/v1/dashboard/rule-runs")
        assert runs_resp.status_code == 200
        assert isinstance(runs_resp.json()["items"], list)

        queue_resp = await client.get("/v1/dashboard/queue")
        assert queue_resp.status_code == 200
        assert "queued_depth" in queue_resp.json()

        stream_resp = await client.get("/v1/dashboard/events?limit=10")
        assert stream_resp.status_code == 200
        stream_payload = stream_resp.json()
        assert len(stream_payload["items"]) >= 1
        assert stream_payload["next_cursor"] is not None
        first_cursor = stream_payload["next_cursor"]

        await client.post(
            "/v1/events",
            json={"event_type": "manual.event", "payload": {"k": "v2"}, "source": "test"},
        )
        await client.post(
            "/v1/events",
            json={"event_type": "task.failed", "payload": {"reason": "x"}, "source": "test"},
        )

        stream_resp_2 = await client.get(f"/v1/dashboard/events?limit=10&cursor={first_cursor}")
        assert stream_resp_2.status_code == 200
        stream_payload_2 = stream_resp_2.json()
        assert len(stream_payload_2["items"]) >= 1
        assert stream_payload_2["next_cursor"] is not None

        stream_resp_2_alias = await client.get(
            f"/v1/dashboard/events?limit=10&resume_from={first_cursor}"
        )
        assert stream_resp_2_alias.status_code == 200
        assert stream_resp_2_alias.json()["items"] == stream_payload_2["items"]

        stream_resp_3 = await client.get(
            "/v1/dashboard/events?limit=20&event_types=manual.event,task.failed"
        )
        assert stream_resp_3.status_code == 200
        stream_payload_3 = stream_resp_3.json()
        types = {item["event_type"] for item in stream_payload_3["items"]}
        assert "manual.event" in types or "task.failed" in types

        list_multi_resp = await client.get("/v1/events?event_types=manual.event,task.failed")
        assert list_multi_resp.status_code == 200
        listed_types = {item["event_type"] for item in list_multi_resp.json()["items"]}
        assert listed_types.issubset({"manual.event", "task.failed"})

        live_resp = await client.get("/v1/dashboard/live?interval=0.1&max_ticks=2")
        assert live_resp.status_code == 200
        assert "text/event-stream" in live_resp.headers.get("content-type", "")
        assert "data:" in live_resp.text
        assert '"events"' in live_resp.text
        assert '"next_cursor"' in live_resp.text
        assert '"stream_mode": "snapshot"' in live_resp.text
        assert '"stream_mode": "delta"' in live_resp.text

        live_delta_resp = await client.get(
            "/v1/dashboard/live?interval=0.1&max_ticks=1&channels=summary,queue&delta_only=true&mode=delta"
        )
        assert live_delta_resp.status_code == 200
        assert '"summary"' in live_delta_resp.text
        assert '"queue_state"' in live_delta_resp.text
        assert '"stream_mode": "delta"' in live_delta_resp.text


@pytest.mark.asyncio
async def test_event_api_health_and_skills(tmp_path: Path, monkeypatch):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    class _FakeRegistry:
        def list_tools(self) -> list[str]:
            return ["code_executor", "pdf"]

        def list_skills(self) -> list[str]:
            return ["analyst"]

    monkeypatch.setattr("src.server.api.create_default_registry", lambda: _FakeRegistry())

    app = create_app(db_path=str(db_path), rules_path=str(rules_path))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        health = await client.get("/health")
        assert health.status_code == 200
        assert health.json()["ok"] is True

        skills = await client.get("/v1/skills")
        assert skills.status_code == 200
        assert skills.json()["tools"] == ["code_executor", "pdf"]
        assert skills.json()["skills"] == ["analyst"]


@pytest.mark.asyncio
async def test_event_api_sessions_agents_and_memory_endpoints(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    app = create_app(db_path=str(db_path), rules_path=str(rules_path))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.post(
            "/v1/events",
            json={
                "event_type": "chat.message.received",
                "payload": {"session_id": "sess_1", "agent_id": "agent_a", "message": "hi"},
                "source": "test",
            },
        )
        await client.post(
            "/v1/events",
            json={
                "event_type": "task.completed",
                "payload": {"session_id": "sess_1", "agent_id": "agent_a"},
                "source": "test",
            },
        )

        sessions = await client.get("/v1/sessions")
        assert sessions.status_code == 200
        assert any(item["session_id"] == "sess_1" for item in sessions.json()["items"])

        agents = await client.get("/v1/agents")
        assert agents.status_code == 200
        assert any(item["agent_id"] == "agent_a" for item in agents.json()["items"])

        delete_resp = await client.delete("/v1/sessions/sess_1")
        assert delete_resp.status_code == 200
        assert delete_resp.json()["deleted"] is True

        memories = await client.get("/v1/memories/search", params={"query": "sess_1"})
        assert memories.status_code == 200
        assert memories.json()["query"] == "sess_1"
        assert len(memories.json()["items"]) >= 1
        assert memories.json()["items"][0]["event_type"] in {
            "chat.message.received",
            "task.completed",
            "session.deleted",
        }

        install = await client.post(
            "/v1/skills/install", json={"source": "https://example.com/repo"}
        )
        assert install.status_code == 200
        assert install.json()["accepted"] is False


@pytest.mark.asyncio
async def test_event_api_run_task_endpoint(tmp_path: Path, monkeypatch):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    async def _fake_run_task_once(**kwargs):
        assert kwargs["task"] == "研究阿里巴巴"
        assert kwargs["db_path"] == str(db_path)
        assert kwargs["rules_path"] == str(rules_path)
        return {
            "status": "completed",
            "session_id": "sess_demo",
            "agent_id": kwargs["agent_id"],
            "final_response": "完成",
            "error": None,
            "tool_results": [],
            "runtime_events": [],
            "llm_configured": False,
        }

    monkeypatch.setattr("src.server.api.run_task_once", _fake_run_task_once)

    app = create_app(db_path=str(db_path), rules_path=str(rules_path))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        resp = await client.post(
            "/v1/tasks/run",
            json={"task": "研究阿里巴巴", "agent_id": "analyst"},
        )
        assert resp.status_code == 200
        payload = resp.json()
        assert payload["task"] == "研究阿里巴巴"
        assert payload["status"] == "completed"
        assert payload["agent_id"] == "analyst"
        assert payload["final_response"] == "完成"


@pytest.mark.asyncio
async def test_event_api_chat_endpoint(tmp_path: Path, monkeypatch):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    async def _fake_run_task_once(**kwargs):
        return {
            "status": "completed",
            "session_id": kwargs.get("session_id") or "sess_chat",
            "agent_id": kwargs["agent_id"],
            "final_response": "你好，我已完成。",
            "error": None,
            "tool_results": [{"tool_name": "pdf", "success": True}],
            "runtime_events": [{"event": "rule.notify", "data": {"x": 1}}],
            "llm_configured": False,
        }

    monkeypatch.setattr("src.server.api.run_task_once", _fake_run_task_once)

    app = create_app(db_path=str(db_path), rules_path=str(rules_path))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        non_stream = await client.post("/api/v1/chat/start", json={"message": "你好"})
        assert non_stream.status_code == 200
        payload = non_stream.json()
        assert payload["status"] == "completed"
        assert payload["final_response"] == "你好，我已完成。"

        stream = await client.post(
            "/api/v1/chat/sessions/sess_fixed",
            json={"message": "你好", "stream": True},
        )
        assert stream.status_code == 200
        assert "text/event-stream" in stream.headers.get("content-type", "")
        text = stream.text
        assert "event" in text
        assert "done" in text
        assert "你好，我已完成。" in text


@pytest.mark.asyncio
async def test_event_api_approval_endpoints(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    app = create_app(db_path=str(db_path), rules_path=str(rules_path))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        emit_resp = await client.post(
            "/v1/events",
            json={"event_type": "fund.transfer", "payload": {"amount": 10_000}, "source": "test"},
        )
        assert emit_resp.status_code == 200

        approvals = (await client.get("/v1/approvals?status=pending")).json()["items"]
        assert len(approvals) == 1
        assert isinstance(approvals[0].get("context"), dict)
        approval_id = approvals[0]["approval_id"]

        approve_resp = await client.post(f"/v1/approvals/{approval_id}/approve")
        assert approve_resp.status_code == 200
        assert approve_resp.json()["status"] == "approved"

        approvals = (await client.get("/v1/approvals?status=approved")).json()["items"]
        assert len(approvals) == 1


@pytest.mark.asyncio
async def test_webhook_chat_message_can_resolve_approval_by_text(tmp_path: Path):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)
    app = create_app(db_path=str(db_path), rules_path=str(rules_path))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        emit_resp = await client.post(
            "/v1/events",
            json={"event_type": "fund.transfer", "payload": {"amount": 10001}, "source": "test"},
        )
        assert emit_resp.status_code == 200

        pending = (await client.get("/v1/approvals?status=pending")).json()["items"]
        assert len(pending) == 1
        approval_id = pending[0]["approval_id"]

        webhook = await client.post(
            "/v1/webhooks/chat.message.received",
            json={
                "source": "telegram.gateway",
                "subject": "tg_group_001",
                "payload": {"text": f"approve {approval_id}"},
            },
        )
        assert webhook.status_code == 200
        payload = webhook.json()
        assert payload["approval_command"]["resolved"] is True
        assert payload["approval_command"]["status"] == "approved"

        approved = (await client.get("/v1/approvals?status=approved")).json()["items"]
        assert len(approved) == 1


@pytest.mark.asyncio
async def test_event_api_background_heartbeat(tmp_path: Path):
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
            resp = await client.get("/v1/events?event_type=health.heartbeat.tick&limit=10")
            assert resp.status_code == 200
            assert len(resp.json()["items"]) >= 1
