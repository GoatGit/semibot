"""Anthropic LLM Provider implementation."""

import json
from typing import Any, AsyncIterator

from anthropic import AsyncAnthropic
from tenacity import retry, stop_after_attempt, wait_exponential

from src.constants import LLM_MAX_RETRIES, LLM_RETRY_DELAY_BASE, LLM_RETRY_DELAY_MAX
from src.llm.base import LLMConfig, LLMProvider, LLMResponse
from src.utils.logging import get_logger

logger = get_logger(__name__)


class AnthropicProvider(LLMProvider):
    """
    LLM Provider implementation for Anthropic models.

    Supports:
    - Claude 3.5 Sonnet
    - Claude 3 Opus, Sonnet, Haiku
    - Tool use
    - Streaming

    Example:
        ```python
        config = LLMConfig(model="claude-3-5-sonnet-20241022", api_key="sk-ant-...")
        provider = AnthropicProvider(config)

        response = await provider.chat(messages=[
            {"role": "user", "content": "Hello!"}
        ])
        ```
    """

    def __init__(self, config: LLMConfig):
        """
        Initialize the Anthropic provider.

        Args:
            config: Provider configuration
        """
        super().__init__(config)
        self.client = AsyncAnthropic(
            api_key=config.api_key,
            timeout=config.timeout,
            max_retries=config.max_retries,
        )

    @retry(
        stop=stop_after_attempt(LLM_MAX_RETRIES),
        wait=wait_exponential(multiplier=1, min=LLM_RETRY_DELAY_BASE, max=LLM_RETRY_DELAY_MAX),
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
        Send a chat completion request to Anthropic.

        Args:
            messages: List of message dicts
            tools: Optional tool definitions
            temperature: Temperature (0-1)
            max_tokens: Maximum tokens in response
            response_format: Response format (handled via system prompt)
            **kwargs: Additional Anthropic-specific arguments

        Returns:
            LLMResponse with the model's response

        Raises:
            ValueError: If messages is empty or invalid
        """
        # Validate messages
        self._validate_messages(messages)

        # Extract system message
        system_message = ""
        chat_messages = []

        for msg in messages:
            if msg["role"] == "system":
                system_message = msg["content"]
            else:
                chat_messages.append(self._convert_message(msg))

        # Handle JSON response format
        if response_format and response_format.get("type") == "json_object":
            if system_message:
                system_message += "\n\nIMPORTANT: Respond only with valid JSON."
            else:
                system_message = "Respond only with valid JSON."

        # Build request parameters
        params: dict[str, Any] = {
            "model": self.config.model,
            "messages": chat_messages,
            "max_tokens": max_tokens or self.config.max_tokens,
        }

        # Temperature handling (Anthropic range is 0-1)
        temp = temperature or self.config.temperature
        params["temperature"] = min(temp, 1.0)

        if system_message:
            params["system"] = system_message

        if tools:
            params["tools"] = self._convert_tools(tools)

        logger.debug(f"Anthropic chat request: model={self.config.model}")

        try:
            response = await self.client.messages.create(**params)

            # Extract content
            content = ""
            tool_calls = []

            for block in response.content:
                if block.type == "text":
                    content += block.text
                elif block.type == "tool_use":
                    tool_calls.append({
                        "id": block.id,
                        "type": "function",
                        "function": {
                            "name": block.name,
                            "arguments": json.dumps(block.input),
                        },
                    })

            return LLMResponse(
                content=content,
                model=response.model,
                usage={
                    "prompt_tokens": response.usage.input_tokens,
                    "completion_tokens": response.usage.output_tokens,
                    "total_tokens": response.usage.input_tokens + response.usage.output_tokens,
                },
                tool_calls=tool_calls,
                finish_reason=response.stop_reason or "end_turn",
                raw_response=response,
            )

        except Exception as e:
            logger.error(f"Anthropic chat failed: {e}")
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
            temperature: Temperature (0-1)
            max_tokens: Maximum tokens
            **kwargs: Additional arguments

        Yields:
            String chunks of the response

        Raises:
            ValueError: If messages is empty or invalid
        """
        # Validate messages
        self._validate_messages(messages)

        # Extract system message
        system_message = ""
        chat_messages = []

        for msg in messages:
            if msg["role"] == "system":
                system_message = msg["content"]
            else:
                chat_messages.append(self._convert_message(msg))

        params: dict[str, Any] = {
            "model": self.config.model,
            "messages": chat_messages,
            "max_tokens": max_tokens or self.config.max_tokens,
        }

        temp = temperature or self.config.temperature
        params["temperature"] = min(temp, 1.0)

        if system_message:
            params["system"] = system_message

        if tools:
            params["tools"] = self._convert_tools(tools)

        try:
            async with self.client.messages.stream(**params) as stream:
                async for text in stream.text_stream:
                    yield text

        except Exception as e:
            logger.error(f"Anthropic stream failed: {e}")
            raise

    def _convert_message(self, message: dict[str, str]) -> dict[str, Any]:
        """Convert message to Anthropic format."""
        role = message["role"]

        # Map OpenAI roles to Anthropic roles
        if role == "assistant":
            return {"role": "assistant", "content": message["content"]}
        elif role == "user":
            return {"role": "user", "content": message["content"]}
        elif role == "tool":
            # Tool result format
            return {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": message.get("tool_call_id", ""),
                        "content": message["content"],
                    }
                ],
            }
        else:
            # Default to user
            return {"role": "user", "content": message["content"]}

    def _convert_tools(self, tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Convert tool definitions to Anthropic format."""
        converted = []
        for tool in tools:
            if "input_schema" in tool:
                # Already in Anthropic format
                converted.append(tool)
            elif "function" in tool:
                # Convert from OpenAI format
                func = tool["function"]
                converted.append({
                    "name": func.get("name", ""),
                    "description": func.get("description", ""),
                    "input_schema": func.get("parameters", {}),
                })
            else:
                # Convert from simple format
                converted.append({
                    "name": tool.get("name", ""),
                    "description": tool.get("description", ""),
                    "input_schema": tool.get("parameters", {}),
                })
        return converted
