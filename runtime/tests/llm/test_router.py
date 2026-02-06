"""Tests for LLM Router."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from src.llm.base import LLMConfig, LLMProvider, LLMResponse
from src.llm.router import LLMRouter


class MockProvider(LLMProvider):
    """Mock LLM provider for testing."""

    def __init__(self, config: LLMConfig, response_content: str = "Mock response"):
        super().__init__(config)
        self.response_content = response_content
        self.call_count = 0

    async def chat(self, messages, **kwargs):
        self.call_count += 1
        return LLMResponse(
            content=self.response_content,
            model=self.config.model,
            usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        )

    async def chat_stream(self, messages, **kwargs):
        yield self.response_content


class FailingProvider(LLMProvider):
    """Provider that always fails."""

    async def chat(self, messages, **kwargs):
        raise Exception("Provider failed")

    async def chat_stream(self, messages, **kwargs):
        raise Exception("Provider failed")


class TestLLMRouter:
    """Tests for LLMRouter class."""

    def test_router_creation(self):
        """Test creating an LLM router."""
        router = LLMRouter()

        assert router.providers == {}
        assert router.default_model == "gpt-4o"
        assert router.fallback_model == "gpt-4o-mini"

    def test_router_with_custom_defaults(self):
        """Test router with custom default models."""
        router = LLMRouter(
            default_model="claude-3-sonnet",
            fallback_model="claude-3-haiku",
        )

        assert router.default_model == "claude-3-sonnet"
        assert router.fallback_model == "claude-3-haiku"

    def test_register_provider(self):
        """Test registering a provider."""
        router = LLMRouter()
        config = LLMConfig(model="gpt-4o")
        provider = MockProvider(config)

        router.register_provider("gpt-4o", provider)

        assert "gpt-4o" in router.providers
        assert router.get_provider("gpt-4o") == provider

    def test_get_provider_not_found(self):
        """Test getting a non-existent provider."""
        router = LLMRouter()

        assert router.get_provider("unknown-model") is None

    def test_route_for_task(self):
        """Test task routing."""
        router = LLMRouter()

        assert router.route_for_task("planning") == "gpt-4o"
        assert router.route_for_task("execution") == "gpt-4o-mini"
        assert router.route_for_task("unknown") == "gpt-4o"  # Falls back to default

    @pytest.mark.asyncio
    async def test_chat_with_registered_provider(self, sample_messages):
        """Test chat with a registered provider."""
        config = LLMConfig(model="gpt-4o")
        provider = MockProvider(config, "Hello from GPT-4o")

        router = LLMRouter(providers={"gpt-4o": provider})

        response = await router.chat(messages=sample_messages)

        assert response.content == "Hello from GPT-4o"
        assert provider.call_count == 1

    @pytest.mark.asyncio
    async def test_chat_uses_fallback_when_primary_not_found(self, sample_messages):
        """Test chat falls back when primary provider not found."""
        fallback_config = LLMConfig(model="gpt-4o-mini")
        fallback_provider = MockProvider(fallback_config, "Fallback response")

        router = LLMRouter(
            providers={"gpt-4o-mini": fallback_provider},
            fallback_model="gpt-4o-mini",
        )

        response = await router.chat(messages=sample_messages, model="gpt-4o")

        assert response.content == "Fallback response"

    @pytest.mark.asyncio
    async def test_chat_uses_fallback_on_error(self, sample_messages):
        """Test chat falls back when primary provider fails."""
        primary_config = LLMConfig(model="gpt-4o")
        primary_provider = FailingProvider(primary_config)

        fallback_config = LLMConfig(model="gpt-4o-mini")
        fallback_provider = MockProvider(fallback_config, "Fallback response")

        router = LLMRouter(
            providers={
                "gpt-4o": primary_provider,
                "gpt-4o-mini": fallback_provider,
            },
            fallback_model="gpt-4o-mini",
        )

        response = await router.chat(messages=sample_messages, model="gpt-4o")

        assert response.content == "Fallback response"

    @pytest.mark.asyncio
    async def test_chat_raises_when_no_provider_available(self, sample_messages):
        """Test chat raises error when no provider available."""
        router = LLMRouter()

        with pytest.raises(ValueError, match="No provider available"):
            await router.chat(messages=sample_messages)

    @pytest.mark.asyncio
    async def test_chat_validates_messages(self):
        """Test chat validates messages before calling provider."""
        config = LLMConfig(model="gpt-4o")
        provider = MockProvider(config)
        router = LLMRouter(providers={"gpt-4o": provider})

        with pytest.raises(ValueError, match="messages cannot be empty"):
            await router.chat(messages=[])

    @pytest.mark.asyncio
    async def test_health_check_all(self):
        """Test health check for all providers."""
        config1 = LLMConfig(model="gpt-4o")
        provider1 = MockProvider(config1)

        config2 = LLMConfig(model="claude-3-sonnet")
        provider2 = MockProvider(config2)

        router = LLMRouter(providers={"gpt-4o": provider1, "claude-3-sonnet": provider2})

        results = await router.health_check_all()

        assert "gpt-4o" in results
        assert "claude-3-sonnet" in results


class TestLLMRouterTaskRouting:
    """Tests for task-based model routing."""

    def test_custom_task_routing(self):
        """Test custom task routing configuration."""
        custom_routing = {
            "planning": "claude-3-opus",
            "execution": "gpt-4o-mini",
            "reflection": "claude-3-haiku",
        }

        router = LLMRouter(task_routing=custom_routing)

        assert router.route_for_task("planning") == "claude-3-opus"
        assert router.route_for_task("execution") == "gpt-4o-mini"
        assert router.route_for_task("reflection") == "claude-3-haiku"

    def test_default_task_routing(self):
        """Test default task routing uses constants."""
        from src.constants import DEFAULT_TASK_MODEL_ROUTING

        router = LLMRouter()

        for task_type, expected_model in DEFAULT_TASK_MODEL_ROUTING.items():
            assert router.route_for_task(task_type) == expected_model
