"""LLM Router - Model routing and automatic fallback.

The LLMRouter handles:
- Routing requests to appropriate models based on task type
- Automatic fallback when a model fails
- Cost optimization by using cheaper models for simple tasks
"""

import logging
from typing import Any, AsyncIterator

from src.llm.base import LLMConfig, LLMProvider, LLMResponse

logger = logging.getLogger(__name__)


class LLMRouter(LLMProvider):
    """
    Router for multiple LLM providers with automatic fallback.

    The router:
    - Routes requests to appropriate providers based on model name
    - Handles automatic fallback when primary model fails
    - Supports different models for different task types
    - Provides unified interface across all providers

    Example:
        ```python
        router = LLMRouter(
            providers={
                "gpt-4o": openai_provider,
                "claude-3-sonnet": anthropic_provider,
            },
            default_model="gpt-4o",
            fallback_model="gpt-4o-mini",
        )

        response = await router.chat(messages=[...])
        ```
    """

    def __init__(
        self,
        providers: dict[str, LLMProvider] | None = None,
        default_model: str = "gpt-4o",
        fallback_model: str = "gpt-4o-mini",
        task_routing: dict[str, str] | None = None,
    ):
        """
        Initialize the LLM Router.

        Args:
            providers: Dictionary mapping model names to providers
            default_model: Default model to use
            fallback_model: Model to use when primary fails
            task_routing: Optional mapping of task types to models
        """
        # Create a dummy config for base class
        config = LLMConfig(model=default_model)
        super().__init__(config)

        self.providers = providers or {}
        self.default_model = default_model
        self.fallback_model = fallback_model
        self.task_routing = task_routing or {
            "planning": "gpt-4o",
            "execution": "gpt-4o-mini",
            "reflection": "gpt-4o-mini",
            "complex_reasoning": "claude-3-sonnet",
        }

    def register_provider(self, model: str, provider: LLMProvider) -> None:
        """
        Register a provider for a specific model.

        Args:
            model: Model name
            provider: LLM provider instance
        """
        self.providers[model] = provider
        logger.info(f"Registered provider for model: {model}")

    def get_provider(self, model: str | None = None) -> LLMProvider | None:
        """
        Get the provider for a specific model.

        Args:
            model: Model name (uses default if not specified)

        Returns:
            LLM provider or None if not found
        """
        model = model or self.default_model
        return self.providers.get(model)

    def route_for_task(self, task_type: str) -> str:
        """
        Get the recommended model for a task type.

        Args:
            task_type: Type of task (planning, execution, etc.)

        Returns:
            Model name to use
        """
        return self.task_routing.get(task_type, self.default_model)

    async def chat(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        response_format: dict[str, str] | None = None,
        model: str | None = None,
        **kwargs: Any,
    ) -> LLMResponse:
        """
        Send a chat completion request with automatic fallback.

        Args:
            messages: List of message dicts
            tools: Optional tool definitions
            temperature: Temperature override
            max_tokens: Max tokens override
            response_format: Response format
            model: Specific model to use
            **kwargs: Additional arguments

        Returns:
            LLMResponse from the model
        """
        model = model or self.default_model
        provider = self.get_provider(model)

        if not provider:
            # Try fallback
            logger.warning(f"No provider for {model}, trying fallback {self.fallback_model}")
            provider = self.get_provider(self.fallback_model)

        if not provider:
            raise ValueError(f"No provider available for model: {model}")

        try:
            return await provider.chat(
                messages=messages,
                tools=tools,
                temperature=temperature,
                max_tokens=max_tokens,
                response_format=response_format,
                **kwargs,
            )
        except Exception as e:
            logger.error(f"Provider {model} failed: {e}")

            # Try fallback if not already using it
            if model != self.fallback_model:
                fallback_provider = self.get_provider(self.fallback_model)
                if fallback_provider:
                    logger.info(f"Falling back to {self.fallback_model}")
                    return await fallback_provider.chat(
                        messages=messages,
                        tools=tools,
                        temperature=temperature,
                        max_tokens=max_tokens,
                        response_format=response_format,
                        **kwargs,
                    )

            raise

    async def chat_stream(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        model: str | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[str]:
        """
        Send a streaming chat completion request.

        Args:
            messages: List of message dicts
            tools: Optional tool definitions
            temperature: Temperature override
            max_tokens: Max tokens override
            model: Specific model to use
            **kwargs: Additional arguments

        Yields:
            String chunks of the response
        """
        model = model or self.default_model
        provider = self.get_provider(model)

        if not provider:
            provider = self.get_provider(self.fallback_model)

        if not provider:
            raise ValueError(f"No provider available for model: {model}")

        async for chunk in provider.chat_stream(
            messages=messages,
            tools=tools,
            temperature=temperature,
            max_tokens=max_tokens,
            **kwargs,
        ):
            yield chunk

    async def health_check_all(self) -> dict[str, bool]:
        """
        Check health of all registered providers.

        Returns:
            Dictionary mapping model names to health status
        """
        results = {}
        for model, provider in self.providers.items():
            try:
                results[model] = await provider.health_check()
            except Exception:
                results[model] = False
        return results


def create_router_from_config(config: dict[str, Any]) -> LLMRouter:
    """
    Create an LLM router from configuration.

    Args:
        config: Configuration dictionary with provider settings

    Returns:
        Configured LLMRouter instance
    """
    from src.llm.openai_provider import OpenAIProvider
    from src.llm.anthropic_provider import AnthropicProvider

    providers: dict[str, LLMProvider] = {}

    # Create OpenAI providers
    openai_models = config.get("openai", {}).get("models", [])
    openai_api_key = config.get("openai", {}).get("api_key")

    for model in openai_models:
        if openai_api_key:
            provider_config = LLMConfig(model=model, api_key=openai_api_key)
            providers[model] = OpenAIProvider(provider_config)

    # Create Anthropic providers
    anthropic_models = config.get("anthropic", {}).get("models", [])
    anthropic_api_key = config.get("anthropic", {}).get("api_key")

    for model in anthropic_models:
        if anthropic_api_key:
            provider_config = LLMConfig(model=model, api_key=anthropic_api_key)
            providers[model] = AnthropicProvider(provider_config)

    return LLMRouter(
        providers=providers,
        default_model=config.get("default_model", "gpt-4o"),
        fallback_model=config.get("fallback_model", "gpt-4o-mini"),
        task_routing=config.get("task_routing"),
    )
