"""Kimi LLM Provider implementation."""

from typing import Any

from src.llm.base import LLMConfig, LLMResponse
from src.llm.openai_provider import OpenAIProvider


class KimiProvider(OpenAIProvider):
    """Moonshot/Kimi provider with native reasoning-content preservation."""

    def __init__(self, config: LLMConfig):
        super().__init__(config)

    @staticmethod
    def _extract_reasoning_content(message: Any) -> str | None:
        direct = getattr(message, "reasoning_content", None)
        if isinstance(direct, str) and direct.strip():
            return direct
        model_extra = getattr(message, "model_extra", None)
        if isinstance(model_extra, dict):
            extra = model_extra.get("reasoning_content")
            if isinstance(extra, str) and extra.strip():
                return extra
        if isinstance(message, dict):
            extra = message.get("reasoning_content")
            if isinstance(extra, str) and extra.strip():
                return extra
        return None

    @classmethod
    def _to_llm_response(cls, response: Any) -> LLMResponse:
        choice = response.choices[0]
        message = choice.message

        tool_calls = []
        if message.tool_calls:
            for tc in message.tool_calls:
                tool_calls.append(
                    {
                        "id": tc.id,
                        "type": tc.type,
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        },
                    }
                )

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
            reasoning_content=cls._extract_reasoning_content(message),
            raw_response=response,
        )

    def _normalize_messages_for_api(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        normalized = []
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
            if (
                isinstance(content, str)
                and not content.strip()
                and not has_tool_calls
                and not has_function_call
            ):
                continue
            role = str(message.get("role") or "").strip().lower()
            cleaned: dict[str, Any] = {"role": role}
            if role in {"system", "user"}:
                cleaned["content"] = content if isinstance(content, str) else ""
            elif role == "assistant":
                if isinstance(content, str):
                    cleaned["content"] = content
                if has_tool_calls:
                    cleaned["tool_calls"] = message.get("tool_calls")
                if has_function_call:
                    cleaned["function_call"] = message.get("function_call")
                reasoning_content = message.get("reasoning_content")
                if isinstance(reasoning_content, str) and reasoning_content.strip():
                    cleaned["reasoning_content"] = reasoning_content
            elif role == "tool":
                cleaned["content"] = content if isinstance(content, str) else ""
                tool_call_id = str(message.get("tool_call_id") or "").strip()
                if tool_call_id:
                    cleaned["tool_call_id"] = tool_call_id
            else:
                cleaned["content"] = content if isinstance(content, str) else ""
            normalized.append(cleaned)
        return normalized
