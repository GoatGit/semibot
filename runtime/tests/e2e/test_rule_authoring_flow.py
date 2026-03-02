"""E2E: chat-style flow -> rule_authoring tool -> approval -> rule effective."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from src.local_runtime import run_task_once
from src.orchestrator.state import PlanStep
from src.server.api import create_app

pytestmark = [pytest.mark.e2e, pytest.mark.e2e_collab, pytest.mark.e2e_approval]


class _RuleAuthoringGraph:
    def __init__(self, context: dict[str, Any], *, tool_params: dict[str, Any]):
        self._context = context
        self._tool_params = tool_params

    async def ainvoke(self, state: dict[str, Any]) -> dict[str, Any]:
        executor = self._context["unified_executor"]
        step = PlanStep(
            id="step_rule_create",
            title="create rule",
            tool="rule_authoring",
            params=self._tool_params,
        )
        result = await executor.execute(step)
        if result.success:
            content = f"rule created: {result.result.get('id') if isinstance(result.result, dict) else 'ok'}"
        else:
            content = result.error or "tool failed"
        return {
            "messages": [{"role": "assistant", "content": content, "name": None, "tool_call_id": None}],
            "tool_results": [result],
        }


def _write_rules(path: Path) -> None:
    path.write_text(json.dumps([], ensure_ascii=False), encoding="utf-8")


@pytest.mark.asyncio
async def test_e2e_rule_authoring_requires_then_resumes_after_approval(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    monkeypatch.setattr(
        "src.local_runtime.create_agent_graph",
        lambda context, runtime_context: _RuleAuthoringGraph(
            context,
            tool_params={
                "action": "create_rule",
                "payload": {
                    "name": "e2e_rule_from_tool",
                    "event_type": "chat.message.received",
                    "conditions": {"all": []},
                    "action_mode": "suggest",
                    "actions": [{"action_type": "notify", "params": {"channel": "chat"}}],
                    "risk_level": "low",
                    "priority": 60,
                    "dedupe_window_seconds": 10,
                    "cooldown_seconds": 20,
                    "attention_budget_per_day": 30,
                    "is_active": True,
                },
                "options": {"idempotency_key": "e2e-rule-create-1"},
            },
        ),
    )

    # First run: approval required for high-risk rule_authoring tool.
    first = await run_task_once(
        task="请帮我创建一条规则",
        db_path=str(db_path),
        rules_path=str(rules_path),
        session_id="sess_e2e_rule_authoring",
        agent_id="semibot",
    )
    assert first["status"] == "completed"
    assert "审批ID" in first["final_response"] or "approval" in first["final_response"].lower()
    first_tool_results = first["tool_results"]
    assert len(first_tool_results) == 1
    approval_id = (first_tool_results[0].get("metadata") or {}).get("approval_id")
    assert isinstance(approval_id, str) and approval_id.startswith("appr_")

    # Approve via runtime API.
    app = create_app(db_path=str(db_path), rules_path=str(rules_path))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        approve_resp = await client.post(f"/v1/approvals/{approval_id}/approve")
        assert approve_resp.status_code == 200
        assert approve_resp.json()["status"] == "approved"

    # Second run with same session and same tool action should continue and create rule.
    second = await run_task_once(
        task="继续执行创建规则",
        db_path=str(db_path),
        rules_path=str(rules_path),
        session_id="sess_e2e_rule_authoring",
        agent_id="semibot",
    )
    assert second["status"] == "completed"
    assert "rule created" in second["final_response"]

    # Verify rule is effective in runtime rule API.
    app = create_app(db_path=str(db_path), rules_path=str(rules_path))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        rules_resp = await client.get("/v1/rules")
        assert rules_resp.status_code == 200
        items = rules_resp.json()["items"]
        assert any(item["name"] == "e2e_rule_from_tool" for item in items)


@pytest.mark.asyncio
async def test_e2e_daily_news_rule_9am_created_after_approval(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    db_path = tmp_path / "events.db"
    rules_path = tmp_path / "rules.json"
    _write_rules(rules_path)

    monkeypatch.setattr(
        "src.local_runtime.create_agent_graph",
        lambda context, runtime_context: _RuleAuthoringGraph(
            context,
            tool_params={
                "action": "create_rule",
                "payload": {
                    "name": "daily_news_digest_9am",
                    "event_type": "cron.job.tick",
                    "conditions": {"all": []},
                    "action_mode": "suggest",
                    "actions": [
                        {
                            "action_type": "notify",
                            "params": {
                                "channel": "chat",
                                "summary": "每天早上9点整理当日最新新闻发给我",
                            },
                        }
                    ],
                    "risk_level": "low",
                    "priority": 80,
                    "dedupe_window_seconds": 300,
                    "cooldown_seconds": 600,
                    "attention_budget_per_day": 20,
                    "is_active": True,
                    "cron": {
                        "upsert": True,
                        "name": "daily_news_digest_9am_trigger",
                        "schedule": "0 9 * * *",
                        "event_type": "cron.job.tick",
                        "source": "system.cron",
                        "subject": "system",
                        "payload": {"trigger_name": "daily_news_digest_9am_trigger"},
                    },
                },
                "options": {"idempotency_key": "e2e-daily-news-rule-1"},
            },
        ),
    )

    first = await run_task_once(
        task="@semibot1_bot 每天早上9点整理当日最新新闻发给我。",
        db_path=str(db_path),
        rules_path=str(rules_path),
        session_id="sess_e2e_daily_news_rule",
        agent_id="semibot",
    )
    assert first["status"] == "completed"
    first_tool_results = first["tool_results"]
    assert len(first_tool_results) == 1
    approval_id = (first_tool_results[0].get("metadata") or {}).get("approval_id")
    assert isinstance(approval_id, str) and approval_id.startswith("appr_")

    app = create_app(db_path=str(db_path), rules_path=str(rules_path))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        approve_resp = await client.post(f"/v1/approvals/{approval_id}/approve")
        assert approve_resp.status_code == 200
        assert approve_resp.json()["status"] == "approved"

    second = await run_task_once(
        task="继续执行刚才的日报规则创建",
        db_path=str(db_path),
        rules_path=str(rules_path),
        session_id="sess_e2e_daily_news_rule",
        agent_id="semibot",
    )
    assert second["status"] == "completed"
    assert "rule created" in second["final_response"]

    app = create_app(db_path=str(db_path), rules_path=str(rules_path))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        rules_resp = await client.get("/v1/rules")
        assert rules_resp.status_code == 200
        items = rules_resp.json()["items"]
        target = next((item for item in items if item["name"] == "daily_news_digest_9am"), None)
        assert target is not None
        assert target["event_type"] == "cron.job.tick"

        cron_resp = await client.get("/v1/scheduler/cron-jobs")
        assert cron_resp.status_code == 200
        cron_items = cron_resp.json().get("data") or []
        cron_target = next((job for job in cron_items if job.get("name") == "daily_news_digest_9am_trigger"), None)
        assert cron_target is not None
        assert cron_target["schedule"] == "0 9 * * *"
