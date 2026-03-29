from __future__ import annotations

from typing import Any

from src.llm.anthropic_provider import AnthropicProvider
from src.llm.base import LLMConfig, LLMProvider
from src.llm.kimi_provider import KimiProvider
from src.llm.openai_provider import OpenAIProvider
from src.llm.provider_factory import infer_provider_base_from_model, resolve_provider_protocol


def as_non_empty_str(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed or None


def provider_base(provider_key: str) -> str:
    return str(provider_key or "").strip().lower().split(":", 1)[0]


def provider_cfg_base_url(raw_cfg: Any) -> str | None:
    if not isinstance(raw_cfg, dict):
        return None
    base_url = raw_cfg.get("base_url") or raw_cfg.get("baseUrl")
    if not isinstance(base_url, str):
        return None
    trimmed = base_url.strip()
    return trimmed or None


def infer_openai_compatible_provider_base(model: str) -> str | None:
    return infer_provider_base_from_model(model)


def pick_openai_compatible_provider_key(
    model: str,
    api_keys: dict[str, str],
    compatible_provider_bases: set[str],
    *,
    strict_preferred_base: bool = False,
) -> str | None:
    candidates = [
        key
        for key, value in api_keys.items()
        if value and provider_base(key) in compatible_provider_bases
    ]
    if not candidates:
        return None

    preferred_base = infer_openai_compatible_provider_base(model)
    if preferred_base:
        if preferred_base in api_keys and api_keys.get(preferred_base):
            return preferred_base
        scoped = sorted(key for key in candidates if key.startswith(f"{preferred_base}:"))
        if scoped:
            return scoped[0]
        if strict_preferred_base:
            return None

    for base in compatible_provider_bases:
        if base in api_keys and api_keys.get(base):
            return base
        scoped = sorted(key for key in candidates if key.startswith(f"{base}:"))
        if scoped:
            return scoped[0]

    return sorted(candidates)[0]


def instantiate_llm_provider(
    *,
    model: str,
    api_key: str,
    provider_key: str,
    base_url: str | None,
    timeout: int = 120,
    openai_provider_cls: type[LLMProvider] = OpenAIProvider,
    kimi_provider_cls: type[LLMProvider] = KimiProvider,
    anthropic_provider_cls: type[LLMProvider] = AnthropicProvider,
) -> LLMProvider:
    normalized_provider_base = provider_base(provider_key)
    protocol = resolve_provider_protocol(normalized_provider_base, base_url)
    provider_cls = (
        kimi_provider_cls
        if protocol == "kimi"
        else anthropic_provider_cls
        if protocol == "anthropic"
        else openai_provider_cls
    )
    return provider_cls(
        LLMConfig(
            model=model,
            api_key=api_key,
            base_url=base_url,
            provider_base=normalized_provider_base,
            timeout=timeout,
        )
    )
