"""Tests for LLM base classes."""

import pytest

from src.llm.base import LLMConfig, LLMProvider, LLMResponse


class TestLLMResponse:
    """Tests for LLMResponse dataclass."""

    def test_create_response(self):
        """Test creating an LLM response."""
        response = LLMResponse(
            content="Hello!",
            model="gpt-4o",
            usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        )

        assert response.content == "Hello!"
        assert response.model == "gpt-4o"
        assert response.tokens_input == 10
        assert response.tokens_output == 5
        assert response.tokens_total == 15

    def test_response_default_values(self):
        """Test default values for LLM response."""
        response = LLMResponse(content="Test", model="gpt-4o")

        assert response.usage == {}
        assert response.tool_calls == []
        assert response.finish_reason == "stop"
        assert response.raw_response is None

    def test_tokens_with_empty_usage(self):
        """Test token counts with empty usage dict."""
        response = LLMResponse(content="Test", model="gpt-4o", usage={})

        assert response.tokens_input == 0
        assert response.tokens_output == 0
        assert response.tokens_total == 0

    def test_response_with_tool_calls(self):
        """Test response with tool calls."""
        tool_calls = [
            {
                "id": "call_123",
                "type": "function",
                "function": {"name": "search", "arguments": '{"query": "test"}'},
            }
        ]
        response = LLMResponse(
            content="",
            model="gpt-4o",
            tool_calls=tool_calls,
            finish_reason="tool_calls",
        )

        assert len(response.tool_calls) == 1
        assert response.tool_calls[0]["function"]["name"] == "search"
        assert response.finish_reason == "tool_calls"


class TestLLMConfig:
    """Tests for LLMConfig dataclass."""

    def test_create_config(self):
        """Test creating an LLM config."""
        config = LLMConfig(
            model="gpt-4o",
            api_key="sk-test",
            temperature=0.5,
        )

        assert config.model == "gpt-4o"
        assert config.api_key == "sk-test"
        assert config.temperature == 0.5

    def test_config_default_values(self):
        """Test default values for LLM config."""
        config = LLMConfig(model="gpt-4o")

        assert config.api_key is None
        assert config.base_url is None
        assert config.temperature == 0.7
        assert config.max_tokens == 4096
        assert config.timeout == 60
        assert config.max_retries == 3


class TestLLMProviderValidation:
    """Tests for LLM provider message validation."""

    def test_validate_empty_messages(self, sample_llm_config):
        """Test validation rejects empty messages list."""

        class TestProvider(LLMProvider):
            async def chat(self, messages, **kwargs):
                self._validate_messages(messages)
                return LLMResponse(content="", model=self.model)

            async def chat_stream(self, messages, **kwargs):
                pass

        provider = TestProvider(sample_llm_config)

        with pytest.raises(ValueError, match="messages cannot be empty"):
            provider._validate_messages([])

    def test_validate_missing_role(self, sample_llm_config):
        """Test validation rejects messages without role."""

        class TestProvider(LLMProvider):
            async def chat(self, messages, **kwargs):
                self._validate_messages(messages)
                return LLMResponse(content="", model=self.model)

            async def chat_stream(self, messages, **kwargs):
                pass

        provider = TestProvider(sample_llm_config)

        with pytest.raises(ValueError, match="missing 'role' field"):
            provider._validate_messages([{"content": "Hello"}])

    def test_validate_missing_content(self, sample_llm_config):
        """Test validation rejects messages without content."""

        class TestProvider(LLMProvider):
            async def chat(self, messages, **kwargs):
                self._validate_messages(messages)
                return LLMResponse(content="", model=self.model)

            async def chat_stream(self, messages, **kwargs):
                pass

        provider = TestProvider(sample_llm_config)

        with pytest.raises(ValueError, match="missing 'content' field"):
            provider._validate_messages([{"role": "user"}])

    def test_validate_non_dict_message(self, sample_llm_config):
        """Test validation rejects non-dict messages."""

        class TestProvider(LLMProvider):
            async def chat(self, messages, **kwargs):
                self._validate_messages(messages)
                return LLMResponse(content="", model=self.model)

            async def chat_stream(self, messages, **kwargs):
                pass

        provider = TestProvider(sample_llm_config)

        with pytest.raises(ValueError, match="must be a dict"):
            provider._validate_messages(["not a dict"])

    def test_validate_valid_messages(self, sample_llm_config, sample_messages):
        """Test validation passes for valid messages."""

        class TestProvider(LLMProvider):
            async def chat(self, messages, **kwargs):
                self._validate_messages(messages)
                return LLMResponse(content="", model=self.model)

            async def chat_stream(self, messages, **kwargs):
                pass

        provider = TestProvider(sample_llm_config)

        # Should not raise
        provider._validate_messages(sample_messages)

    def test_validate_message_with_tool_calls(self, sample_llm_config):
        """Test validation passes for messages with tool_calls instead of content."""

        class TestProvider(LLMProvider):
            async def chat(self, messages, **kwargs):
                self._validate_messages(messages)
                return LLMResponse(content="", model=self.model)

            async def chat_stream(self, messages, **kwargs):
                pass

        provider = TestProvider(sample_llm_config)

        # Message with tool_calls should be valid
        messages = [{"role": "assistant", "tool_calls": []}]
        provider._validate_messages(messages)


class TestGeneratePlanParsing:
    """Tests for robust generate_plan parsing behavior."""

    @pytest.mark.asyncio
    async def test_generate_plan_handles_non_object_json(self, sample_llm_config):
        """Should not crash when model returns valid JSON but not an object."""

        class TestProvider(LLMProvider):
            async def chat(self, messages, **kwargs):
                return LLMResponse(content="703", model=self.model)

            async def chat_stream(self, messages, **kwargs):
                if False:
                    yield ""

        provider = TestProvider(sample_llm_config)
        result = await provider.generate_plan(messages=[{"role": "user", "content": "37*19"}])

        assert isinstance(result, dict)
        assert result["steps"] == []
        assert "Plan must be a JSON object" in result["error"]

    @pytest.mark.asyncio
    async def test_generate_plan_parses_object_inside_fence(self, sample_llm_config):
        """Should parse fenced JSON object and keep thinking text."""

        class TestProvider(LLMProvider):
            async def chat(self, messages, **kwargs):
                return LLMResponse(
                    content='思考中...\n```json\n{"goal":"计算","steps":[],"requires_delegation":false,"delegate_to":null}\n```',
                    model=self.model,
                )

            async def chat_stream(self, messages, **kwargs):
                if False:
                    yield ""

        provider = TestProvider(sample_llm_config)
        result = await provider.generate_plan(messages=[{"role": "user", "content": "2+2"}])

        assert result["goal"] == "计算"
        assert result["steps"] == []
        assert "思考中" in result["_thinking"]
