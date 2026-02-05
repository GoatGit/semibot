"""OpenAI LLM Provider implementation."""

import logging
from typing import Any, AsyncIterator

from openai import AsyncOpenAI
from tenacity import retry, stop_after_attempt, wait_exponential

from src.llm.base import LLMConfig, LLMProvider, LLMResponse

logger = logging.getLogger(__name__)


class OpenAIProvider(LLMProvider):
    """
    LLM Provider implementation for OpenAI models.

    Supports:
    - GPT-4o, GPT-4o-mini
    - o1-preview, o1-mini
    - Structured outputs (JSON mode)
    - Function calling
    - Streaming

    Example:
        ```python
        config = LLMConfig(model="gpt-4o", api_key="sk-...")
        provider = OpenAIProvider(config)

        response = await provider.chat(messages=[
            {"role": "user", "content": "Hello!"}
        ])
        ```
    """

    def __init__(self, config: LLMConfig):
        """
        Initialize the OpenAI provider.

        Args:
            config: Provider configuration
        """
        super().__init__(config)
        self.client = AsyncOpenAI(
            api_key=config.api_key,
            base_url=config.base_url,
            timeout=config.timeout,
            max_retries=config.max_retries,
        )

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=10),
    )
    async def chat(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        response_format: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> LLMResponse:
        """
        Send a chat completion request to OpenAI.

        Args:
            messages: List of message dicts
            tools: Optional tool definitions
            temperature: Temperature (0-2)
            max_tokens: Maximum tokens in response
            response_format: Response format (e.g., {"type": "json_object"})
            **kwargs: Additional OpenAI-specific arguments

        Returns:
            LLMResponse with the model's response
        """
        # Build request parameters
        params: dict[str, Any] = {
            "model": self.config.model,
            "messages": messages,
            "temperature": temperature or self.config.temperature,
            "max_tokens": max_tokens or self.config.max_tokens,
        }

        # Add optional parameters
        if tools:
            params["tools"] = self._convert_tools(tools)

        if response_format:
            params["response_format"] = response_format

        # Add any additional kwargs
        params.update(kwargs)

        logger.debug(f"OpenAI chat request: model={self.config.model}")

        try:
            response = await self.client.chat.completions.create(**params)

            # Extract the message
            choice = response.choices[0]
            message = choice.message

            # Parse tool calls if present
            tool_calls = []
            if message.tool_calls:
                for tc in message.tool_calls:
                    tool_calls.append({
                        "id": tc.id,
                        "type": tc.type,
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        },
                    })

            return LLMResponse(
                content=message.content or "",
                model=response.model,
                usage={
                    "prompt_tokens": response.usage.prompt_tokens if response.usage else 0,
                    "completion_tokens": response.usage.completion_tokens if response.usage else 0,
                    "total_tokens": response.usage.total_tokens if response.usage else 0,
                },
                tool_calls=tool_calls,
                finish_reason=choice.finish_reason or "stop",
                raw_response=response,
            )

        except Exception as e:
            logger.error(f"OpenAI chat failed: {e}")
            raise

    async def chat_stream(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[str]:
        """
        Send a streaming chat completion request.

        Args:
            messages: List of message dicts
            tools: Optional tool definitions
            temperature: Temperature (0-2)
            max_tokens: Maximum tokens
            **kwargs: Additional arguments

        Yields:
            String chunks of the response
        """
        params: dict[str, Any] = {
            "model": self.config.model,
            "messages": messages,
            "temperature": temperature or self.config.temperature,
            "max_tokens": max_tokens or self.config.max_tokens,
            "stream": True,
        }

        if tools:
            params["tools"] = self._convert_tools(tools)

        params.update(kwargs)

        try:
            stream = await self.client.chat.completions.create(**params)

            async for chunk in stream:
                if chunk.choices and chunk.choices[0].delta.content:
                    yield chunk.choices[0].delta.content

        except Exception as e:
            logger.error(f"OpenAI stream failed: {e}")
            raise

    def _convert_tools(self, tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Convert tool definitions to OpenAI format."""
        converted = []
        for tool in tools:
            if "function" in tool:
                # Already in OpenAI format
                converted.append(tool)
            else:
                # Convert from simple format
                converted.append({
                    "type": "function",
                    "function": {
                        "name": tool.get("name", ""),
                        "description": tool.get("description", ""),
                        "parameters": tool.get("parameters", {}),
                    },
                })
        return converted
