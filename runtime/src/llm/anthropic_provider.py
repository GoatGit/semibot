"""Anthropic LLM Provider implementation."""

import json
from typing import Any, AsyncIterator

from anthropic import AsyncAnthropic
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential

from src.constants import LLM_MAX_RETRIES, LLM_RETRY_DELAY_BASE, LLM_RETRY_DELAY_MAX
from src.llm.base import LLMConfig, LLMProvider, LLMResponse
from src.utils.logging import get_logger

logger = get_logger(__name__)


def _is_retryable_anthropic_error(exc: BaseException) -> bool:
    """Return False for 400-class errors that should not be retried."""
    if exc.__class__.__name__ == "BadRequestError":
        return False
    response = getattr(exc, "response", None)
    if getattr(response, "status_code", None) == 400:
        return False
    lowered = str(exc).lower()
    if "400 bad request" in lowered or "status code 400" in lowered:
        return False
    return True


def _summarize_anthropic_payload(params: dict[str, Any]) -> dict[str, Any]:
    """Return a safe, compact summary of the outbound Anthropic request."""
    messages = params.get("messages") or []
    tools = params.get("tools") or []
    system = str(params.get("system") or "")
    summary_messages: list[dict[str, Any]] = []
    for msg in messages[:8]:
        content = msg.get("content")
        content_type = type(content).__name__
        content_preview = ""
        content_len = 0
        content_blocks: list[dict[str, Any]] = []
        if isinstance(content, str):
            content_preview = content[:200]
            content_len = len(content)
        elif isinstance(content, list):
            content_len = len(content)
            for block in content[:12]:
                if not isinstance(block, dict):
                    continue
                block_type = str(block.get("type") or "")
                block_summary: dict[str, Any] = {"type": block_type}
                if block_type == "tool_use":
                    block_summary["id"] = str(block.get("id") or "")
                    block_summary["name"] = str(block.get("name") or "")
                elif block_type == "tool_result":
                    block_summary["tool_use_id"] = str(block.get("tool_use_id") or "")
                    block_summary["is_error"] = bool(block.get("is_error"))
                    block_content = block.get("content")
                    if isinstance(block_content, str):
                        block_summary["content_preview"] = block_content[:120]
                    elif isinstance(block_content, list) and block_content:
                        first_content = block_content[0]
                        if isinstance(first_content, dict):
                            block_summary["content_preview"] = str(first_content.get("type") or "")[:80]
                elif block_type == "text":
                    block_summary["text_preview"] = str(block.get("text") or "")[:120]
                else:
                    block_summary["preview"] = str(block)[:120]
                content_blocks.append(block_summary)
            if content_blocks:
                content_preview = ",".join(block.get("type", "") for block in content_blocks[:6])[:200]
        summary_messages.append(
            {
                "role": msg.get("role"),
                "content_type": content_type,
                "content_len": content_len,
                "content_preview": content_preview,
                "content_blocks": content_blocks,
            }
        )
    summary_tools: list[dict[str, Any]] = []
    for tool in tools[:12]:
        input_schema = tool.get("input_schema") or {}
        properties = input_schema.get("properties") or {}
        summary_tools.append(
            {
                "name": tool.get("name"),
                "input_schema_type": input_schema.get("type"),
                "property_keys": list(properties.keys())[:20],
                "required": list((input_schema.get("required") or [])[:20]),
            }
        )
    return {
        "model": params.get("model"),
        "max_tokens": params.get("max_tokens"),
        "temperature": params.get("temperature"),
        "base_url": params.get("_debug_base_url"),
        "system_len": len(system),
        "system_preview": system[:300],
        "message_count": len(messages),
        "messages": summary_messages,
        "tool_count": len(tools),
        "tools": summary_tools,
        "tool_choice": params.get("tool_choice"),
    }


def _stringify_block_value(value: Any, max_chars: int = 4000) -> str:
    if isinstance(value, str):
        return value[:max_chars]
    try:
        text = json.dumps(value, ensure_ascii=False)
    except Exception:
        text = str(value)
    return text[:max_chars]


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
        base_url = str(config.base_url or "").strip() or None
        if base_url and base_url.endswith("/v1"):
            # Anthropic SDK already appends /v1/messages and /v1/models.
            # Passing a base_url ending with /v1 produces /v1/v1/... requests.
            base_url = base_url[:-3]
        self.client = AsyncAnthropic(
            api_key=config.api_key,
            base_url=base_url,
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

    @retry(
        stop=stop_after_attempt(LLM_MAX_RETRIES),
        wait=wait_exponential(multiplier=1, min=LLM_RETRY_DELAY_BASE, max=LLM_RETRY_DELAY_MAX),
        retry=retry_if_exception(_is_retryable_anthropic_error),
        reraise=True,
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
        system_messages: list[str] = []
        chat_messages = []

        for msg in messages:
            if msg["role"] == "system":
                system_messages.append(str(msg["content"]))
            else:
                chat_messages.append(self._convert_message(msg))
        system_message = "\n\n".join(item for item in system_messages if item)

        chat_messages = self._merge_consecutive_same_role(chat_messages)
        chat_messages = self._collapse_historical_tool_rounds(chat_messages)

        # Anthropic does not expose OpenAI-style response_format.
        # For json_schema requests without caller-supplied tools, wrap the schema as a
        # forced tool_use call — this is the only API-level guarantee for structured output.
        # For json_object requests (or when tools are already present), fall back to a
        # system-prompt hint so we don't interfere with the caller's tool list.
        forced_schema_tool_name: str | None = None
        if response_format and not tools:
            if response_format.get("type") == "json_schema":
                json_schema = response_format.get("json_schema") or {}
                schema_name = str(json_schema.get("name") or "structured_output").strip()
                schema_body = json_schema.get("schema")
                if schema_body is not None:
                    forced_schema_tool_name = schema_name
                    tools = [
                        {
                            "name": schema_name,
                            "description": "Produce the final structured JSON response.",
                            "input_schema": schema_body,
                        }
                    ]
        if response_format and forced_schema_tool_name is None:
            # Fallback: json_object or json_schema when tools are already present
            schema_hint = ""
            if response_format.get("type") == "json_schema":
                json_schema = response_format.get("json_schema") or {}
                schema_name = str(json_schema.get("name") or "").strip()
                schema_body = json_schema.get("schema")
                if schema_name and schema_body is not None:
                    schema_hint = (
                        f" Follow this JSON schema named '{schema_name}': "
                        f"{json.dumps(schema_body, ensure_ascii=False)}"
                    )
                elif schema_body is not None:
                    schema_hint = f" Follow this JSON schema: {json.dumps(schema_body, ensure_ascii=False)}"
            if system_message:
                system_message += (
                    "\n\nIMPORTANT: Respond only with valid JSON. "
                    "Do not wrap the response in markdown fences. "
                    "Do not add commentary before or after the JSON object."
                    f"{schema_hint}"
                )
            else:
                system_message = (
                    "Respond only with valid JSON. "
                    "Do not wrap the response in markdown fences. "
                    "Do not add commentary before or after the JSON object."
                    f"{schema_hint}"
                )

        # Build request parameters
        params: dict[str, Any] = {
            "model": model or self.config.model,
            "messages": chat_messages,
            "max_tokens": max_tokens or self.config.max_tokens,
        }

        # Temperature handling (Anthropic range is 0-1)
        temp = temperature if temperature is not None else self.config.temperature
        params["temperature"] = min(temp, 1.0)

        if system_message:
            params["system"] = system_message

        if tools:
            params["tools"] = self._convert_tools(tools)
            if forced_schema_tool_name:
                params["tool_choice"] = {"type": "tool", "name": forced_schema_tool_name}

        params["_debug_base_url"] = str(self.config.base_url or "")

        logger.debug(f"Anthropic chat request: model={self.config.model}")

        try:
            request_params = {k: v for k, v in params.items() if not k.startswith("_debug_")}
            response = await self.client.messages.create(**request_params)

            # Extract content
            content = ""
            tool_calls = []

            for block in response.content:
                if block.type == "text":
                    content += block.text
                elif block.type == "tool_use":
                    if forced_schema_tool_name and block.name == forced_schema_tool_name:
                        # Forced schema tool: surface the input as JSON content
                        # so callers see a normal text response they can parse.
                        content = json.dumps(block.input, ensure_ascii=False)
                    else:
                        tool_calls.append({
                            "id": block.id,
                            "type": "function",
                            "function": {
                                "name": block.name,
                                "arguments": json.dumps(block.input),
                            },
                        })

            _raw_usage = response.usage

            def _usage_int(value: Any) -> int:
                return int(value) if isinstance(value, (int, float)) else 0

            _uncached_input = _usage_int(getattr(_raw_usage, "input_tokens", 0))
            _cache_creation = _usage_int(getattr(_raw_usage, "cache_creation_input_tokens", 0))
            _cache_read = _usage_int(getattr(_raw_usage, "cache_read_input_tokens", 0))
            _output_tokens = _usage_int(getattr(_raw_usage, "output_tokens", 0))
            _total_input = _uncached_input + _cache_creation + _cache_read

            return LLMResponse(
                content=content,
                model=response.model,
                usage={
                    "prompt_tokens": _total_input,
                    "completion_tokens": _output_tokens,
                    "total_tokens": _total_input + _output_tokens,
                    "cache_creation_input_tokens": _cache_creation,
                    "cache_read_input_tokens": _cache_read,
                    "uncached_input_tokens": _uncached_input,
                },
                tool_calls=tool_calls,
                finish_reason=response.stop_reason or "end_turn",
                raw_response=response,
            )

        except Exception as e:
            payload_summary = _summarize_anthropic_payload(params)
            try:
                setattr(e, "payload_summary", payload_summary)
            except Exception:
                pass
            logger.error(
                "Anthropic chat failed: %s | payload_summary=%s",
                e,
                json.dumps(payload_summary, ensure_ascii=False),
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
        system_messages: list[str] = []
        chat_messages = []

        for msg in messages:
            if msg["role"] == "system":
                system_messages.append(str(msg["content"]))
            else:
                chat_messages.append(self._convert_message(msg))
        system_message = "\n\n".join(item for item in system_messages if item)

        params: dict[str, Any] = {
            "model": model or self.config.model,
            "messages": chat_messages,
            "max_tokens": max_tokens or self.config.max_tokens,
        }

        temp = temperature if temperature is not None else self.config.temperature
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
        content = message.get("content") or ""

        # Map OpenAI roles to Anthropic roles
        if role == "assistant":
            tool_calls = message.get("tool_calls") or []
            if not tool_calls:
                return {"role": "assistant", "content": content}
            blocks: list[dict[str, Any]] = []
            if isinstance(content, str) and content:
                blocks.append({"type": "text", "text": content})
            for call in tool_calls:
                function = call.get("function") or {}
                arguments = function.get("arguments")
                parsed_input: Any
                if isinstance(arguments, str):
                    try:
                        parsed_input = json.loads(arguments)
                    except json.JSONDecodeError:
                        parsed_input = {"raw_arguments": arguments}
                else:
                    parsed_input = arguments or {}
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": str(call.get("id") or ""),
                        "name": str(function.get("name") or ""),
                        "input": parsed_input if isinstance(parsed_input, dict) else {"value": parsed_input},
                    }
                )
            return {"role": "assistant", "content": blocks}
        elif role == "user":
            return {"role": "user", "content": content}
        elif role == "tool":
            if self._is_skill_context_tool_message(message):
                tool_name = str(message.get("name") or "tools/skill_context")
                payload = str(content)
                return {
                    "role": "user",
                    "content": f"[TOOL_CONTEXT {tool_name}]\n{payload}",
                }
            # Tool result format
            return {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": message.get("tool_call_id", ""),
                        "content": content,
                    }
                ],
            }
        else:
            # Default to user
            return {"role": "user", "content": content}

    @staticmethod
    def _merge_consecutive_same_role(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Merge consecutive messages with the same role.

        Anthropic requires strictly alternating user/assistant turns.
        After converting tool messages to user role, consecutive user messages
        can appear (tool results followed by the next user prompt).
        """
        merged: list[dict[str, Any]] = []
        for msg in messages:
            if merged and merged[-1]["role"] == msg["role"]:
                prev = merged[-1]
                prev_content = prev["content"]
                curr_content = msg["content"]
                # Normalize both sides to lists of content blocks
                if isinstance(prev_content, str):
                    prev_content = [{"type": "text", "text": prev_content}] if prev_content else []
                elif not isinstance(prev_content, list):
                    prev_content = []
                if isinstance(curr_content, str):
                    curr_content = [{"type": "text", "text": curr_content}] if curr_content else []
                elif not isinstance(curr_content, list):
                    curr_content = []
                merged[-1] = {**prev, "content": prev_content + curr_content}
            else:
                merged.append(dict(msg))
        return merged

    @staticmethod
    def _message_has_block_type(message: dict[str, Any], block_type: str) -> bool:
        content = message.get("content")
        if not isinstance(content, list):
            return False
        return any(isinstance(block, dict) and block.get("type") == block_type for block in content)

    @classmethod
    def _collapse_message_tool_blocks_to_text(cls, message: dict[str, Any]) -> dict[str, Any]:
        content = message.get("content")
        if not isinstance(content, list):
            return dict(message)
        role = str(message.get("role") or "user")
        parts: list[str] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            block_type = str(block.get("type") or "")
            if block_type == "text":
                text = str(block.get("text") or "").strip()
                if text:
                    parts.append(text)
            elif block_type == "tool_use":
                name = str(block.get("name") or "").strip() or "tool"
                tool_id = str(block.get("id") or "").strip()
                payload = _stringify_block_value(block.get("input"), max_chars=1200)
                parts.append(
                    f"[previous tool_use name={name} id={tool_id}] {payload}"
                )
            elif block_type == "tool_result":
                tool_use_id = str(block.get("tool_use_id") or "").strip()
                payload = _stringify_block_value(block.get("content"), max_chars=4000)
                parts.append(
                    f"[previous tool_result tool_use_id={tool_use_id}] {payload}"
                )
            else:
                payload = _stringify_block_value(block, max_chars=1200)
                parts.append(f"[previous {block_type}] {payload}")
        collapsed = "\n\n".join(part for part in parts if part).strip()
        return {"role": role, "content": collapsed}

    @classmethod
    def _collapse_historical_tool_rounds(cls, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Anthropic-compatible gateways may reject multiple prior tool-use rounds.

        Keep only the latest structured tool_use/tool_result round. Convert older
        tool blocks into plain text so the information stays available without
        sending multiple structured tool rounds.

        Edge case: if the latest assistant(tool_use) has no following user(tool_result)
        (e.g. truncated transcript), collapse it too — an unpaired tool_use also
        causes a 400 from Anthropic.
        """
        assistant_tool_indices = [
            idx for idx, msg in enumerate(messages)
            if str(msg.get("role") or "") == "assistant" and cls._message_has_block_type(msg, "tool_use")
        ]
        if len(assistant_tool_indices) <= 1:
            # Single tool round: only collapse if it has no paired tool_result
            if not assistant_tool_indices:
                return messages
            keep_assistant_idx = assistant_tool_indices[0]
            keep_user_idx = None
            if keep_assistant_idx + 1 < len(messages):
                next_msg = messages[keep_assistant_idx + 1]
                if str(next_msg.get("role") or "") == "user" and cls._message_has_block_type(next_msg, "tool_result"):
                    keep_user_idx = keep_assistant_idx + 1
            if keep_user_idx is not None:
                # Properly paired — nothing to collapse
                return messages
            # Unpaired: collapse the lone tool_use to text
            rewritten: list[dict[str, Any]] = []
            for idx, msg in enumerate(messages):
                if idx == keep_assistant_idx:
                    rewritten.append(cls._collapse_message_tool_blocks_to_text(msg))
                else:
                    rewritten.append(msg)
            return cls._merge_consecutive_same_role(rewritten)

        keep_assistant_idx = assistant_tool_indices[-1]
        keep_user_idx = None
        if keep_assistant_idx + 1 < len(messages):
            next_msg = messages[keep_assistant_idx + 1]
            if str(next_msg.get("role") or "") == "user" and cls._message_has_block_type(next_msg, "tool_result"):
                keep_user_idx = keep_assistant_idx + 1

        # If the latest tool_use has no paired tool_result, don't keep it structured either
        keep_set = {keep_assistant_idx, keep_user_idx} if keep_user_idx is not None else set()

        rewritten = []
        for idx, msg in enumerate(messages):
            has_tool_use = cls._message_has_block_type(msg, "tool_use")
            has_tool_result = cls._message_has_block_type(msg, "tool_result")
            if (has_tool_use or has_tool_result) and idx not in keep_set:
                rewritten.append(cls._collapse_message_tool_blocks_to_text(msg))
            else:
                rewritten.append(msg)
        return cls._merge_consecutive_same_role(rewritten)

    @staticmethod
    def _normalize_input_schema(schema: Any) -> dict[str, Any]:
        if not isinstance(schema, dict) or not schema:
            return {"type": "object", "properties": {}}
        if schema.get("type") != "object":
            return {**schema, "type": "object"}
        return schema

    def _convert_tools(self, tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Convert tool definitions to Anthropic format."""
        converted = []
        for tool in tools:
            if "input_schema" in tool:
                converted.append({
                    **tool,
                    "input_schema": self._normalize_input_schema(tool["input_schema"]),
                })
            elif "function" in tool:
                func = tool["function"]
                converted.append({
                    "name": func.get("name", ""),
                    "description": func.get("description", ""),
                    "input_schema": self._normalize_input_schema(func.get("parameters")),
                })
            else:
                converted.append({
                    "name": tool.get("name", ""),
                    "description": tool.get("description", ""),
                    "input_schema": self._normalize_input_schema(tool.get("parameters")),
                })
        return converted
