from __future__ import annotations

from pathlib import Path

from src.product.config import ProductConfigLoader
from src.product.services.local_stack import LocalProductStack, StackOptions


def test_local_product_stack_injects_install_llm_env(monkeypatch, tmp_path: Path) -> None:
    home = tmp_path / ".semibot"
    monkeypatch.setenv("SEMIBOT_HOME", str(home))

    loader = ProductConfigLoader()
    loader.ensure_layout(
        default_model="gpt-4o-mini",
        openai_api_key="sk-test-openai",
        anthropic_api_key="sk-test-anthropic",
        force=True,
    )

    stack = LocalProductStack(StackOptions(wait_for_health=False))
    definitions = stack.service_definitions()

    runtime_env = definitions["runtime"].env
    api_env = definitions["api"].env

    assert runtime_env["DEFAULT_LLM_MODEL"] == "gpt-4o-mini"
    assert runtime_env["DEFAULT_LLM_PROVIDER_KEY"] == "openai"
    assert runtime_env["OPENAI_API_KEY"] == "sk-test-openai"
    assert runtime_env["ANTHROPIC_API_KEY"] == "sk-test-anthropic"
    assert api_env["DEFAULT_LLM_MODEL"] == "gpt-4o-mini"
    assert api_env["DEFAULT_LLM_PROVIDER_KEY"] == "openai"
    assert api_env["OPENAI_API_KEY"] == "sk-test-openai"
    assert api_env["ANTHROPIC_API_KEY"] == "sk-test-anthropic"


def test_stop_cleans_stale_ui_process_pidfiles(monkeypatch, tmp_path: Path) -> None:
    home = tmp_path / ".semibot"
    monkeypatch.setenv("SEMIBOT_HOME", str(home))

    loader = ProductConfigLoader()
    loader.ensure_layout(force=True)

    stale_pid = loader.paths.run_dir / "semibot-ui-old1234-api.pid"
    stale_meta = loader.paths.run_dir / "semibot-ui-old1234-api.pid.json"
    stale_pid.write_text("999999\n", encoding="utf-8")
    stale_meta.write_text("{}\n", encoding="utf-8")

    stack = LocalProductStack(StackOptions(wait_for_health=False))
    payload = stack.stop()

    assert not stale_pid.exists()
    assert not stale_meta.exists()
    assert any(step.get("step") == "stop-stale-ui" and step.get("name") == "semibot-ui-old1234-api" for step in payload["steps"])


def test_stale_port_owner_detection_matches_next_server(monkeypatch, tmp_path: Path) -> None:
    home = tmp_path / ".semibot"
    monkeypatch.setenv("SEMIBOT_HOME", str(home))

    loader = ProductConfigLoader()
    loader.ensure_layout(force=True)

    stack = LocalProductStack(StackOptions(wait_for_health=False))

    assert stack._is_semibot_managed_command("next-server (v14.2.20)")
