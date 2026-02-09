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
                timeout=30,
                max_retries=5,
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
        with pytest.raises(ValueError, match="messages cannot be empty"):
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

        with pytest.raises(Exception, match="API Error"):
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
