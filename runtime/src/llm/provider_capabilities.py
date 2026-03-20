"""Provider capability resolution for orchestrator compatibility decisions."""

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ProviderCapabilities:
    """LLM provider behavior flags used by orchestrator nodes."""

    supports_tools_with_structured_output: bool = True
    prefers_two_phase_tool_then_json: bool = False
    # Whether the provider supports response_format={"type":"json_schema",...}.
    # Providers that only support {"type":"json_object"} should set this False.
    supports_json_schema_response_format: bool = True
    # Whether the provider accepts the response_format parameter at all.
    # Some OpenAI-compatible proxies reject any response_format with 400.
    supports_response_format_param: bool = True


def resolve_provider_capabilities(
    *,
    llm_provider: Any,
    model: str | None = None,
) -> ProviderCapabilities:
    """
    Resolve orchestration-facing capabilities for the active provider/model.

    Current policy:
    - Moonshot/Kimi style providers are treated as two-phase because tool calls
      become unreliable when strict structured-output constraints are applied in
      the same turn.
    - Claude models (accessed via OpenAI-compatible proxy) are downgraded to
      json_object because most proxy gateways don't honor json_schema semantics.
    - Other providers keep the current single-phase behavior by default.
    """

    provider_class = llm_provider.__class__.__name__.lower() if llm_provider is not None else ""
    config = getattr(llm_provider, "config", None)
    provider_base = str(getattr(config, "provider_base", "") or "").strip().lower()
    base_url = str(getattr(config, "base_url", "") or "").lower()
    model_name = str(model or getattr(config, "model", "") or "").lower()

    if not provider_base:
        if provider_class == "kimiprovider":
            provider_base = "kimi"
        elif provider_class == "anthropicprovider":
            provider_base = "anthropic"
        elif provider_class == "openaiprovider":
            provider_base = "openai"

    is_kimi_like = (
        provider_base == "kimi"
        or "moonshot.cn" in base_url
        or model_name.startswith("kimi")
    )

    if is_kimi_like:
        return ProviderCapabilities(
            supports_tools_with_structured_output=False,
            prefers_two_phase_tool_then_json=True,
            # Kimi/Moonshot only supports {"type":"json_object"}, not json_schema.
            supports_json_schema_response_format=False,
        )

    # Claude models via native AnthropicProvider: json_schema is implemented via
    # forced tool_use in the provider itself — fully supported.
    # Claude via OpenAI-compatible proxy (provider_base="custom"/"openai"): the proxy
    # may not honor json_schema, so downgrade to json_object.
    is_native_anthropic = (
        provider_base == "anthropic"
        or "api.anthropic.com" in base_url
        or provider_class == "anthropicprovider"
    )
    if is_native_anthropic:
        return ProviderCapabilities(
            supports_tools_with_structured_output=True,
            prefers_two_phase_tool_then_json=False,
            supports_json_schema_response_format=True,
        )

    is_claude_via_proxy = model_name.startswith("claude")
    if is_claude_via_proxy:
        return ProviderCapabilities(
            supports_tools_with_structured_output=True,
            prefers_two_phase_tool_then_json=False,
            supports_json_schema_response_format=False,
            # Claude via proxy: many proxies reject response_format entirely.
            # Use system-prompt JSON hint instead.
            supports_response_format_param=False,
        )

    return ProviderCapabilities()
