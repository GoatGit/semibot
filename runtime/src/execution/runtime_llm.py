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


def provider_matches_model(provider_key: str, model: str) -> bool:
    preferred = infer_openai_compatible_provider_base(str(model or ""))
    if not preferred:
        return True
    return provider_base(provider_key) == preferred


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


def select_provider_for_model(
    model: str,
    api_keys: dict[str, str],
    compatible_provider_bases: set[str],
) -> str | None:
    strict = pick_openai_compatible_provider_key(
        str(model or ""),
        api_keys,
        compatible_provider_bases,
        strict_preferred_base=True,
    )
    if strict:
        return strict

    relaxed = pick_openai_compatible_provider_key(
        str(model or ""),
        api_keys,
        compatible_provider_bases,
    )
    if not relaxed:
        return None

    if provider_base(relaxed) != "custom":
        return None

    has_non_custom_provider = any(
        provider_base(key) != "custom" and bool(value)
        for key, value in api_keys.items()
    )
    return None if has_non_custom_provider else relaxed


def resolve_model_and_provider_key(
    *,
    requested_model: str | None,
    default_model: str | None,
    default_provider_key: str | None,
    api_keys: dict[str, str],
    compatible_provider_bases: set[str],
) -> tuple[str | None, str | None, bool]:
    resolved_model = str(requested_model or "").strip() or str(default_model or "").strip() or None
    default_provider = str(default_provider_key or "").strip() or None
    if not resolved_model:
        return None, None, False

    selected_provider_key: str | None = None
    if (
        default_model
        and str(resolved_model).strip() == str(default_model).strip()
        and default_provider
        and api_keys.get(default_provider)
        and provider_matches_model(default_provider, resolved_model)
    ):
        selected_provider_key = default_provider

    if not selected_provider_key:
        selected_provider_key = select_provider_for_model(
            resolved_model,
            api_keys,
            compatible_provider_bases,
        )

    used_default_model_fallback = False
    explicit_model = str(requested_model or "").strip() or None
    default_model_text = str(default_model or "").strip() or None
    if explicit_model and default_model_text:
        strict_provider_for_explicit_model = pick_openai_compatible_provider_key(
            explicit_model,
            api_keys,
            compatible_provider_bases,
            strict_preferred_base=True,
        )
        if strict_provider_for_explicit_model is None:
            fallback_provider = (
                default_provider
                if (
                    default_provider
                    and api_keys.get(default_provider)
                    and provider_matches_model(default_provider, default_model_text)
                )
                else pick_openai_compatible_provider_key(
                    default_model_text,
                    api_keys,
                    compatible_provider_bases,
                    strict_preferred_base=True,
                )
            )
            if fallback_provider:
                resolved_model = default_model_text
                selected_provider_key = fallback_provider
                used_default_model_fallback = True

    return resolved_model, selected_provider_key, used_default_model_fallback


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
