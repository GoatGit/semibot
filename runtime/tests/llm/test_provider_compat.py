from types import SimpleNamespace

from src.llm.provider_capabilities import resolve_provider_capabilities
from src.llm.provider_compat import resolve_act_execution_strategy, resolve_plan_execution_strategy

_JSON_OBJECT_FORMAT = {"type": "json_object"}
_JSON_SCHEMA_FORMAT = {"type": "json_schema", "json_schema": {"name": "act_response"}}


def _provider(*, base_url: str = "", model: str = "", class_name: str = "MockProvider", provider_base: str = ""):
    provider_cls = type(class_name, (), {})
    provider = provider_cls()
    if not provider_base:
        if class_name == "AnthropicProvider":
            provider_base = "anthropic"
        elif class_name == "KimiProvider":
            provider_base = "kimi"
        elif class_name == "OpenAIProvider":
            provider_base = "openai"
    provider.config = SimpleNamespace(base_url=base_url, model=model, provider_base=provider_base)
    return provider


def test_resolve_provider_capabilities_marks_kimi_like_provider_as_two_phase():
    provider = _provider(base_url="https://api.moonshot.cn/v1", model="kimi-k2.5")

    caps = resolve_provider_capabilities(llm_provider=provider, model="kimi-k2.5")

    assert caps.prefers_two_phase_tool_then_json is True
    assert caps.supports_tools_with_structured_output is False
    assert caps.supports_json_schema_response_format is False


def test_resolve_provider_capabilities_native_anthropic_supports_json_schema():
    # AnthropicProvider implements json_schema via forced tool_use — fully supported.
    provider = _provider(
        base_url="https://api.anthropic.com/v1",
        model="claude-sonnet-4-6",
        class_name="AnthropicProvider",
    )

    caps = resolve_provider_capabilities(llm_provider=provider, model="claude-sonnet-4-6")

    assert caps.prefers_two_phase_tool_then_json is False
    assert caps.supports_tools_with_structured_output is True
    assert caps.supports_json_schema_response_format is True


def test_resolve_provider_capabilities_claude_via_proxy_downgrades_to_json_object():
    # Claude Sonnet via OpenAI-compatible proxy: proxy rejects response_format entirely.
    provider = _provider(
        base_url="https://my-proxy.example.com/v1",
        model="claude-sonnet-4-6",
        class_name="OpenAIProvider",
    )

    caps = resolve_provider_capabilities(llm_provider=provider, model="claude-sonnet-4-6")

    assert caps.prefers_two_phase_tool_then_json is False
    assert caps.supports_tools_with_structured_output is True
    assert caps.supports_json_schema_response_format is False
    assert caps.supports_response_format_param is False


def test_resolve_act_execution_strategy_uses_two_phase_for_kimi_like_provider():
    provider = _provider(base_url="https://api.moonshot.cn/v1", model="kimi-k2.5")
    terminal_format = {"type": "json_schema", "json_schema": {"name": "act_response"}}

    strategy = resolve_act_execution_strategy(
        llm_provider=provider,
        model="kimi-k2.5",
        terminal_response_format=terminal_format,
    )

    assert strategy.two_phase is True
    assert strategy.tool_phase_response_format is None
    assert strategy.terminal_phase_response_format == _JSON_OBJECT_FORMAT


def test_resolve_plan_execution_strategy_uses_two_phase_for_kimi_like_provider():
    provider = _provider(base_url="https://api.moonshot.cn/v1", model="kimi-k2.5")
    terminal_format = {"type": "json_schema", "json_schema": {"name": "planner_response"}}

    strategy = resolve_plan_execution_strategy(
        llm_provider=provider,
        model="kimi-k2.5",
        terminal_response_format=terminal_format,
    )

    assert strategy.two_phase is True
    assert strategy.tool_phase_response_format is None
    assert strategy.terminal_phase_response_format == _JSON_OBJECT_FORMAT


def test_resolve_act_execution_strategy_native_anthropic_preserves_json_schema():
    # AnthropicProvider supports json_schema natively — terminal format is NOT downgraded.
    provider = _provider(
        base_url="https://api.anthropic.com/v1",
        model="claude-sonnet-4-6",
        class_name="AnthropicProvider",
    )
    terminal_format = {"type": "json_schema", "json_schema": {"name": "act_response"}}

    strategy = resolve_act_execution_strategy(
        llm_provider=provider,
        model="claude-sonnet-4-6",
        terminal_response_format=terminal_format,
    )

    assert strategy.two_phase is True
    assert strategy.tool_phase_response_format is None
    assert strategy.terminal_phase_response_format == terminal_format


def test_resolve_plan_execution_strategy_native_anthropic_preserves_json_schema():
    provider = _provider(
        base_url="https://api.anthropic.com/v1",
        model="claude-sonnet-4-6",
        class_name="AnthropicProvider",
    )
    terminal_format = {"type": "json_schema", "json_schema": {"name": "planner_response"}}

    strategy = resolve_plan_execution_strategy(
        llm_provider=provider,
        model="claude-sonnet-4-6",
        terminal_response_format=terminal_format,
    )

    assert strategy.two_phase is True
    assert strategy.tool_phase_response_format is None
    assert strategy.terminal_phase_response_format == terminal_format


def test_resolve_act_execution_strategy_claude_via_proxy_downgrades_to_json_object():
    # Claude via proxy: response_format param rejected entirely → terminal format is None.
    provider = _provider(
        base_url="https://my-proxy.example.com/v1",
        model="claude-sonnet-4-6",
        class_name="OpenAIProvider",
    )
    terminal_format = {"type": "json_schema", "json_schema": {"name": "act_response"}}

    strategy = resolve_act_execution_strategy(
        llm_provider=provider,
        model="claude-sonnet-4-6",
        terminal_response_format=terminal_format,
    )

    assert strategy.two_phase is True
    assert strategy.tool_phase_response_format is None
    assert strategy.terminal_phase_response_format is None


def test_resolve_plan_execution_strategy_claude_via_proxy_downgrades_to_json_object():
    # Claude via proxy: response_format param rejected entirely → terminal format is None.
    provider = _provider(
        base_url="https://my-proxy.example.com/v1",
        model="claude-sonnet-4-6",
        class_name="OpenAIProvider",
    )
    terminal_format = {"type": "json_schema", "json_schema": {"name": "planner_response"}}

    strategy = resolve_plan_execution_strategy(
        llm_provider=provider,
        model="claude-sonnet-4-6",
        terminal_response_format=terminal_format,
    )

    assert strategy.two_phase is True
    assert strategy.tool_phase_response_format is None
    assert strategy.terminal_phase_response_format is None
