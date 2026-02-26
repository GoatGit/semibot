"""Tests for Semibot V2 CLI commands."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from src.cli import build_parser
from src.events.models import Event


def test_module_entrypoint_calls_cli_main(monkeypatch) -> None:
    called = {"ok": False}

    def _fake_main() -> None:
        called["ok"] = True

    monkeypatch.setattr("semibot.__main__.main", _fake_main)

    from semibot.__main__ import run

    run()
    assert called["ok"] is True


def test_run_command_executes_runtime(monkeypatch, capsys) -> None:
    async def _fake_run_task_once(**kwargs: Any) -> dict[str, Any]:
        assert kwargs["task"] == "研究阿里巴巴股票"
        return {
            "status": "completed",
            "session_id": "local_test",
            "agent_id": kwargs["agent_id"],
            "final_response": "报告已生成",
            "error": None,
            "tool_results": [{"tool_name": "pdf", "success": True}],
            "runtime_events": [],
            "llm_configured": False,
        }

    monkeypatch.setattr("src.cli.run_task_once", _fake_run_task_once)

    parser = build_parser()
    args = parser.parse_args(
        [
            "run",
            "研究阿里巴巴股票",
            "--agent-id",
            "fund-analyst",
        ]
    )
    exit_code = args.func(args)

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["mode"] == "run"
    assert payload["status"] == "completed"
    assert payload["final_response"] == "报告已生成"
    assert payload["agent_id"] == "fund-analyst"


def test_chat_single_turn_mode(monkeypatch, capsys) -> None:
    async def _fake_run_task_once(**kwargs: Any) -> dict[str, Any]:
        assert kwargs["task"] == "先做一版摘要"
        return {
            "status": "completed",
            "session_id": kwargs["session_id"],
            "agent_id": kwargs["agent_id"],
            "final_response": "好的，摘要如下。",
            "error": None,
            "tool_results": [],
            "runtime_events": [],
            "llm_configured": False,
        }

    monkeypatch.setattr("src.cli.run_task_once", _fake_run_task_once)

    parser = build_parser()
    args = parser.parse_args(["chat", "--message", "先做一版摘要"])
    exit_code = args.func(args)

    assert exit_code == 0
    output = capsys.readouterr().out
    assert "Chat session started" in output
    assert "好的，摘要如下。" in output


def test_run_command_returns_nonzero_on_failure(monkeypatch, capsys) -> None:
    async def _fake_run_task_once(**_kwargs: Any) -> dict[str, Any]:
        return {
            "status": "failed",
            "session_id": "local_test",
            "agent_id": "semibot",
            "final_response": "",
            "error": "LLM provider not configured",
            "tool_results": [],
            "runtime_events": [],
            "llm_configured": False,
        }

    monkeypatch.setattr("src.cli.run_task_once", _fake_run_task_once)

    parser = build_parser()
    args = parser.parse_args(["run", "hello"])
    exit_code = args.func(args)

    assert exit_code == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["status"] == "failed"
    assert payload["error"] == "LLM provider not configured"


def test_serve_command_calls_uvicorn(monkeypatch) -> None:
    captured: dict[str, Any] = {}

    def _fake_create_app(**kwargs: Any) -> str:
        captured["create_app"] = kwargs
        return "fake_app"

    def _fake_uvicorn_run(app: Any, **kwargs: Any) -> None:
        captured["uvicorn"] = {"app": app, **kwargs}

    monkeypatch.setattr("src.cli.create_app", _fake_create_app)
    monkeypatch.setattr("src.cli.uvicorn.run", _fake_uvicorn_run)

    parser = build_parser()
    args = parser.parse_args(
        [
            "serve",
            "--host",
            "0.0.0.0",
            "--port",
            "9000",
            "--heartbeat-interval",
            "15",
            "--cron-jobs-json",
            '[{"name":"daily","interval_seconds":60,"event_type":"demo.tick"}]',
        ]
    )
    exit_code = args.func(args)

    assert exit_code == 0
    assert captured["create_app"]["heartbeat_interval_seconds"] == 15.0
    assert captured["create_app"]["cron_jobs"] == [
        {"name": "daily", "interval_seconds": 60, "event_type": "demo.tick"}
    ]
    assert captured["uvicorn"]["app"] == "fake_app"
    assert captured["uvicorn"]["host"] == "0.0.0.0"
    assert captured["uvicorn"]["port"] == 9000


def test_init_command(monkeypatch, capsys) -> None:
    def _fake_ensure_runtime_home(**kwargs: Any) -> dict[str, Any]:
        assert "db_path" in kwargs
        assert "rules_path" in kwargs
        return {
            "home": "/tmp/.semibot",
            "db_path": kwargs["db_path"],
            "rules_path": kwargs["rules_path"],
            "skills_path": "/tmp/.semibot/skills",
            "config_path": "/tmp/.semibot/config.toml",
            "default_rule_file": "/tmp/.semibot/rules/default.json",
            "config_created": True,
        }

    monkeypatch.setattr("src.cli.ensure_runtime_home", _fake_ensure_runtime_home)

    parser = build_parser()
    args = parser.parse_args(["init"])
    exit_code = args.func(args)

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["mode"] == "init"
    assert payload["config_created"] is True


def test_skill_list_command(monkeypatch, capsys) -> None:
    class _FakeRegistry:
        def list_tools(self) -> list[str]:
            return ["code_executor", "pdf"]

        def list_skills(self) -> list[str]:
            return ["market-analyst"]

    monkeypatch.setattr("src.cli.create_default_registry", lambda: _FakeRegistry())

    parser = build_parser()
    args = parser.parse_args(["skill", "list"])
    exit_code = args.func(args)

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["resource"] == "skill"
    assert payload["tools"] == ["code_executor", "pdf"]
    assert payload["skills"] == ["market-analyst"]


def test_memory_search_command(monkeypatch, capsys) -> None:
    class _FakeStore:
        def __init__(self, db_path: str):
            self.db_path = db_path

        def list_events(self, limit: int = 100, event_type: str | None = None):
            del limit, event_type
            return [
                Event(
                    event_id="evt_1",
                    event_type="task.completed",
                    source="test",
                    subject="session:test",
                    payload={"summary": "Alibaba report generated"},
                    timestamp=datetime.now(UTC),
                    risk_hint="low",
                )
            ]

    monkeypatch.setattr("src.cli.EventStore", _FakeStore)

    parser = build_parser()
    args = parser.parse_args(["memory", "search", "Alibaba"])
    exit_code = args.func(args)

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["resource"] == "memory"
    assert payload["action"] == "search"
    assert payload["count"] == 1
