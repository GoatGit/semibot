"""Tests for Anthropic LLM Provider."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from src.llm.base import LLMConfig
from src.llm.anthropic_provider import AnthropicProvider


class TestAnthropicProviderInit:
    """Tests for Anthropic provider initialization."""

    def test_init_with_config(self):
        """Should initialize with config."""
        with patch("src.llm.anthropic_provider.AsyncAnthropic"):
            config = LLMConfig(
                model="claude-3-5-sonnet-20241022",
                api_key="sk-ant-test",
                temperature=0.5,
            )
            provider = AnthropicProvider(config)

            assert provider.model == "claude-3-5-sonnet-20241022"
            assert provider.config.temperature == 0.5

    def test_init_creates_client(self):
        """Should create AsyncAnthropic client."""
        with patch("src.llm.anthropic_provider.AsyncAnthropic") as mock_client:
            config = LLMConfig(
                model="claude-3-5-sonnet-20241022",
                api_key="sk-ant-test",
                timeout=30,
                max_retries=5,
            )
            AnthropicProvider(config)

            mock_client.assert_called_once_with(
                api_key="sk-ant-test",
                base_url=None,
                timeout=30,
                max_retries=5,
            )

    def test_init_passes_base_url(self):
        """Should pass configured base_url through to AsyncAnthropic."""
        with patch("src.llm.anthropic_provider.AsyncAnthropic") as mock_client:
            config = LLMConfig(
                model="claude-3-5-sonnet-20241022",
                api_key="sk-ant-test",
                base_url="https://gaccodeapi.com/v1",
            )
            AnthropicProvider(config)

            mock_client.assert_called_once_with(
                api_key="sk-ant-test",
                base_url="https://gaccodeapi.com",
                timeout=30,
                max_retries=3,
            )


class TestAnthropicProviderChat:
    """Tests for Anthropic provider chat method."""

    @pytest.fixture
    def provider(self, mock_anthropic_client):
        """Create provider with mocked client."""
        with patch("src.llm.anthropic_provider.AsyncAnthropic"):
            config = LLMConfig(model="claude-3-5-sonnet-20241022", api_key="sk-ant-test")
            provider = AnthropicProvider(config)
            provider.client = mock_anthropic_client
            return provider

    @pytest.mark.asyncio
    async def test_chat_success(self, provider, sample_messages):
        """Should return LLMResponse on success."""
        response = await provider.chat(sample_messages)

        assert response.content == "Test response"
        assert response.model == "claude-3-sonnet"
        assert response.tokens_input == 10
        assert response.tokens_output == 5

    @pytest.mark.asyncio
    async def test_chat_validates_messages(self, provider):
        """Should validate messages before sending."""
        with pytest.raises(Exception, match="messages cannot be empty|RetryError"):
            await provider.chat([])

    @pytest.mark.asyncio
    async def test_chat_extracts_system_message(self, provider, sample_messages):
        """Should extract system message and pass separately."""
        await provider.chat(sample_messages)

        call_args = provider.client.messages.create.call_args
        assert call_args.kwargs["system"] == "You are a helpful assistant."
        # Chat messages should not include system message
        messages = call_args.kwargs["messages"]
        assert all(m["role"] != "system" for m in messages)

    @pytest.mark.asyncio
    async def test_chat_with_json_response_format(self, provider, sample_messages):
        """Should append JSON instruction to system message."""
        await provider.chat(
            sample_messages,
            response_format={"type": "json_object"},
        )

        call_args = provider.client.messages.create.call_args
        system = call_args.kwargs["system"]
        assert "valid JSON" in system

    @pytest.mark.asyncio
    async def test_chat_temperature_clamped(self, provider, sample_messages):
        """Should clamp temperature to max 1.0 for Anthropic."""
        await provider.chat(sample_messages, temperature=1.5)

        call_args = provider.client.messages.create.call_args
        assert call_args.kwargs["temperature"] == 1.0

    @pytest.mark.asyncio
    async def test_chat_preserves_temperature_zero(self, provider, sample_messages):
        await provider.chat(sample_messages, temperature=0)

        call_args = provider.client.messages.create.call_args
        assert call_args.kwargs["temperature"] == 0

    @pytest.mark.asyncio
    async def test_chat_uses_model_override(self, provider, sample_messages):
        await provider.chat(sample_messages, model="claude-3-haiku")

        call_args = provider.client.messages.create.call_args
        assert call_args.kwargs["model"] == "claude-3-haiku"

    @pytest.mark.asyncio
    async def test_chat_merges_multiple_system_messages(self, provider):
        messages = [
            {"role": "system", "content": "persona"},
            {"role": "system", "content": "json rules"},
            {"role": "user", "content": "hello"},
        ]

        await provider.chat(messages)

        call_args = provider.client.messages.create.call_args
        assert call_args.kwargs["system"] == "persona\n\njson rules"

    @pytest.mark.asyncio
    async def test_chat_with_tools(self, provider, sample_messages, sample_tools):
        """Should convert and pass tools to API."""
        await provider.chat(sample_messages, tools=sample_tools)

        call_args = provider.client.messages.create.call_args
        tools = call_args.kwargs["tools"]

        assert len(tools) == 2
        assert tools[0]["name"] == "web_search"
        assert "input_schema" in tools[0]

    @pytest.mark.asyncio
    async def test_chat_with_tool_use_response(self, provider, sample_messages):
        """Should parse tool use from response."""
        # Setup mock response with tool use
        mock_tool_block = MagicMock()
        mock_tool_block.type = "tool_use"
        mock_tool_block.id = "toolu_123"
        mock_tool_block.name = "web_search"
        mock_tool_block.input = {"query": "test"}

        mock_response = MagicMock()
        mock_response.content = [mock_tool_block]
        mock_response.model = "claude-3-sonnet"
        mock_response.usage = MagicMock()
        mock_response.usage.input_tokens = 10
        mock_response.usage.output_tokens = 5
        mock_response.stop_reason = "tool_use"

        provider.client.messages.create = AsyncMock(return_value=mock_response)

        response = await provider.chat(sample_messages)

        assert len(response.tool_calls) == 1
        assert response.tool_calls[0]["id"] == "toolu_123"
        assert response.tool_calls[0]["function"]["name"] == "web_search"

    @pytest.mark.asyncio
    async def test_chat_error_handling(self, provider, sample_messages):
        """Should raise exception on API error."""
        provider.client.messages.create = AsyncMock(
            side_effect=Exception("API Error")
        )

        with pytest.raises(Exception, match="API Error|RetryError"):
            await provider.chat(sample_messages)


class TestAnthropicProviderMessageConversion:
    """Tests for Anthropic message conversion."""

    @pytest.fixture
    def provider(self):
        """Create provider for testing."""
        with patch("src.llm.anthropic_provider.AsyncAnthropic"):
            config = LLMConfig(model="claude-3-sonnet", api_key="sk-ant-test")
            return AnthropicProvider(config)

    def test_convert_user_message(self, provider):
        """Should convert user message."""
        msg = {"role": "user", "content": "Hello"}
        result = provider._convert_message(msg)

        assert result["role"] == "user"
        assert result["content"] == "Hello"

    def test_convert_assistant_message(self, provider):
        """Should convert assistant message."""
        msg = {"role": "assistant", "content": "Hi there"}
        result = provider._convert_message(msg)

        assert result["role"] == "assistant"
        assert result["content"] == "Hi there"

    def test_collapse_historical_tool_rounds_keeps_only_latest_structured_round(self, provider):
        messages = [
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "batch 1"},
                    {"type": "tool_use", "id": "tooluse_a", "name": "search", "input": {"query": "q1"}},
                ],
            },
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": "tooluse_a", "content": "result a"},
                ],
            },
            {
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "id": "tooluse_b", "name": "search", "input": {"query": "q2"}},
                ],
            },
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": "tooluse_b", "content": "result b"},
                ],
            },
        ]

        collapsed = provider._collapse_historical_tool_rounds(messages)

        assert len(collapsed) == 4
        assert collapsed[0]["role"] == "assistant"
        assert isinstance(collapsed[0]["content"], str)
        assert "previous tool_use" in collapsed[0]["content"]
        assert collapsed[1]["role"] == "user"
        assert isinstance(collapsed[1]["content"], str)
        assert "previous tool_result" in collapsed[1]["content"]
        assert collapsed[2]["role"] == "assistant"
        assert isinstance(collapsed[2]["content"], list)
        assert collapsed[2]["content"][0]["type"] == "tool_use"
        assert collapsed[3]["role"] == "user"
        assert isinstance(collapsed[3]["content"], list)
        assert collapsed[3]["content"][0]["type"] == "tool_result"

    def test_convert_assistant_message_with_tool_calls(self, provider):
        msg = {
            "role": "assistant",
            "content": "Using tool",
            "tool_calls": [
                {
                    "id": "call_123",
                    "function": {"name": "web_search", "arguments": '{"query":"test"}'},
                }
            ],
        }
        result = provider._convert_message(msg)

        assert result["role"] == "assistant"
        assert result["content"][0]["type"] == "text"
        assert result["content"][1]["type"] == "tool_use"
        assert result["content"][1]["name"] == "web_search"
        assert result["content"][1]["input"] == {"query": "test"}

    def test_convert_tool_result_message(self, provider):
        """Should convert tool result message."""
        msg = {
            "role": "tool",
            "content": "Result data",
            "tool_call_id": "call_123",
        }
        result = provider._convert_message(msg)

        assert result["role"] == "user"
        assert result["content"][0]["type"] == "tool_result"
        assert result["content"][0]["tool_use_id"] == "call_123"

    def test_convert_skill_context_tool_message(self, provider):
        """Should downgrade synthetic skill-context tool message to user content."""
        msg = {
            "role": "tool",
            "name": "tools/skill_context/deep-research",
            "tool_call_id": "skill_ctx_deep_research",
            "content": "<skill_md>...</skill_md>",
        }
        result = provider._convert_message(msg)

        assert result["role"] == "user"
        assert "[TOOL_CONTEXT tools/skill_context/deep-research]" in result["content"]


class TestAnthropicProviderToolConversion:
    """Tests for Anthropic tool conversion."""

    @pytest.fixture
    def provider(self):
        """Create provider for testing."""
        with patch("src.llm.anthropic_provider.AsyncAnthropic"):
            config = LLMConfig(model="claude-3-sonnet", api_key="sk-ant-test")
            return AnthropicProvider(config)

    def test_convert_simple_tools(self, provider, sample_tools):
        """Should convert simple format to Anthropic format."""
        converted = provider._convert_tools(sample_tools)

        assert len(converted) == 2
        assert converted[0]["name"] == "web_search"
        assert converted[0]["description"] == "Search the web for information"
        assert "input_schema" in converted[0]

    def test_convert_openai_format_tools(self, provider):
        """Should convert OpenAI format to Anthropic format."""
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "test",
                    "description": "Test tool",
                    "parameters": {"type": "object"},
                },
            }
        ]
        converted = provider._convert_tools(tools)

        assert converted[0]["name"] == "test"
        assert converted[0]["description"] == "Test tool"
        assert converted[0]["input_schema"] == {"type": "object"}

    def test_convert_already_anthropic_format(self, provider):
        """Should keep tools already in Anthropic format."""
        tools = [
            {
                "name": "test",
                "description": "Test tool",
                "input_schema": {"type": "object"},
            }
        ]
        converted = provider._convert_tools(tools)

        assert converted == tools
