"""Tests for Semibot V2 CLI commands."""

from __future__ import annotations

import json
import re
import tomllib
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from src.cli import (
    _banner_lines,
    _default_log_level,
    _require_runtime_server,
    _sanitize_terminal_text,
    build_parser,
)
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
    monkeypatch.setattr("src.cli._require_runtime_server", lambda _url: None)

    def _fake_chat_start_via_runtime(
        args: Any,
        *,
        message: str,
        session_id: str | None,
        base_url: str,
    ) -> dict[str, Any]:
        assert args.agent_id == "fund-analyst"
        assert message == "研究阿里巴巴股票"
        assert session_id is None
        assert base_url == "http://127.0.0.1:8765"
        return {
            "status": "completed",
            "session_id": "local_test",
            "agent_id": args.agent_id,
            "final_response": "报告已生成",
            "error": None,
            "tool_results": [{"tool_name": "pdf", "success": True}],
            "runtime_events": [],
        }

    monkeypatch.setattr("src.cli._chat_start_via_runtime", _fake_chat_start_via_runtime)

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


def test_run_command_rejects_removed_local_runtime_options() -> None:
    parser = build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["run", "hello", "--model", "gpt-4o"])
    with pytest.raises(SystemExit):
        parser.parse_args(["run", "hello", "--system-prompt", "x"])
    with pytest.raises(SystemExit):
        parser.parse_args(["run", "hello", "--db-path", "/tmp/semibot.db"])
    with pytest.raises(SystemExit):
        parser.parse_args(["run", "hello", "--rules-path", "/tmp/rules"])


def test_chat_single_turn_mode(monkeypatch, capsys) -> None:
    monkeypatch.setattr("src.cli._require_runtime_server", lambda _url: None)

    def _fake_chat_start_via_runtime(
        args: Any,
        *,
        message: str,
        session_id: str | None,
        base_url: str,
    ) -> dict[str, Any]:
        del args
        assert message == "先做一版摘要"
        assert session_id == "sess_1"
        assert base_url == "http://127.0.0.1:8765"
        return {
            "status": "completed",
            "session_id": session_id,
            "agent_id": "semibot",
            "final_response": "好的，摘要如下。",
            "error": None,
            "tool_results": [],
            "runtime_events": [],
        }

    monkeypatch.setattr("src.cli._chat_start_via_runtime", _fake_chat_start_via_runtime)
    monkeypatch.setattr(
        "src.cli._chat_in_session_via_runtime",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("HTTP 404")),
    )

    parser = build_parser()
    args = parser.parse_args(["chat", "--message", "先做一版摘要", "--session-id", "sess_1"])
    exit_code = args.func(args)

    assert exit_code == 0
    output = capsys.readouterr().out
    assert "Chat session started" in output
    assert "好的，摘要如下。" in output


def test_chat_interactive_with_session_id_uses_session_endpoint(monkeypatch, capsys) -> None:
    monkeypatch.setattr("src.cli._require_runtime_server", lambda _url: None)
    calls: list[str] = []

    def _fake_chat_start_via_runtime(
        _args: Any,
        *,
        message: str,
        session_id: str | None,
        base_url: str,
    ) -> dict[str, Any]:
        calls.append("start")
        assert message == "你好"
        assert session_id == "sess_2"
        assert base_url == "http://127.0.0.1:8765"
        return {
            "status": "completed",
            "session_id": "sess_2",
            "agent_id": "semibot",
            "final_response": "第一轮",
            "error": None,
            "tool_results": [],
            "runtime_events": [],
        }

    def _fake_chat_in_session_via_runtime(
        _args: Any,
        *,
        message: str,
        session_id: str,
        base_url: str,
    ) -> dict[str, Any]:
        calls.append("session")
        assert message in {"你好", "再来一条"}
        assert session_id == "sess_2"
        assert base_url == "http://127.0.0.1:8765"
        return {
            "status": "completed",
            "session_id": "sess_2",
            "agent_id": "semibot",
            "final_response": "第二轮",
            "error": None,
            "tool_results": [],
            "runtime_events": [],
        }

    inputs = iter(["你好", "再来一条", "exit"])
    monkeypatch.setattr("builtins.input", lambda _prompt: next(inputs))
    monkeypatch.setattr("src.cli._chat_start_via_runtime", _fake_chat_start_via_runtime)
    monkeypatch.setattr("src.cli._chat_in_session_via_runtime", _fake_chat_in_session_via_runtime)

    parser = build_parser()
    args = parser.parse_args(["chat", "--session-id", "sess_2"])
    exit_code = args.func(args)

    assert exit_code == 0
    assert calls == ["session", "session"]
    output = capsys.readouterr().out
    assert "第二轮" in output


def test_chat_with_session_id_falls_back_to_start_on_404(monkeypatch, capsys) -> None:
    monkeypatch.setattr("src.cli._require_runtime_server", lambda _url: None)
    calls: list[str] = []

    def _fake_chat_start_via_runtime(
        _args: Any,
        *,
        message: str,
        session_id: str | None,
        base_url: str,
    ) -> dict[str, Any]:
        calls.append("start")
        assert message == "你好"
        assert session_id == "sess_new"
        assert base_url == "http://127.0.0.1:8765"
        return {
            "status": "completed",
            "session_id": "sess_new",
            "agent_id": "semibot",
            "final_response": "已创建新会话",
            "error": None,
            "tool_results": [],
            "runtime_events": [],
        }

    def _fake_chat_in_session_via_runtime(
        _args: Any,
        *,
        message: str,
        session_id: str,
        base_url: str,
    ) -> dict[str, Any]:
        calls.append("session")
        assert message == "你好"
        assert session_id == "sess_new"
        assert base_url == "http://127.0.0.1:8765"
        raise RuntimeError("HTTP 404 http://127.0.0.1:8765/api/v1/chat/sessions/sess_new: {\"detail\":\"Not Found\"}")

    monkeypatch.setattr("src.cli._chat_start_via_runtime", _fake_chat_start_via_runtime)
    monkeypatch.setattr("src.cli._chat_in_session_via_runtime", _fake_chat_in_session_via_runtime)

    parser = build_parser()
    args = parser.parse_args(["chat", "--session-id", "sess_new", "--message", "你好"])
    exit_code = args.func(args)

    assert exit_code == 0
    assert calls == ["session", "start"]
    output = capsys.readouterr().out
    assert "已创建新会话" in output


def test_chat_returns_error_when_runtime_unavailable(monkeypatch, capsys) -> None:
    monkeypatch.setattr(
        "src.cli._require_runtime_server",
        lambda _url: "runtime server unavailable at http://127.0.0.1:8765. "
        "please start it first with `semibot serve start`.",
    )

    parser = build_parser()
    args = parser.parse_args(["chat", "--message", "hello"])
    exit_code = args.func(args)

    assert exit_code == 6
    payload = json.loads(capsys.readouterr().out)
    assert payload["resource"] == "chat"
    assert payload["action"] == "connect"
    assert payload["error"]["code"] == "RUNTIME_UNAVAILABLE"


def test_run_command_returns_nonzero_on_failure(monkeypatch, capsys) -> None:
    monkeypatch.setattr("src.cli._require_runtime_server", lambda _url: None)

    def _fake_chat_start_via_runtime(
        _args: Any,
        *,
        message: str,
        session_id: str | None,
        base_url: str,
    ) -> dict[str, Any]:
        assert message == "hello"
        assert session_id is None
        assert base_url == "http://127.0.0.1:8765"
        return {
            "status": "failed",
            "session_id": "local_test",
            "agent_id": "semibot",
            "final_response": "",
            "error": "LLM provider not configured",
            "tool_results": [],
            "runtime_events": [],
        }

    monkeypatch.setattr("src.cli._chat_start_via_runtime", _fake_chat_start_via_runtime)

    parser = build_parser()
    args = parser.parse_args(["run", "hello"])
    exit_code = args.func(args)

    assert exit_code == 6
    payload = json.loads(capsys.readouterr().out)
    assert payload["status"] == "failed"
    assert payload["error"] == "LLM provider not configured"


def test_serve_daemon_command_calls_uvicorn(monkeypatch) -> None:
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
            "serve-daemon",
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


def test_serve_start_uses_pm2(monkeypatch, capsys) -> None:
    monkeypatch.setattr("src.cli._pm2_available", lambda: True)
    monkeypatch.setattr("src.cli._runtime_main_script_path", lambda: Path("/tmp/runtime/main.py"))
    monkeypatch.setattr("src.cli._runtime_python_executable", lambda: "/tmp/runtime/.venv/bin/python")
    monkeypatch.setattr("src.cli._pm2_find_process", lambda _name: None)

    calls: list[list[str]] = []

    class _Result:
        returncode = 0
        stdout = ""
        stderr = ""

    def _fake_run_pm2(command: list[str]):
        calls.append(command)
        return _Result()

    monkeypatch.setattr("src.cli._run_pm2_command", _fake_run_pm2)

    parser = build_parser()
    args = parser.parse_args(["serve", "start", "--port", "9999"])
    exit_code = args.func(args)

    assert exit_code == 0
    assert calls
    assert calls[0][:3] == ["pm2", "start", "/tmp/runtime/main.py"]
    assert "serve-daemon" in calls[0]
    assert "--port" in calls[0]
    payload = json.loads(capsys.readouterr().out)
    assert payload["mode"] == "serve"
    assert payload["action"] == "start"
    assert payload["ok"] is True


def test_serve_stop_returns_success_when_not_found(monkeypatch, capsys) -> None:
    monkeypatch.setattr("src.cli._pm2_available", lambda: True)
    monkeypatch.setattr("src.cli._pm2_find_process", lambda _name: None)
    monkeypatch.setattr("src.cli._run_pm2_command", lambda _command: None)
    monkeypatch.setattr(
        "src.cli._kill_processes_on_port",
        lambda port: {"port": port, "target_pids": [], "terminated_pids": [], "killed_pids": [], "remaining_pids": []},
    )

    parser = build_parser()
    args = parser.parse_args(["serve", "stop"])
    exit_code = args.func(args)

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["mode"] == "serve"
    assert payload["action"] == "stop"
    assert payload["already_stopped"] is True
    assert payload["port_cleanup"]["port"] == 8765


def test_serve_restart_prints_single_payload(monkeypatch, capsys) -> None:
    monkeypatch.setattr("src.cli._pm2_available", lambda: True)
    monkeypatch.setattr("src.cli._runtime_main_script_path", lambda: Path("/tmp/runtime/main.py"))
    monkeypatch.setattr("src.cli._runtime_python_executable", lambda: "/tmp/runtime/.venv/bin/python")

    call_index = {"n": 0}

    def _fake_find_process(_name: str):
        call_index["n"] += 1
        if call_index["n"] == 1:
            return {"name": "semibot-runtime", "pid": 1, "pm2_env": {"status": "online"}}
        return {"name": "semibot-runtime", "pid": 2, "pm2_env": {"status": "online"}}

    class _Result:
        returncode = 0
        stdout = ""
        stderr = ""

    monkeypatch.setattr("src.cli._pm2_find_process", _fake_find_process)
    monkeypatch.setattr("src.cli._run_pm2_command", lambda _command: _Result())

    parser = build_parser()
    args = parser.parse_args(["serve", "restart", "--port", "9998"])
    exit_code = args.func(args)

    assert exit_code == 0
    output = capsys.readouterr().out.strip().splitlines()
    assert output[0].startswith("{")
    payload = json.loads("\n".join(output))
    assert payload["mode"] == "serve"
    assert payload["action"] == "restart"
    assert payload["ok"] is True


def test_ui_start_uses_pm2(monkeypatch, capsys, tmp_path) -> None:
    project_root = tmp_path / "project"
    (project_root / "apps" / "api").mkdir(parents=True)
    (project_root / "apps" / "web").mkdir(parents=True)
    (project_root / "apps" / "api" / "package.json").write_text("{}", encoding="utf-8")
    (project_root / "apps" / "web" / "package.json").write_text("{}", encoding="utf-8")

    monkeypatch.setattr("src.cli._repo_root_from_cli", lambda: project_root)
    monkeypatch.setattr("src.cli._pm2_available", lambda: True)
    monkeypatch.setattr("src.cli._ensure_pnpm", lambda: None)

    calls: list[list[str]] = []
    state: dict[str, dict[str, Any]] = {}

    class _Result:
        def __init__(self) -> None:
            self.returncode = 0
            self.stdout = ""
            self.stderr = ""

    def _fake_run_pm2(command: list[str]):
        calls.append(command)
        if command[:2] == ["pm2", "delete"]:
            state.pop(command[2], None)
        if command[:2] == ["pm2", "start"]:
            name = command[command.index("--name") + 1]
            state[name] = {"name": name, "pid": 123, "pm2_env": {"status": "online"}}
        return _Result()

    monkeypatch.setattr("src.cli._run_pm2_command", _fake_run_pm2)
    monkeypatch.setattr("src.cli._pm2_find_process", lambda name: state.get(name))

    parser = build_parser()
    args = parser.parse_args(["ui", "start", "--name-prefix", "semibot-ui"])
    exit_code = args.func(args)

    assert exit_code == 0
    assert any(cmd[:2] == ["pm2", "start"] and "--name" in cmd and "semibot-runtime" in cmd for cmd in calls)
    assert any(cmd[:2] == ["pm2", "start"] and "--name" in cmd and "semibot-ui-api" in cmd for cmd in calls)
    assert any(cmd[:2] == ["pm2", "start"] and "--name" in cmd and "semibot-ui-web" in cmd for cmd in calls)
    payload = json.loads(capsys.readouterr().out)
    assert payload["mode"] == "ui"
    assert payload["action"] == "start"
    assert payload["ok"] is True
    assert payload["pm2_name_prefix"] == "semibot-ui"
    assert payload["runtime"]["enabled"] is True
    assert payload["runtime"]["pm2_name"] == "semibot-runtime"


def test_ui_restart_runs_stop_then_start_pm2(monkeypatch, capsys, tmp_path) -> None:
    project_root = tmp_path / "project"
    (project_root / "apps" / "api").mkdir(parents=True)
    (project_root / "apps" / "web").mkdir(parents=True)
    (project_root / "apps" / "api" / "package.json").write_text("{}", encoding="utf-8")
    (project_root / "apps" / "web" / "package.json").write_text("{}", encoding="utf-8")

    monkeypatch.setattr("src.cli._repo_root_from_cli", lambda: project_root)
    monkeypatch.setattr("src.cli._pm2_available", lambda: True)
    monkeypatch.setattr("src.cli._ensure_pnpm", lambda: None)
    port_cleanup_calls: list[int] = []
    monkeypatch.setattr(
        "src.cli._kill_processes_on_port",
        lambda port: (
            port_cleanup_calls.append(port)
            or {"port": port, "target_pids": [], "terminated_pids": [], "killed_pids": [], "remaining_pids": []}
        ),
    )

    calls: list[list[str]] = []
    state: dict[str, dict[str, Any]] = {
        "semibot-runtime": {"name": "semibot-runtime", "pid": 10, "pm2_env": {"status": "online"}},
        "semibot-ui-api": {"name": "semibot-ui-api", "pid": 1, "pm2_env": {"status": "online"}},
        "semibot-ui-web": {"name": "semibot-ui-web", "pid": 2, "pm2_env": {"status": "online"}},
    }

    class _Result:
        def __init__(self) -> None:
            self.returncode = 0
            self.stdout = ""
            self.stderr = ""

    def _fake_run_pm2(command: list[str]):
        calls.append(command)
        if command[:2] == ["pm2", "delete"]:
            state.pop(command[2], None)
        if command[:2] == ["pm2", "start"]:
            name = command[command.index("--name") + 1]
            state[name] = {"name": name, "pid": 123, "pm2_env": {"status": "online"}}
        return _Result()

    monkeypatch.setattr("src.cli._run_pm2_command", _fake_run_pm2)
    monkeypatch.setattr("src.cli._pm2_find_process", lambda name: state.get(name))

    parser = build_parser()
    args = parser.parse_args(["ui", "restart"])
    exit_code = args.func(args)

    assert exit_code == 0
    assert [cmd[:2] for cmd in calls].count(["pm2", "delete"]) == 3
    assert [cmd[:2] for cmd in calls].count(["pm2", "start"]) == 3
    payload = json.loads(capsys.readouterr().out)
    assert payload["mode"] == "ui"
    assert payload["action"] == "restart"
    assert payload["ok"] is True
    assert port_cleanup_calls == [8765, 3001, 3000]


def test_ui_stop_kills_runtime_api_web_ports(monkeypatch, capsys, tmp_path) -> None:
    project_root = tmp_path / "project"
    (project_root / "apps" / "api").mkdir(parents=True)
    (project_root / "apps" / "web").mkdir(parents=True)
    (project_root / "apps" / "api" / "package.json").write_text("{}", encoding="utf-8")
    (project_root / "apps" / "web" / "package.json").write_text("{}", encoding="utf-8")

    monkeypatch.setattr("src.cli._repo_root_from_cli", lambda: project_root)
    monkeypatch.setattr("src.cli._pm2_available", lambda: True)

    calls: list[list[str]] = []
    state: dict[str, dict[str, Any]] = {
        "semibot-runtime": {"name": "semibot-runtime", "pid": 10, "pm2_env": {"status": "online"}},
        "semibot-ui-api": {"name": "semibot-ui-api", "pid": 1, "pm2_env": {"status": "online"}},
        "semibot-ui-web": {"name": "semibot-ui-web", "pid": 2, "pm2_env": {"status": "online"}},
    }
    port_cleanup_calls: list[int] = []

    class _Result:
        def __init__(self) -> None:
            self.returncode = 0
            self.stdout = ""
            self.stderr = ""

    def _fake_run_pm2(command: list[str]):
        calls.append(command)
        if command[:2] == ["pm2", "delete"]:
            state.pop(command[2], None)
        return _Result()

    monkeypatch.setattr("src.cli._run_pm2_command", _fake_run_pm2)
    monkeypatch.setattr("src.cli._pm2_find_process", lambda name: state.get(name))
    monkeypatch.setattr(
        "src.cli._kill_processes_on_port",
        lambda port: (
            port_cleanup_calls.append(port)
            or {"port": port, "target_pids": [], "terminated_pids": [], "killed_pids": [], "remaining_pids": []}
        ),
    )

    parser = build_parser()
    args = parser.parse_args(["ui", "stop"])
    exit_code = args.func(args)

    assert exit_code == 0
    assert [cmd[:2] for cmd in calls].count(["pm2", "delete"]) == 3
    assert port_cleanup_calls == [8765, 3001, 3000]
    payload = json.loads(capsys.readouterr().out)
    assert payload["mode"] == "ui"
    assert payload["action"] == "stop"
    assert payload["ok"] is True


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


def test_skills_batch_disable_enable_remove(tmp_path, capsys) -> None:
    skills_root = tmp_path / "skills"
    alpha = skills_root / "alpha"
    beta = skills_root / "beta"
    alpha.mkdir(parents=True)
    beta.mkdir(parents=True)
    (alpha / "SKILL.md").write_text("# alpha\n", encoding="utf-8")
    (beta / "SKILL.md").write_text("# beta\n", encoding="utf-8")

    parser = build_parser()

    args_disable = parser.parse_args(
        [
            "skills",
            "batch",
            "--skills-path",
            str(skills_root),
            "--action",
            "disable",
            "--names",
            "alpha,beta",
        ]
    )
    exit_disable = args_disable.func(args_disable)
    assert exit_disable == 0
    payload_disable = json.loads(capsys.readouterr().out)
    assert payload_disable["batch_action"] == "disable"
    assert sorted(payload_disable["changed"]) == ["alpha", "beta"]

    args_enable = parser.parse_args(
        [
            "skills",
            "batch",
            "--skills-path",
            str(skills_root),
            "--action",
            "enable",
            "--names",
            "alpha",
        ]
    )
    exit_enable = args_enable.func(args_enable)
    assert exit_enable == 0
    payload_enable = json.loads(capsys.readouterr().out)
    assert payload_enable["batch_action"] == "enable"
    assert payload_enable["changed"] == ["alpha"]
    assert payload_enable["disabled_skills"] == ["beta"]

    args_remove = parser.parse_args(
        [
            "skills",
            "batch",
            "--skills-path",
            str(skills_root),
            "--action",
            "remove",
            "--names",
            "beta",
            "--yes",
        ]
    )
    exit_remove = args_remove.func(args_remove)
    assert exit_remove == 0
    payload_remove = json.loads(capsys.readouterr().out)
    assert payload_remove["batch_action"] == "remove"
    assert payload_remove["changed"] == ["beta"]
    assert not beta.exists()


def test_mcp_batch_disable_enable_remove(tmp_path, capsys) -> None:
    mcp_path = tmp_path / "mcp.json"
    mcp_path.write_text(
        json.dumps(
            {
                "servers": {
                    "alpha": {"transport": "http", "url": "http://localhost:9001"},
                    "beta": {"transport": "stdio", "command": "node", "args": ["server.js"]},
                }
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    parser = build_parser()
    args_disable = parser.parse_args(
        [
            "mcp",
            "batch",
            "--mcp-path",
            str(mcp_path),
            "--action",
            "disable",
            "--names",
            "alpha,beta",
        ]
    )
    exit_disable = args_disable.func(args_disable)
    assert exit_disable == 0
    payload_disable = json.loads(capsys.readouterr().out)
    assert payload_disable["batch_action"] == "disable"
    assert sorted(payload_disable["changed"]) == ["alpha", "beta"]

    stored_disable = json.loads(mcp_path.read_text(encoding="utf-8"))
    assert stored_disable["servers"]["alpha"]["enabled"] is False
    assert stored_disable["servers"]["beta"]["enabled"] is False

    args_enable = parser.parse_args(
        [
            "mcp",
            "batch",
            "--mcp-path",
            str(mcp_path),
            "--action",
            "enable",
            "--names",
            "alpha",
        ]
    )
    exit_enable = args_enable.func(args_enable)
    assert exit_enable == 0
    payload_enable = json.loads(capsys.readouterr().out)
    assert payload_enable["batch_action"] == "enable"
    assert payload_enable["changed"] == ["alpha"]

    args_remove = parser.parse_args(
        [
            "mcp",
            "batch",
            "--mcp-path",
            str(mcp_path),
            "--action",
            "remove",
            "--names",
            "beta",
            "--yes",
        ]
    )
    exit_remove = args_remove.func(args_remove)
    assert exit_remove == 0
    payload_remove = json.loads(capsys.readouterr().out)
    assert payload_remove["batch_action"] == "remove"
    assert payload_remove["changed"] == ["beta"]

    stored_remove = json.loads(mcp_path.read_text(encoding="utf-8"))
    assert "beta" not in stored_remove["servers"]


def test_mcp_test_returns_disabled_error(tmp_path, capsys) -> None:
    mcp_path = tmp_path / "mcp.json"
    mcp_path.write_text(
        json.dumps(
            {
                "servers": {
                    "alpha": {
                        "transport": "http",
                        "url": "http://localhost:9001",
                        "enabled": False,
                    }
                }
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    parser = build_parser()
    args = parser.parse_args(["mcp", "test", "alpha", "--mcp-path", str(mcp_path)])
    exit_code = args.func(args)
    assert exit_code == 3
    payload = json.loads(capsys.readouterr().out)
    assert payload["error"]["code"] == "MCP_SERVER_DISABLED"


def test_mcp_call_returns_disabled_error(tmp_path, capsys) -> None:
    mcp_path = tmp_path / "mcp.json"
    mcp_path.write_text(
        json.dumps(
            {
                "servers": {
                    "alpha": {
                        "transport": "http",
                        "url": "http://localhost:9001",
                        "enabled": False,
                    }
                }
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    parser = build_parser()
    args = parser.parse_args(
        [
            "mcp",
            "call",
            "alpha",
            "tool.search",
            "--args",
            "{}",
            "--mcp-path",
            str(mcp_path),
        ]
    )
    exit_code = args.func(args)
    assert exit_code == 3
    payload = json.loads(capsys.readouterr().out)
    assert payload["error"]["code"] == "MCP_SERVER_DISABLED"


def test_gateway_list_command(monkeypatch, capsys) -> None:
    monkeypatch.setattr("src.cli._require_runtime_server", lambda _url: None)

    def _fake_list(base_url: str, *, provider: str | None = None) -> dict[str, Any]:
        assert base_url == "http://127.0.0.1:8765"
        assert provider == "telegram"
        return {
            "data": [
                {
                    "id": "gw_inst_1",
                    "provider": "telegram",
                    "displayName": "Telegram Bot A",
                }
            ]
        }

    monkeypatch.setattr("src.cli._gateway_list_instances_via_runtime", _fake_list)

    parser = build_parser()
    args = parser.parse_args(["gateway", "list", "--provider", "telegram"])
    exit_code = args.func(args)
    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["resource"] == "gateway"
    assert payload["action"] == "list"
    assert payload["count"] == 1
    assert payload["items"][0]["id"] == "gw_inst_1"


def test_gateway_migrate_env_dry_run(monkeypatch, tmp_path: Path, capsys) -> None:
    monkeypatch.setenv("SEMIBOT_TELEGRAM_BOT_TOKEN", "123456:abc_xyz")
    monkeypatch.setenv("SEMIBOT_TELEGRAM_DEFAULT_CHAT_ID", "-10070001")
    monkeypatch.setenv("SEMIBOT_TELEGRAM_NOTIFY_EVENT_TYPES", "approval.requested, task.completed")

    parser = build_parser()
    args = parser.parse_args(
        [
            "gateway",
            "migrate-env",
            "--provider",
            "telegram",
            "--db-path",
            str(tmp_path / "semibot.db"),
            "--dry-run",
        ]
    )
    exit_code = args.func(args)
    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["action"] == "migrate-env"
    assert payload["dry_run"] is True
    assert payload["migrated"] == 0
    assert payload["results"][0]["status"] == "preview"
    assert payload["results"][0]["patch"]["config"]["defaultChatId"] == "-10070001"
    assert payload["results"][0]["patch"]["config"]["botToken"].startswith("123")
    assert payload["results"][0]["patch"]["config"]["botToken"].endswith("xyz")


def test_gateway_migrate_env_writes_sqlite(monkeypatch, tmp_path: Path, capsys) -> None:
    from src.server.config_store import RuntimeConfigStore

    monkeypatch.setenv("SEMIBOT_FEISHU_VERIFY_TOKEN", "verify_token_xxx")
    monkeypatch.setenv("SEMIBOT_FEISHU_WEBHOOK_URL", "https://open.feishu.cn/hook/test")
    monkeypatch.setenv("SEMIBOT_FEISHU_NOTIFY_EVENT_TYPES", "approval.requested")
    monkeypatch.setenv("SEMIBOT_FEISHU_WEBHOOKS_JSON", '{"ops":"https://open.feishu.cn/hook/ops"}')

    db_path = tmp_path / "semibot.db"
    parser = build_parser()
    args = parser.parse_args(
        [
            "gateway",
            "migrate-env",
            "--provider",
            "feishu",
            "--db-path",
            str(db_path),
        ]
    )
    exit_code = args.func(args)
    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["migrated"] == 1
    assert payload["results"][0]["status"] == "migrated"

    store = RuntimeConfigStore(db_path=str(db_path))
    item = store.get_gateway_config("feishu")
    assert item is not None
    cfg = item["config"]
    assert cfg["verifyToken"] == "verify_token_xxx"
    assert cfg["webhookUrl"] == "https://open.feishu.cn/hook/test"
    assert cfg["notifyEventTypes"] == ["approval.requested"]
    assert cfg["webhookChannels"] == {"ops": "https://open.feishu.cn/hook/ops"}


def test_gateway_doctor_detects_broken_instance(tmp_path: Path, capsys) -> None:
    from src.server.config_store import RuntimeConfigStore

    db_path = tmp_path / "semibot.db"
    store = RuntimeConfigStore(db_path=str(db_path))
    created = store.create_gateway_instance(
        {
            "provider": "telegram",
            "instance_key": "tg-broken",
            "is_active": True,
            "config": {},
        }
    )

    parser = build_parser()
    args = parser.parse_args(
        [
            "gateway",
            "doctor",
            "--provider",
            "telegram",
            "--db-path",
            str(db_path),
        ]
    )
    exit_code = args.func(args)
    assert exit_code == 3
    payload = json.loads(capsys.readouterr().out)
    assert payload["action"] == "doctor"
    assert payload["summary"]["broken"] >= 1
    target = next(item for item in payload["instances"] if item["id"] == created["id"])
    assert "telegram_active_missing_bot_token" in target["errors"]


def test_gateway_doctor_strict_warnings_mode(tmp_path: Path, capsys) -> None:
    from src.server.config_store import RuntimeConfigStore

    db_path = tmp_path / "semibot.db"
    store = RuntimeConfigStore(db_path=str(db_path))
    created = store.create_gateway_instance(
        {
            "provider": "telegram",
            "instance_key": "tg-degraded",
            "is_active": True,
            "config": {"botToken": "123456:token_only"},
        }
    )

    parser = build_parser()
    args_normal = parser.parse_args(
        [
            "gateway",
            "doctor",
            "--provider",
            "telegram",
            "--db-path",
            str(db_path),
        ]
    )
    exit_normal = args_normal.func(args_normal)
    payload_normal = json.loads(capsys.readouterr().out)
    assert exit_normal == 0
    target = next(item for item in payload_normal["instances"] if item["id"] == created["id"])
    assert "telegram_no_default_or_allowed_chat_ids" in target["warnings"]

    args_strict = parser.parse_args(
        [
            "gateway",
            "doctor",
            "--provider",
            "telegram",
            "--db-path",
            str(db_path),
            "--strict-warnings",
        ]
    )
    exit_strict = args_strict.func(args_strict)
    payload_strict = json.loads(capsys.readouterr().out)
    assert exit_strict == 3
    assert payload_strict["summary"]["degraded"] >= 1


def test_gateway_webhook_check_success(monkeypatch, tmp_path: Path, capsys) -> None:
    from src.server.config_store import RuntimeConfigStore

    db_path = tmp_path / "semibot.db"
    store = RuntimeConfigStore(db_path=str(db_path))
    created = store.create_gateway_instance(
        {
            "provider": "telegram",
            "instance_key": "tg-webhook-ok",
            "is_active": True,
            "config": {"botToken": "123456:token_ok"},
        }
    )

    def _fake_http_json_request(*, method: str, url: str, payload=None, timeout: float = 5.0):
        del payload, timeout
        assert method == "GET"
        assert "getWebhookInfo" in url
        return {
            "ok": True,
            "result": {
                "url": "https://example.ngrok-free.app/v1/integrations/telegram/webhook",
                "pending_update_count": 0,
            },
        }

    monkeypatch.setattr("src.cli._http_json_request", _fake_http_json_request)

    parser = build_parser()
    args = parser.parse_args(
        [
            "gateway",
            "webhook-check",
            "--provider",
            "telegram",
            "--db-path",
            str(db_path),
            "--instance-id",
            str(created["id"]),
            "--public-base-url",
            "https://example.ngrok-free.app",
        ]
    )
    exit_code = args.func(args)
    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["action"] == "webhook-check"
    assert payload["summary"]["healthy"] == 1
    assert payload["instances"][0]["status"] == "healthy"


def test_gateway_webhook_check_detects_url_mismatch_in_strict_mode(
    monkeypatch, tmp_path: Path, capsys
) -> None:
    from src.server.config_store import RuntimeConfigStore

    db_path = tmp_path / "semibot.db"
    store = RuntimeConfigStore(db_path=str(db_path))
    created = store.create_gateway_instance(
        {
            "provider": "telegram",
            "instance_key": "tg-webhook-mismatch",
            "is_active": True,
            "config": {"botToken": "123456:token_ok"},
        }
    )

    def _fake_http_json_request(*, method: str, url: str, payload=None, timeout: float = 5.0):
        del method, url, payload, timeout
        return {
            "ok": True,
            "result": {
                "url": "https://wrong.example.com/v1/integrations/telegram/webhook",
                "pending_update_count": 2,
            },
        }

    monkeypatch.setattr("src.cli._http_json_request", _fake_http_json_request)

    parser = build_parser()
    args = parser.parse_args(
        [
            "gateway",
            "webhook-check",
            "--provider",
            "telegram",
            "--db-path",
            str(db_path),
            "--instance-id",
            str(created["id"]),
            "--expected-url",
            "https://expected.example.com/v1/integrations/telegram/webhook",
            "--strict-warnings",
        ]
    )
    exit_code = args.func(args)
    assert exit_code == 3
    payload = json.loads(capsys.readouterr().out)
    assert payload["summary"]["degraded"] == 1
    warnings = payload["instances"][0]["warnings"]
    assert "telegram_webhook_url_mismatch" in warnings
    assert any(item.startswith("telegram_pending_updates:") for item in warnings)


def test_gateway_webhook_set_uses_config_secret(monkeypatch, tmp_path: Path, capsys) -> None:
    from src.server.config_store import RuntimeConfigStore

    db_path = tmp_path / "semibot.db"
    store = RuntimeConfigStore(db_path=str(db_path))
    created = store.create_gateway_instance(
        {
            "provider": "telegram",
            "instance_key": "tg-webhook-set",
            "is_default": True,
            "is_active": True,
            "config": {
                "botToken": "123456:token_set",
                "webhookSecret": "sec-123",
            },
        }
    )

    calls: list[tuple[str, str, dict[str, Any] | None]] = []

    def _fake_http_json_request(*, method: str, url: str, payload=None, timeout: float = 5.0):
        del timeout
        calls.append((method, url, payload))
        if "setWebhook" in url:
            assert method == "POST"
            assert payload is not None
            assert payload["url"] == "https://example.ngrok-free.app/v1/integrations/telegram/webhook"
            assert payload["secret_token"] == "sec-123"
            return {"ok": True, "description": "Webhook was set"}
        if "getWebhookInfo" in url:
            assert method == "GET"
            return {
                "ok": True,
                "result": {
                    "url": "https://example.ngrok-free.app/v1/integrations/telegram/webhook",
                    "pending_update_count": 0,
                },
            }
        raise AssertionError(f"unexpected url: {url}")

    monkeypatch.setattr("src.cli._http_json_request", _fake_http_json_request)

    parser = build_parser()
    args = parser.parse_args(
        [
            "gateway",
            "webhook-set",
            "--provider",
            "telegram",
            "--db-path",
            str(db_path),
            "--instance-id",
            str(created["id"]),
            "--public-base-url",
            "https://example.ngrok-free.app",
        ]
    )
    exit_code = args.func(args)
    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["action"] == "webhook-set"
    assert payload["ok"] is True
    assert payload["request"]["secretFrom"] == "config"
    assert len(calls) == 2


def test_gateway_webhook_set_requires_disambiguation(tmp_path: Path, capsys) -> None:
    from src.server.config_store import RuntimeConfigStore

    db_path = tmp_path / "semibot.db"
    store = RuntimeConfigStore(db_path=str(db_path))
    store.create_gateway_instance(
        {
            "provider": "telegram",
            "instance_key": "tg-webhook-a",
            "is_active": True,
            "config": {"botToken": "111111:token_a"},
        }
    )
    store.create_gateway_instance(
        {
            "provider": "telegram",
            "instance_key": "tg-webhook-b",
            "is_active": True,
            "config": {"botToken": "222222:token_b"},
        }
    )

    parser = build_parser()
    args = parser.parse_args(
        [
            "gateway",
            "webhook-set",
            "--provider",
            "telegram",
            "--db-path",
            str(db_path),
            "--url",
            "https://example.ngrok-free.app/v1/integrations/telegram/webhook",
        ]
    )
    exit_code = args.func(args)
    assert exit_code == 2
    payload = json.loads(capsys.readouterr().out)
    assert payload["error"]["code"] == "AMBIGUOUS_TELEGRAM_INSTANCE"


def test_gateway_create_update_and_test_commands(monkeypatch, capsys) -> None:
    monkeypatch.setattr("src.cli._require_runtime_server", lambda _url: None)

    def _fake_create(base_url: str, payload: dict[str, Any]) -> dict[str, Any]:
        assert base_url == "http://127.0.0.1:8765"
        assert payload["provider"] == "telegram"
        assert payload["instance_key"] == "bot-a"
        assert payload["displayName"] == "Bot A"
        return {"id": "gw_inst_2", **payload}

    def _fake_update(base_url: str, instance_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        assert base_url == "http://127.0.0.1:8765"
        assert instance_id == "gw_inst_2"
        assert patch == {"isActive": False}
        return {"id": instance_id, **patch}

    def _fake_test(base_url: str, instance_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        assert base_url == "http://127.0.0.1:8765"
        assert instance_id == "gw_inst_2"
        assert payload["text"] == "ping"
        assert payload["chat_id"] == "-10001"
        return {"ok": True}

    monkeypatch.setattr("src.cli._gateway_create_instance_via_runtime", _fake_create)
    monkeypatch.setattr("src.cli._gateway_update_instance_via_runtime", _fake_update)
    monkeypatch.setattr("src.cli._gateway_test_instance_via_runtime", _fake_test)

    parser = build_parser()

    args_create = parser.parse_args(
        [
            "gateway",
            "create",
            "--provider",
            "telegram",
            "--instance-key",
            "bot-a",
            "--patch",
            '{"displayName":"Bot A"}',
        ]
    )
    assert args_create.func(args_create) == 0
    payload_create = json.loads(capsys.readouterr().out)
    assert payload_create["action"] == "create"
    assert payload_create["item"]["id"] == "gw_inst_2"

    args_update = parser.parse_args(
        [
            "gateway",
            "update",
            "gw_inst_2",
            "--patch",
            '{"isActive": false}',
        ]
    )
    assert args_update.func(args_update) == 0
    payload_update = json.loads(capsys.readouterr().out)
    assert payload_update["action"] == "update"
    assert payload_update["item"]["isActive"] is False

    args_test = parser.parse_args(
        [
            "gateway",
            "test",
            "gw_inst_2",
            "--text",
            "ping",
            "--chat-id",
            "-10001",
        ]
    )
    assert args_test.func(args_test) == 0
    payload_test = json.loads(capsys.readouterr().out)
    assert payload_test["action"] == "test"
    assert payload_test["result"]["ok"] is True


def test_gateway_delete_requires_confirmation(capsys) -> None:
    parser = build_parser()
    args = parser.parse_args(["gateway", "delete", "gw_inst_3"])
    exit_code = args.func(args)
    assert exit_code == 2
    payload = json.loads(capsys.readouterr().out)
    assert payload["error"]["code"] == "CONFIRMATION_REQUIRED"


def test_gateway_batch_enable_and_delete(monkeypatch, capsys) -> None:
    monkeypatch.setattr("src.cli._require_runtime_server", lambda _url: None)
    batch_calls: list[dict[str, Any]] = []

    def _fake_list(base_url: str, *, provider: str | None = None) -> dict[str, Any]:
        assert base_url == "http://127.0.0.1:8765"
        assert provider == "telegram"
        return {
            "data": [
                {"id": "gw_inst_a", "provider": "telegram", "isActive": False},
                {"id": "gw_inst_b", "provider": "telegram", "isActive": True},
            ]
        }

    def _fake_batch(base_url: str, payload: dict[str, Any]) -> dict[str, Any]:
        assert base_url == "http://127.0.0.1:8765"
        batch_calls.append(payload)
        if payload["action"] == "enable":
            return {
                "action": "enable",
                "requested": payload["instanceIds"],
                "targets": payload["instanceIds"],
                "changed": ["gw_inst_a"],
                "unchanged": ["gw_inst_b"],
                "blocked": [],
                "missing": [],
                "failed": [],
            }
        return {
            "action": "delete",
            "requested": payload["instanceIds"],
            "targets": payload["instanceIds"],
            "changed": ["gw_inst_b"],
            "unchanged": [],
            "blocked": [],
            "missing": [],
            "failed": [],
        }

    monkeypatch.setattr("src.cli._gateway_list_instances_via_runtime", _fake_list)
    monkeypatch.setattr("src.cli._gateway_batch_instances_via_runtime", _fake_batch)

    parser = build_parser()
    args_enable = parser.parse_args(
        [
            "gateway",
            "batch",
            "--action",
            "enable",
            "--provider",
            "telegram",
            "--instance-ids",
            "gw_inst_a,gw_inst_b",
        ]
    )
    assert args_enable.func(args_enable) == 0
    payload_enable = json.loads(capsys.readouterr().out)
    assert payload_enable["action"] == "batch"
    assert payload_enable["batch_action"] == "enable"
    assert payload_enable["changed"] == ["gw_inst_a"]
    assert payload_enable["unchanged"] == ["gw_inst_b"]
    assert batch_calls[0]["instanceIds"] == ["gw_inst_a", "gw_inst_b"]
    assert batch_calls[0]["action"] == "enable"

    args_delete = parser.parse_args(
        [
            "gateway",
            "batch",
            "--action",
            "delete",
            "--provider",
            "telegram",
            "--instance-ids",
            "gw_inst_b",
            "--yes",
        ]
    )
    assert args_delete.func(args_delete) == 0
    payload_delete = json.loads(capsys.readouterr().out)
    assert payload_delete["batch_action"] == "delete"
    assert payload_delete["changed"] == ["gw_inst_b"]
    assert batch_calls[1]["instanceIds"] == ["gw_inst_b"]
    assert batch_calls[1]["action"] == "delete"


def test_gateway_batch_delete_requires_confirmation(monkeypatch, capsys) -> None:
    monkeypatch.setattr("src.cli._require_runtime_server", lambda _url: None)
    monkeypatch.setattr(
        "src.cli._gateway_list_instances_via_runtime",
        lambda _base_url, provider=None: {"data": [{"id": "gw_inst_x", "provider": provider or "telegram"}]},
    )

    parser = build_parser()
    args = parser.parse_args(
        [
            "gateway",
            "batch",
            "--action",
            "delete",
            "--instance-ids",
            "gw_inst_x",
        ]
    )
    exit_code = args.func(args)
    assert exit_code == 2
    payload = json.loads(capsys.readouterr().out)
    assert payload["error"]["code"] == "CONFIRMATION_REQUIRED"


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


def test_version_command(capsys) -> None:
    parser = build_parser()
    args = parser.parse_args(["version"])
    exit_code = args.func(args)

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["mode"] == "version"
    assert payload["version"] == "2.0.0"


def test_doctor_command_with_existing_paths(tmp_path, capsys) -> None:
    db_path = tmp_path / "semibot.db"
    rules_path = tmp_path / "rules"
    skills_path = tmp_path / "skills"
    db_path.write_text("", encoding="utf-8")
    rules_path.mkdir()
    skills_path.mkdir()

    parser = build_parser()
    args = parser.parse_args(
        [
            "doctor",
            "--db-path",
            str(db_path),
            "--rules-path",
            str(rules_path),
            "--skills-path",
            str(skills_path),
        ]
    )
    exit_code = args.func(args)

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["mode"] == "doctor"
    assert payload["ok"] is True
    assert payload["checks"]["db_path_exists"] is True


def test_events_show_not_found(monkeypatch, capsys) -> None:
    class _FakeStore:
        def __init__(self, db_path: str):
            self.db_path = db_path

        def get_event(self, event_id: str):
            assert event_id == "evt_missing"
            return None

    monkeypatch.setattr("src.cli.EventStore", _FakeStore)

    parser = build_parser()
    args = parser.parse_args(["events", "show", "evt_missing"])
    exit_code = args.func(args)

    assert exit_code == 4
    payload = json.loads(capsys.readouterr().out)
    assert payload["error"]["code"] == "EVENT_NOT_FOUND"


def test_rules_show_not_found(monkeypatch, capsys) -> None:
    monkeypatch.setattr("src.cli.load_rules", lambda _path: [])

    parser = build_parser()
    args = parser.parse_args(["rules", "show", "rule_missing"])
    exit_code = args.func(args)

    assert exit_code == 4
    payload = json.loads(capsys.readouterr().out)
    assert payload["error"]["code"] == "RULE_NOT_FOUND"


def test_tools_run_command(monkeypatch, capsys) -> None:
    class _FakeResult:
        success = True
        result = {"ok": True}
        error = None
        metadata = {"latency_ms": 10}

    class _FakeRegistry:
        async def execute(self, name: str, params: dict[str, Any]):
            assert name == "pdf"
            assert params == {"topic": "Alibaba"}
            return _FakeResult()

    monkeypatch.setattr("src.cli.create_default_registry", lambda: _FakeRegistry())

    parser = build_parser()
    args = parser.parse_args(["tools", "run", "pdf", "--args", '{"topic":"Alibaba"}'])
    exit_code = args.func(args)

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["resource"] == "tools"
    assert payload["action"] == "run"
    assert payload["ok"] is True


def test_configure_show_default_action(tmp_path, capsys) -> None:
    config_path = tmp_path / "config.toml"
    config_path.write_text(
        '[runtime]\n'
        'db_path = "/tmp/semibot.db"\n'
        '\n'
        '[llm]\n'
        'default_model = "gpt-4o"\n',
        encoding="utf-8",
    )

    parser = build_parser()
    args = parser.parse_args(["configure", "--config-path", str(config_path)])
    exit_code = args.func(args)

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["resource"] == "configure"
    assert payload["action"] == "show"
    assert payload["data"]["llm"]["default_model"] == "gpt-4o"


def test_configure_get_not_found(tmp_path, capsys) -> None:
    config_path = tmp_path / "config.toml"
    config_path.write_text('[llm]\ndefault_model = "gpt-4o"\n', encoding="utf-8")

    parser = build_parser()
    args = parser.parse_args(["configure", "get", "llm.missing", "--config-path", str(config_path)])
    exit_code = args.func(args)

    assert exit_code == 4
    payload = json.loads(capsys.readouterr().out)
    assert payload["error"]["code"] == "CONFIG_KEY_NOT_FOUND"


def test_configure_set_and_unset(tmp_path, capsys) -> None:
    config_path = tmp_path / "config.toml"
    config_path.write_text('[llm]\ndefault_model = "gpt-4o"\n', encoding="utf-8")
    parser = build_parser()

    args_set = parser.parse_args(
        [
            "configure",
            "set",
            "runtime.max_workers",
            "8",
            "--type",
            "int",
            "--config-path",
            str(config_path),
        ]
    )
    exit_code_set = args_set.func(args_set)
    assert exit_code_set == 0
    _ = capsys.readouterr().out

    with config_path.open("rb") as file:
        after_set = tomllib.load(file)
    assert after_set["runtime"]["max_workers"] == 8

    args_unset = parser.parse_args(
        ["configure", "unset", "runtime.max_workers", "--config-path", str(config_path)]
    )
    exit_code_unset = args_unset.func(args_unset)
    assert exit_code_unset == 0
    _ = capsys.readouterr().out

    with config_path.open("rb") as file:
        after_unset = tomllib.load(file)
    assert "max_workers" not in after_unset.get("runtime", {})


def test_events_replay_by_type(monkeypatch, capsys) -> None:
    class _FakeEngine:
        async def replay_by_type(self, event_type: str, since):
            assert event_type == "task.failed"
            assert since is not None
            return 3

    monkeypatch.setattr("src.cli._build_event_engine", lambda _args: _FakeEngine())

    parser = build_parser()
    args = parser.parse_args(
        [
            "events",
            "replay",
            "--event-type",
            "task.failed",
            "--since",
            "2026-02-25T00:00:00Z",
        ]
    )
    exit_code = args.func(args)

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["resource"] == "events"
    assert payload["action"] == "replay"
    assert payload["replayed"] == 3


def test_events_clean_requires_confirmation(monkeypatch, capsys) -> None:
    class _FakeStore:
        def __init__(self, db_path: str):
            self.db_path = db_path

        def cleanup_events(self, *, before, dry_run: bool = False):
            return {"events": 0, "rule_runs": 0, "approvals": 0}

    monkeypatch.setattr("src.cli.EventStore", _FakeStore)
    parser = build_parser()
    args = parser.parse_args(["events", "clean"])
    exit_code = args.func(args)

    assert exit_code == 2
    payload = json.loads(capsys.readouterr().out)
    assert payload["error"]["code"] == "CONFIRMATION_REQUIRED"


def test_rules_lint_invalid(tmp_path, capsys) -> None:
    rule_file = tmp_path / "invalid_rule.json"
    rule_file.write_text(
        json.dumps({"name": "bad_rule", "event_type": "task.failed", "action_mode": "bad"}, ensure_ascii=False),
        encoding="utf-8",
    )

    parser = build_parser()
    args = parser.parse_args(["rules", "lint", "--file", str(rule_file)])
    exit_code = args.func(args)

    assert exit_code == 2
    payload = json.loads(capsys.readouterr().out)
    assert payload["resource"] == "rules"
    assert payload["action"] == "lint"
    assert payload["ok"] is False


def test_rules_create_and_update(tmp_path, capsys) -> None:
    rules_dir = tmp_path / "rules"
    rules_dir.mkdir()
    rule_file = tmp_path / "rule.json"
    rule_file.write_text(
        json.dumps(
            {
                "id": "rule_demo",
                "name": "rule_demo",
                "event_type": "task.failed",
                "conditions": {"all": []},
                "action_mode": "suggest",
                "actions": [{"action_type": "notify", "params": {"channel": "runtime"}}],
                "risk_level": "low",
                "priority": 1,
                "is_active": True,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    parser = build_parser()
    args_create = parser.parse_args(
        ["rules", "create", "--file", str(rule_file), "--rules-path", str(rules_dir)]
    )
    exit_code_create = args_create.func(args_create)
    assert exit_code_create == 0
    _ = capsys.readouterr().out

    patch_file = tmp_path / "rule_patch.json"
    patch_file.write_text(json.dumps({"priority": 99}, ensure_ascii=False), encoding="utf-8")
    args_update = parser.parse_args(
        [
            "rules",
            "update",
            "rule_demo",
            "--file",
            str(patch_file),
            "--rules-path",
            str(rules_dir),
        ]
    )
    exit_code_update = args_update.func(args_update)
    assert exit_code_update == 0
    _ = capsys.readouterr().out

    saved = json.loads((rules_dir / "rule_demo.json").read_text(encoding="utf-8"))
    assert saved["priority"] == 99


def test_approvals_resolve_not_pending(monkeypatch, capsys) -> None:
    class _Approval:
        approval_id = "appr_1"
        rule_id = "rule_1"
        event_id = "evt_1"
        risk_level = "high"
        status = "approved"
        created_at = datetime.now(UTC)
        resolved_at = datetime.now(UTC)

    class _FakeStore:
        def __init__(self, db_path: str):
            self.db_path = db_path

        def get_approval(self, approval_id: str):
            assert approval_id == "appr_1"
            return _Approval()

    monkeypatch.setattr("src.cli.EventStore", _FakeStore)
    parser = build_parser()
    args = parser.parse_args(["approvals", "approve", "appr_1"])
    exit_code = args.func(args)

    assert exit_code == 5
    payload = json.loads(capsys.readouterr().out)
    assert payload["error"]["code"] == "APPROVAL_NOT_PENDING"


def test_sessions_export_json(monkeypatch, tmp_path, capsys) -> None:
    class _FakeStore:
        def __init__(self, db_path: str):
            self.db_path = db_path

        def list_session_events(self, session_id: str, *, limit: int = 200):
            assert session_id == "sess_1"
            assert limit == 500
            return [
                Event(
                    event_id="evt_1",
                    event_type="task.completed",
                    source="test",
                    subject="sess_1",
                    payload={"session_id": "sess_1", "final_response": "done"},
                    timestamp=datetime.now(UTC),
                    risk_hint="low",
                )
            ]

    monkeypatch.setattr("src.cli.EventStore", _FakeStore)
    out_file = tmp_path / "session.json"
    parser = build_parser()
    args = parser.parse_args(
        [
            "sessions",
            "export",
            "sess_1",
            "--format",
            "json",
            "--out",
            str(out_file),
        ]
    )
    exit_code = args.func(args)

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["resource"] == "sessions"
    assert payload["action"] == "export"
    exported = json.loads(out_file.read_text(encoding="utf-8"))
    assert exported["session_id"] == "sess_1"


def test_banner_lines_centered_for_configure_title() -> None:
    ansi = re.compile(r"\x1b\[[0-9;]*m")
    lines = [ansi.sub("", line) for line in _banner_lines("SEMIBOT CONFIGURE")]

    border = lines[0]
    assert border.startswith("+")
    assert border.endswith("+")
    assert lines[-1] == border
    assert all(len(line) == len(border) for line in lines)
    title_line = next((line for line in lines if "SEMIBOT CONFIGURE" in line), "")
    assert title_line
    left, _, right = title_line.partition("SEMIBOT CONFIGURE")
    left_spaces = left.count(" ")
    right_spaces = right.count(" ")
    assert abs(left_spaces - right_spaces) <= 1

    logo_lines = lines[1:6]
    left_offsets: list[int] = []
    right_offsets: list[int] = []
    for line in logo_lines:
        content = line[2:-2]
        left = len(content) - len(content.lstrip(" "))
        right = len(content) - len(content.rstrip(" "))
        left_offsets.append(left)
        right_offsets.append(right)

    # Keep internal ASCII-art relative indent, but ensure the whole block is centered.
    block_left = min(left_offsets)
    block_right = min(right_offsets)
    assert abs(block_left - block_right) <= 1


def test_default_log_level_uses_critical_when_env_missing(monkeypatch) -> None:
    monkeypatch.delenv("SEMIBOT_LOG_LEVEL", raising=False)
    assert _default_log_level() == "CRITICAL"


def test_default_log_level_fallback_when_env_invalid(monkeypatch) -> None:
    monkeypatch.setenv("SEMIBOT_LOG_LEVEL", "verbose")
    assert _default_log_level() == "CRITICAL"


def test_sanitize_terminal_text_removes_control_sequences() -> None:
    raw = "I encountered a\x1b[200~bad\x1b[O error\r\n"
    cleaned = _sanitize_terminal_text(raw)
    assert "\x1b" not in cleaned
    assert "I encountered abad error" in cleaned


def test_require_runtime_server_returns_none_when_healthy(monkeypatch) -> None:
    monkeypatch.setattr("src.cli._is_runtime_healthy", lambda _url: True)
    assert _require_runtime_server("http://127.0.0.1:8765") is None


def test_require_runtime_server_returns_error_when_unhealthy(monkeypatch) -> None:
    monkeypatch.setattr("src.cli._is_runtime_healthy", lambda _url: False)
    assert _require_runtime_server("http://127.0.0.1:8765") == (
        "runtime server unavailable at http://127.0.0.1:8765. "
        "please start it first with `semibot serve start`."
    )
