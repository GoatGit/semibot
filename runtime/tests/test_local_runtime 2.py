"""Tests for local runtime helpers."""

from __future__ import annotations

from src.llm.base import LLMConfig
from src.local_runtime import _create_llm_provider


def test_create_llm_provider_reads_llm_config_file(monkeypatch, tmp_path) -> None:
    config_path = tmp_path / "config.toml"
    config_path.write_text(
        '[llm]\n'
        'default_model = "gpt-4o-mini"\n'
        'api_key = "config-key"\n'
        'base_url = "http://localhost:11434"\n',
        encoding="utf-8",
    )

    monkeypatch.setenv("SEMIBOT_CONFIG", str(config_path))
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("CUSTOM_LLM_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_BASE_URL", raising=False)
    monkeypatch.delenv("CUSTOM_LLM_API_BASE_URL", raising=False)
    monkeypatch.delenv("CUSTOM_LLM_MODEL_NAME", raising=False)
    monkeypatch.setattr("src.local_runtime.OpenAIProvider", lambda cfg: cfg)

    provider_cfg = _create_llm_provider()

    assert isinstance(provider_cfg, LLMConfig)
    assert provider_cfg.api_key == "config-key"
    assert provider_cfg.model == "gpt-4o-mini"
    assert provider_cfg.base_url == "http://localhost:11434/v1"


def test_create_llm_provider_prefers_explicit_model_override(monkeypatch, tmp_path) -> None:
    config_path = tmp_path / "config.toml"
    config_path.write_text(
        '[llm]\n'
        'default_model = "from-config"\n'
        'api_key = "config-key"\n',
        encoding="utf-8",
    )

    monkeypatch.setenv("SEMIBOT_CONFIG", str(config_path))
    monkeypatch.setenv("CUSTOM_LLM_MODEL_NAME", "from-env")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("CUSTOM_LLM_API_KEY", raising=False)
    monkeypatch.setattr("src.local_runtime.OpenAIProvider", lambda cfg: cfg)

    provider_cfg = _create_llm_provider("from-arg")

    assert isinstance(provider_cfg, LLMConfig)
    assert provider_cfg.model == "from-arg"


def test_create_llm_provider_returns_none_without_api_key(monkeypatch, tmp_path) -> None:
    config_path = tmp_path / "config.toml"
    config_path.write_text('[llm]\ndefault_model = "gpt-4o"\n', encoding="utf-8")

    monkeypatch.setenv("SEMIBOT_CONFIG", str(config_path))
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("CUSTOM_LLM_API_KEY", raising=False)

    assert _create_llm_provider() is None
