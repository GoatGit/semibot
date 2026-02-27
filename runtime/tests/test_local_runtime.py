"""Tests for local runtime helpers."""

from __future__ import annotations

import os

import pytest

from src.llm.base import LLMConfig
from src.local_runtime import (
    _build_approval_policy,
    _create_llm_provider,
    _maybe_bootstrap_llm_from_control_plane,
    _maybe_load_local_env_files,
)


def test_create_llm_provider_reads_env(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "env-key")
    monkeypatch.setenv("CUSTOM_LLM_MODEL_NAME", "gpt-4o-mini")
    monkeypatch.setenv("OPENAI_API_BASE_URL", "http://localhost:11434")
    monkeypatch.setattr("src.local_runtime.OpenAIProvider", lambda cfg: cfg)

    provider_cfg = _create_llm_provider()

    assert isinstance(provider_cfg, LLMConfig)
    assert provider_cfg.api_key == "env-key"
    assert provider_cfg.model == "gpt-4o-mini"
    assert provider_cfg.base_url == "http://localhost:11434/v1"


def test_create_llm_provider_prefers_explicit_model_override(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "env-key")
    monkeypatch.setenv("CUSTOM_LLM_MODEL_NAME", "from-env")
    monkeypatch.setattr("src.local_runtime.OpenAIProvider", lambda cfg: cfg)

    provider_cfg = _create_llm_provider("from-arg")

    assert isinstance(provider_cfg, LLMConfig)
    assert provider_cfg.model == "from-arg"


def test_create_llm_provider_reads_config_when_env_missing(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("CUSTOM_LLM_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_BASE_URL", raising=False)
    monkeypatch.delenv("CUSTOM_LLM_API_BASE_URL", raising=False)
    monkeypatch.delenv("CUSTOM_LLM_MODEL_NAME", raising=False)

    config_path = tmp_path / "config.toml"
    config_path.write_text(
        '[llm]\n'
        'api_key = "cfg-key"\n'
        'default_model = "gpt-4o-mini"\n'
        'api_base_url = "http://localhost:11434"\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("SEMIBOT_CONFIG_PATH", str(config_path))
    monkeypatch.setattr("src.local_runtime.OpenAIProvider", lambda cfg: cfg)

    provider_cfg = _create_llm_provider()

    assert isinstance(provider_cfg, LLMConfig)
    assert provider_cfg.api_key == "cfg-key"
    assert provider_cfg.model == "gpt-4o-mini"
    assert provider_cfg.base_url == "http://localhost:11434/v1"


@pytest.mark.asyncio
async def test_ws_bootstrap_applies_init_data_to_env(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("CUSTOM_LLM_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_BASE_URL", raising=False)
    monkeypatch.delenv("CUSTOM_LLM_API_BASE_URL", raising=False)
    monkeypatch.delenv("CUSTOM_LLM_MODEL_NAME", raising=False)
    monkeypatch.setenv("VM_USER_ID", "user-1")
    monkeypatch.setenv("VM_TOKEN", "token-1")
    monkeypatch.setenv("CONTROL_PLANE_WS", "ws://localhost:3001/ws/vm")

    monkeypatch.setattr("src.local_runtime._CONTROL_PLANE_BOOTSTRAP_LAST_ATTEMPT", 0.0)
    monkeypatch.setattr("src.local_runtime._CONTROL_PLANE_BOOTSTRAP_LOCK", None)

    class _FakeClient:
        def __init__(self, **_kwargs):
            pass

        async def connect(self):
            return {
                "api_keys": {"openai": {"alg": "aes-256-gcm"}},
                "llm_config": {
                    "default_model": "gpt-4o-mini",
                    "providers": {
                        "openai": {"base_url": "http://localhost:1234"},
                    },
                },
            }

        async def close(self):
            return None

    monkeypatch.setattr("src.local_runtime.ControlPlaneClient", _FakeClient)
    monkeypatch.setattr("src.local_runtime.decrypt_api_keys", lambda _payload, _token: {"openai": "ws-key"})

    await _maybe_bootstrap_llm_from_control_plane()

    assert os.getenv("OPENAI_API_KEY") == "ws-key"
    assert os.getenv("CUSTOM_LLM_MODEL_NAME") == "gpt-4o-mini"
    assert os.getenv("OPENAI_API_BASE_URL") == "http://localhost:1234"


def test_load_local_env_files_reads_repo_env(monkeypatch, tmp_path) -> None:
    repo_dir = tmp_path / "repo"
    runtime_dir = tmp_path / "runtime"
    repo_dir.mkdir()
    runtime_dir.mkdir()
    (repo_dir / ".env.local").write_text(
        'CUSTOM_LLM_API_KEY="repo-key"\n'
        'CUSTOM_LLM_MODEL_NAME="repo-model"\n',
        encoding="utf-8",
    )

    monkeypatch.delenv("CUSTOM_LLM_API_KEY", raising=False)
    monkeypatch.delenv("CUSTOM_LLM_MODEL_NAME", raising=False)
    monkeypatch.setattr("src.local_runtime._repo_root", lambda: repo_dir)
    monkeypatch.setattr("src.local_runtime._runtime_root", lambda: runtime_dir)
    monkeypatch.setattr("src.local_runtime._LOCAL_ENV_BOOTSTRAP_DONE", False)

    _maybe_load_local_env_files()

    assert os.getenv("CUSTOM_LLM_API_KEY") == "repo-key"
    assert os.getenv("CUSTOM_LLM_MODEL_NAME") == "repo-model"


def test_create_llm_provider_returns_none_without_api_key(monkeypatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("CUSTOM_LLM_API_KEY", raising=False)
    monkeypatch.delenv("SEMIBOT_CONFIG_PATH", raising=False)

    assert _create_llm_provider() is None


def test_build_approval_policy_uses_generic_session_action_scope() -> None:
    scope_key, context = _build_approval_policy(
        "browser_automation",
        {"action": "open", "session_id": "s1", "url": "https://example.com"},
        "high",
        "s1",
        {},
    )

    assert scope_key == "browser_automation|risk:high|session:s1"
    assert context["summary"] == "工具 `browser_automation` 执行动作 `open`，目标 `https://example.com`"


def test_build_approval_policy_supports_generic_custom_dedupe_keys() -> None:
    scope_key, context = _build_approval_policy(
        "any_tool",
        {"operation": "sync", "resource_id": "abc-1", "value": 42},
        "medium",
        "chat-1",
        {"approval_dedupe_keys": ["resource_id"], "approval_scope": "call"},
    )

    assert scope_key == "any_tool|risk:medium|custom:resource_id=abc-1"
    assert context["action"] == "sync"
