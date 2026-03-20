"""Shared provider protocol resolution for runtime LLM instantiation."""

from __future__ import annotations

from src.utils.logging import get_logger

logger = get_logger(__name__)

# Provider bases that use the OpenAI-compatible wire protocol.
_OPENAI_PROTOCOL_PROVIDER_BASES = {
    "openai",
    "custom",
    "qwen",
    "minimax",
    "xai",
    "google",
}

# All supported provider bases (including native-protocol ones like anthropic/kimi).
SUPPORTED_PROVIDER_BASES: tuple[str, ...] = (
    "openai",
    "anthropic",
    "kimi",
    "qwen",
    "minimax",
    "xai",
    "custom",
)

# Mapping from provider base to the env var that holds its API key.
PROVIDER_KEY_ENV_MAP: dict[str, str] = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "kimi": "KIMI_API_KEY",
    "qwen": "QWEN_API_KEY",
    "minimax": "MINIMAX_API_KEY",
    "xai": "XAI_API_KEY",
    "custom": "CUSTOM_LLM_API_KEY",
}

# Mapping from provider base to the env var that holds its base URL.
PROVIDER_BASE_URL_ENV_MAP: dict[str, str] = {
    "openai": "OPENAI_API_BASE_URL",
    "anthropic": "ANTHROPIC_API_BASE_URL",
    "kimi": "KIMI_API_BASE_URL",
    "qwen": "QWEN_API_BASE_URL",
    "minimax": "MINIMAX_API_BASE_URL",
    "xai": "XAI_API_BASE_URL",
    "custom": "CUSTOM_LLM_API_BASE_URL",
}

# Model name tokens that hint at a specific provider base.
MODEL_PROVIDER_HINTS: dict[str, tuple[str, ...]] = {
    "anthropic": ("claude",),
    "kimi": ("kimi", "moonshot", "k1", "k2"),
    "qwen": ("qwen", "qwq"),
    "minimax": ("minimax", "abab", "m1", "m2"),
    "xai": ("grok", "xai"),
    "openai": ("gpt", "o1", "o3", "o4", "chatgpt"),
}


def resolve_provider_protocol(provider_base: str, base_url: str | None = None) -> str:
    base = str(provider_base or "").strip().lower()
    url = str(base_url or "").strip().lower()
    if base == "kimi" or "moonshot.cn" in url:
        return "kimi"
    if base == "anthropic" or "api.anthropic.com" in url:
        return "anthropic"
    if base in _OPENAI_PROTOCOL_PROVIDER_BASES:
        return "openai"
    logger.warning(
        "unknown_provider_base_falling_back_to_openai_protocol",
        extra={"provider_base": base or None, "base_url": url or None},
    )
    return "openai"


def infer_provider_base_from_model(model: str) -> str | None:
    """Infer the most likely provider base from a model name."""
    model_lower = str(model or "").strip().lower()
    if not model_lower:
        return None
    for base in MODEL_PROVIDER_HINTS:
        hints = MODEL_PROVIDER_HINTS.get(base, ())
        if hints and any(token in model_lower for token in hints):
            return base
    return None
