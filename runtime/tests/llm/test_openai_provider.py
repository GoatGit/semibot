"""Tests for OpenAI LLM Provider."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from src.llm.base import LLMConfig
from src.llm.openai_provider import OpenAIProvider


class TestOpenAIProviderInit:
    """Tests for OpenAI provider initialization."""

    def test_init_with_config(self):
        """Should initialize with config."""
        with patch("src.llm.openai_provider.AsyncOpenAI"):
            config = LLMConfig(
                model="gpt-4o",
                api_key="sk-test",
                temperature=0.5,
            )
            provider = OpenAIProvider(config)

            assert provider.model == "gpt-4o"
            assert provider.config.temperature == 0.5

    def test_init_creates_client(self):
        """Should create AsyncOpenAI client."""
        with patch("src.llm.openai_provider.AsyncOpenAI") as mock_client:
            config = LLMConfig(
                model="gpt-4o",
                api_key="sk-test",
                base_url="https://api.example.com",
                timeout=30,
                max_retries=5,
            )
            OpenAIProvider(config)

            mock_client.assert_called_once_with(
                api_key="sk-test",
                base_url="https://api.example.com",
                timeout=30,
                max_retries=5,
            )


class TestOpenAIProviderChat:
    """Tests for OpenAI provider chat method."""

    @pytest.fixture
    def provider(self, mock_openai_client):
        """Create provider with mocked client."""
        with patch("src.llm.openai_provider.AsyncOpenAI"):
            config = LLMConfig(model="gpt-4o", api_key="sk-test")
            provider = OpenAIProvider(config)
            provider.client = mock_openai_client
            return provider

    @pytest.mark.asyncio
    async def test_chat_success(self, provider, sample_messages):
        """Should return LLMResponse on success."""
        response = await provider.chat(sample_messages)

        assert response.content == "Test response"
        assert response.model == "gpt-4o"
        assert response.tokens_input == 10
        assert response.tokens_output == 5

    @pytest.mark.asyncio
    async def test_chat_validates_messages(self, provider):
        """Should validate messages before sending."""
        with pytest.raises(ValueError, match="messages cannot be empty"):
            await provider.chat([])

    @pytest.mark.asyncio
    async def test_chat_with_temperature(self, provider, sample_messages):
        """Should use provided temperature."""
        await provider.chat(sample_messages, temperature=0.3)

        call_args = provider.client.chat.completions.create.call_args
        assert call_args.kwargs["temperature"] == 0.3

    @pytest.mark.asyncio
    async def test_chat_with_max_tokens(self, provider, sample_messages):
        """Should use provided max_tokens."""
        await provider.chat(sample_messages, max_tokens=500)

        call_args = provider.client.chat.completions.create.call_args
        assert call_args.kwargs["max_tokens"] == 500

    @pytest.mark.asyncio
    async def test_chat_with_response_format(self, provider, sample_messages):
        """Should pass response_format to API."""
        await provider.chat(
            sample_messages,
            response_format={"type": "json_object"},
        )

        call_args = provider.client.chat.completions.create.call_args
        assert call_args.kwargs["response_format"] == {"type": "json_object"}

    @pytest.mark.asyncio
    async def test_chat_with_tools(self, provider, sample_messages, sample_tools):
        """Should convert and pass tools to API."""
        await provider.chat(sample_messages, tools=sample_tools)

        call_args = provider.client.chat.completions.create.call_args
        tools = call_args.kwargs["tools"]

        assert len(tools) == 2
        assert tools[0]["type"] == "function"
        assert tools[0]["function"]["name"] == "web_search"

    @pytest.mark.asyncio
    async def test_chat_normalizes_skill_context_tool_message(self, provider):
        """Should downgrade synthetic skill-context tool message to user content."""
        messages = [
            {"role": "system", "content": "You are a planner."},
            {
                "role": "tool",
                "name": "tools/skill_context/deep-research",
                "tool_call_id": "skill_ctx_deep_research",
                "content": "<skill_md>content</skill_md>",
            },
            {"role": "user", "content": "请规划执行步骤"},
        ]

        await provider.chat(messages)

        call_args = provider.client.chat.completions.create.call_args
        api_messages = call_args.kwargs["messages"]
        assert api_messages[1]["role"] == "user"
        assert "[TOOL_CONTEXT tools/skill_context/deep-research]" in api_messages[1]["content"]

    @pytest.mark.asyncio
    async def test_chat_with_tool_calls_response(self, provider, sample_messages):
        """Should parse tool calls from response."""
        # Setup mock response with tool calls
        mock_tool_call = MagicMock()
        mock_tool_call.id = "call_123"
        mock_tool_call.type = "function"
        mock_tool_call.function.name = "web_search"
        mock_tool_call.function.arguments = '{"query": "test"}'

        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = None
        mock_response.choices[0].message.tool_calls = [mock_tool_call]
        mock_response.choices[0].finish_reason = "tool_calls"
        mock_response.model = "gpt-4o"
        mock_response.usage = MagicMock()
        mock_response.usage.prompt_tokens = 10
        mock_response.usage.completion_tokens = 5
        mock_response.usage.total_tokens = 15

        provider.client.chat.completions.create = AsyncMock(return_value=mock_response)

        response = await provider.chat(sample_messages)

        assert len(response.tool_calls) == 1
        assert response.tool_calls[0]["id"] == "call_123"
        assert response.tool_calls[0]["function"]["name"] == "web_search"
        assert response.finish_reason == "tool_calls"

    @pytest.mark.asyncio
    async def test_chat_error_handling(self, provider, sample_messages):
        """Should raise exception on API error."""
        provider.client.chat.completions.create = AsyncMock(
            side_effect=Exception("API Error")
        )

        with pytest.raises(Exception, match="API Error"):
            await provider.chat(sample_messages)

    @pytest.mark.asyncio
    async def test_chat_retries_without_temperature_after_constraint_error(
        self, provider, sample_messages
    ):
        first_error = Exception(
            "Error code: 400 - {'error': {'message': 'invalid temperature: only 1 is allowed for this model'}}"
        )
        second_error = Exception(
            "Error code: 400 - {'error': {'message': 'invalid temperature: only 1 is allowed for this model'}}"
        )
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "ok"
        mock_response.choices[0].message.tool_calls = []
        mock_response.choices[0].finish_reason = "stop"
        mock_response.model = "kimi-k2.5"
        mock_response.usage = MagicMock()
        mock_response.usage.prompt_tokens = 1
        mock_response.usage.completion_tokens = 1
        mock_response.usage.total_tokens = 2
        provider.client.chat.completions.create = AsyncMock(
            side_effect=[first_error, second_error, mock_response]
        )

        response = await provider.chat(sample_messages, temperature=0.7)

        assert response.content == "ok"
        calls = provider.client.chat.completions.create.call_args_list
        assert len(calls) == 3
        assert calls[1].kwargs["temperature"] == 1
        assert "temperature" not in calls[2].kwargs


class TestOpenAIProviderChatStream:
    """Tests for OpenAI provider chat_stream method."""

    @pytest.fixture
    def provider(self, mock_openai_client):
        with patch("src.llm.openai_provider.AsyncOpenAI"):
            config = LLMConfig(model="gpt-4o", api_key="sk-test")
            provider = OpenAIProvider(config)
            provider.client = mock_openai_client
            return provider

    @pytest.mark.asyncio
    async def test_chat_stream_retries_with_temperature_one_on_constraint_error(
        self, provider, sample_messages
    ):
        async def stream_once(text: str):
            chunk = MagicMock()
            chunk.choices = [MagicMock()]
            chunk.choices[0].delta.content = text
            yield chunk

        first_error = Exception(
            "Error code: 400 - {'error': {'message': 'invalid temperature: only 1 is allowed for this model'}}"
        )
        provider.client.chat.completions.create = AsyncMock(
            side_effect=[first_error, stream_once("ok")]
        )

        chunks = []
        async for chunk in provider.chat_stream(sample_messages, temperature=0.7):
            chunks.append(chunk)

        assert "".join(chunks) == "ok"
        calls = provider.client.chat.completions.create.call_args_list
        assert len(calls) == 2
        assert calls[1].kwargs["temperature"] == 1

    @pytest.mark.asyncio
    async def test_chat_stream_retries_without_temperature_when_needed(
        self, provider, sample_messages
    ):
        async def stream_once(text: str):
            chunk = MagicMock()
            chunk.choices = [MagicMock()]
            chunk.choices[0].delta.content = text
            yield chunk

        first_error = Exception(
            "Error code: 400 - {'error': {'message': 'invalid temperature: only 1 is allowed for this model'}}"
        )
        second_error = Exception(
            "Error code: 400 - {'error': {'message': 'invalid temperature: only 1 is allowed for this model'}}"
        )
        provider.client.chat.completions.create = AsyncMock(
            side_effect=[first_error, second_error, stream_once("ok2")]
        )

        chunks = []
        async for chunk in provider.chat_stream(sample_messages, temperature=0.7):
            chunks.append(chunk)

        assert "".join(chunks) == "ok2"
        calls = provider.client.chat.completions.create.call_args_list
        assert len(calls) == 3
        assert calls[1].kwargs["temperature"] == 1
        assert "temperature" not in calls[2].kwargs


class TestOpenAIProviderToolConversion:
    """Tests for OpenAI tool conversion."""

    @pytest.fixture
    def provider(self):
        """Create provider for testing."""
        with patch("src.llm.openai_provider.AsyncOpenAI"):
            config = LLMConfig(model="gpt-4o", api_key="sk-test")
            return OpenAIProvider(config)

    def test_convert_simple_tools(self, provider, sample_tools):
        """Should convert simple format to OpenAI format."""
        converted = provider._convert_tools(sample_tools)

        assert len(converted) == 2
        assert converted[0]["type"] == "function"
        assert converted[0]["function"]["name"] == "web_search"
        assert converted[0]["function"]["description"] == "Search the web for information"

    def test_convert_already_openai_format(self, provider):
        """Should keep tools already in OpenAI format."""
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "test",
                    "description": "Test tool",
                    "parameters": {},
                },
            }
        ]
        converted = provider._convert_tools(tools)

        assert converted == tools
