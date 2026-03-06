"""OpenAI LLM Provider implementation."""

from typing import Any, AsyncIterator

from openai import AsyncOpenAI
from tenacity import retry, stop_after_attempt, wait_exponential

from src.constants import LLM_MAX_RETRIES, LLM_RETRY_DELAY_BASE, LLM_RETRY_DELAY_MAX
from src.llm.base import LLMConfig, LLMProvider, LLMResponse
from src.utils.logging import get_logger

logger = get_logger(__name__)


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

    @staticmethod
    def _is_skill_context_tool_message(message: dict[str, Any]) -> bool:
        role = str(message.get("role") or "").strip().lower()
        if role != "tool":
            return False
        tool_call_id = str(message.get("tool_call_id") or "").strip().lower()
        if tool_call_id.startswith("skill_ctx_"):
            return True
        name = str(message.get("name") or "").strip().lower()
        return name.startswith("tools/skill_context/")

    def _normalize_messages_for_api(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        normalized: list[dict[str, Any]] = []
        for message in messages:
            if self._is_skill_context_tool_message(message):
                tool_name = str(message.get("name") or "tools/skill_context")
                payload = str(message.get("content") or "")
                normalized.append(
                    {
                        "role": "user",
                        "content": f"[TOOL_CONTEXT {tool_name}]\n{payload}",
                    }
                )
                continue
            content = message.get("content")
            has_tool_calls = bool(message.get("tool_calls"))
            has_function_call = bool(message.get("function_call"))
            if isinstance(content, str) and not content.strip() and not has_tool_calls and not has_function_call:
                # Some OpenAI-compatible providers reject empty-content messages with 400.
                continue
            normalized.append(message)
        return normalized

    @staticmethod
    def _extract_temperature(
        temperature: float | None,
        default_temperature: float | None,
    ) -> float | None:
        if temperature is not None:
            return temperature
        return default_temperature

    @staticmethod
    def _to_llm_response(response: Any) -> LLMResponse:
        choice = response.choices[0]
        message = choice.message

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
        model: str | None = None,
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

        Raises:
            ValueError: If messages is empty or invalid
        """
        # Validate messages
        self._validate_messages(messages)
        normalized_messages = self._normalize_messages_for_api(messages)

        # Build request parameters
        effective_model = model or self.config.model
        effective_temperature = self._extract_temperature(temperature, self.config.temperature)
        params: dict[str, Any] = {
            "model": effective_model,
            "messages": normalized_messages,
            "max_tokens": max_tokens or self.config.max_tokens,
        }
        if effective_temperature is not None:
            params["temperature"] = effective_temperature

        # Add optional parameters
        if tools:
            params["tools"] = self._convert_tools(tools)

        if response_format:
            params["response_format"] = response_format

        # Add any additional kwargs
        params.update(kwargs)

        logger.debug(f"OpenAI chat request: model={effective_model}")

        try:
            response = await self.client.chat.completions.create(**params)
            return self._to_llm_response(response)

        except Exception as e:
            lowered_error = str(e).lower()
            if "invalid temperature" in lowered_error and "only 1 is allowed" in lowered_error:
                logger.warning(
                    "OpenAI chat temperature constrained by model; retrying with safe temperatures",
                    extra={"model": effective_model, "error": str(e)},
                )
                # Retry 1: temperature=1 (providers that require fixed temperature)
                # Retry 2: omit temperature (providers that reject explicit temperature)
                for attempt in ("one", "omit"):
                    retry_params = dict(params)
                    if attempt == "one":
                        retry_params["temperature"] = 1
                    else:
                        retry_params.pop("temperature", None)
                    try:
                        retry_response = await self.client.chat.completions.create(**retry_params)
                        return self._to_llm_response(retry_response)
                    except Exception as retry_error:
                        lowered_retry_error = str(retry_error).lower()
                        if "invalid temperature" in lowered_retry_error and "only 1 is allowed" in lowered_retry_error:
                            continue
                        raise

            if e.__class__.__name__ == "BadRequestError":
                relaxed_params = dict(params)
                dropped_keys = []
                for key in ("temperature", "max_tokens", "response_format"):
                    if key in relaxed_params:
                        relaxed_params.pop(key, None)
                        dropped_keys.append(key)
                if dropped_keys:
                    logger.warning(
                        "OpenAI chat retrying without optional params after BadRequest",
                        extra={
                            "model": effective_model,
                            "dropped_keys": dropped_keys,
                            "error": str(e),
                        },
                    )
                    retry_response = await self.client.chat.completions.create(**relaxed_params)
                    return self._to_llm_response(retry_response)
            logger.error(f"OpenAI chat failed: {e}")
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
            temperature: Temperature (0-2)
            max_tokens: Maximum tokens
            **kwargs: Additional arguments

        Yields:
            String chunks of the response

        Raises:
            ValueError: If messages is empty or invalid
        """
        # Validate messages
        self._validate_messages(messages)
        normalized_messages = self._normalize_messages_for_api(messages)

        params: dict[str, Any] = {
            "model": model or self.config.model,
            "messages": normalized_messages,
            "max_tokens": max_tokens or self.config.max_tokens,
            "stream": True,
        }
        effective_temperature = self._extract_temperature(temperature, self.config.temperature)
        if effective_temperature is not None:
            params["temperature"] = effective_temperature

        if tools:
            params["tools"] = self._convert_tools(tools)

        params.update(kwargs)

        try:
            stream = await self.client.chat.completions.create(**params)

            async for chunk in stream:
                if chunk.choices and chunk.choices[0].delta.content:
                    yield chunk.choices[0].delta.content

        except Exception as e:
            lowered_error = str(e).lower()
            if "invalid temperature" in lowered_error and "only 1 is allowed" in lowered_error:
                logger.warning(
                    "OpenAI stream temperature constrained by model; retrying with safe temperatures",
                    extra={"model": params.get("model"), "error": str(e)},
                )
                for attempt in ("one", "omit"):
                    retry_params = dict(params)
                    if attempt == "one":
                        retry_params["temperature"] = 1
                    else:
                        retry_params.pop("temperature", None)
                    try:
                        stream = await self.client.chat.completions.create(**retry_params)
                        async for chunk in stream:
                            if chunk.choices and chunk.choices[0].delta.content:
                                yield chunk.choices[0].delta.content
                        return
                    except Exception as retry_error:
                        lowered_retry_error = str(retry_error).lower()
                        if "invalid temperature" in lowered_retry_error and "only 1 is allowed" in lowered_retry_error:
                            continue
                        raise
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
