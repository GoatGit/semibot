"""Tests for Kimi LLM Provider."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.llm.base import LLMConfig
from src.llm.kimi_provider import KimiProvider


class TestKimiProviderChat:
    @pytest.fixture
    def provider(self, mock_openai_client):
        with patch("src.llm.openai_provider.AsyncOpenAI"):
            config = LLMConfig(
                model="kimi-k2.5",
                api_key="sk-test",
                base_url="https://api.moonshot.cn/v1",
            )
            provider = KimiProvider(config)
            provider.client = mock_openai_client
            return provider

    @pytest.mark.asyncio
    async def test_chat_preserves_reasoning_content_from_response(self, provider, sample_messages):
        mock_tool_call = MagicMock()
        mock_tool_call.id = "call_123"
        mock_tool_call.type = "function"
        mock_tool_call.function.name = "read_skill"
        mock_tool_call.function.arguments = '{"skill_id":"deep-research"}'

        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = ""
        mock_response.choices[0].message.reasoning_content = "I should load the matching skill first."
        mock_response.choices[0].message.tool_calls = [mock_tool_call]
        mock_response.choices[0].finish_reason = "tool_calls"
        mock_response.model = "kimi-k2.5"
        mock_response.usage = MagicMock()
        mock_response.usage.prompt_tokens = 10
        mock_response.usage.completion_tokens = 5
        mock_response.usage.total_tokens = 15
        provider.client.chat.completions.create = AsyncMock(return_value=mock_response)

        response = await provider.chat(sample_messages)

        assert response.reasoning_content == "I should load the matching skill first."
        assert response.tool_calls[0]["function"]["name"] == "read_skill"

    @pytest.mark.asyncio
    async def test_chat_replays_reasoning_content_in_assistant_history(self, provider):
        messages = [
            {"role": "system", "content": "You are a planner."},
            {"role": "user", "content": "使用deep-research技能研究拼多多股票"},
            {
                "role": "assistant",
                "content": "",
                "reasoning_content": "Need to load skill before planning.",
                "tool_calls": [
                    {
                        "id": "read_skill:0",
                        "type": "function",
                        "function": {
                            "name": "read_skill",
                            "arguments": "{\"skill_id\":\"deep-research\"}",
                        },
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "read_skill:0",
                "content": "{\"ok\":true}",
            },
        ]

        await provider.chat(messages)

        call_args = provider.client.chat.completions.create.call_args
        api_messages = call_args.kwargs["messages"]
        assistant_message = api_messages[2]
        assert assistant_message["role"] == "assistant"
        assert assistant_message["reasoning_content"] == "Need to load skill before planning."
        assert assistant_message["tool_calls"][0]["function"]["name"] == "read_skill"
