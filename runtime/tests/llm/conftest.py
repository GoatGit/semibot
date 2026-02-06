"""Shared fixtures for LLM tests."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from src.llm.base import LLMConfig, LLMResponse


@pytest.fixture
def sample_llm_config():
    """Sample LLM configuration."""
    return LLMConfig(
        model="gpt-4o",
        api_key="test-api-key",
        temperature=0.7,
        max_tokens=4096,
    )


@pytest.fixture
def sample_messages():
    """Sample chat messages."""
    return [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello, how are you?"},
    ]


@pytest.fixture
def sample_llm_response():
    """Sample LLM response."""
    return LLMResponse(
        content="I'm doing well, thank you!",
        model="gpt-4o",
        usage={
            "prompt_tokens": 20,
            "completion_tokens": 10,
            "total_tokens": 30,
        },
        tool_calls=[],
        finish_reason="stop",
    )


@pytest.fixture
def mock_openai_client():
    """Mock OpenAI async client."""
    client = AsyncMock()

    # Mock chat completion response
    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message.content = "Test response"
    mock_response.choices[0].message.tool_calls = None
    mock_response.choices[0].finish_reason = "stop"
    mock_response.model = "gpt-4o"
    mock_response.usage = MagicMock()
    mock_response.usage.prompt_tokens = 10
    mock_response.usage.completion_tokens = 5
    mock_response.usage.total_tokens = 15

    client.chat.completions.create = AsyncMock(return_value=mock_response)

    return client


@pytest.fixture
def mock_anthropic_client():
    """Mock Anthropic async client."""
    client = AsyncMock()

    # Mock message response
    mock_response = MagicMock()
    mock_response.content = [MagicMock()]
    mock_response.content[0].type = "text"
    mock_response.content[0].text = "Test response"
    mock_response.model = "claude-3-sonnet"
    mock_response.usage = MagicMock()
    mock_response.usage.input_tokens = 10
    mock_response.usage.output_tokens = 5
    mock_response.stop_reason = "end_turn"

    client.messages.create = AsyncMock(return_value=mock_response)

    return client


@pytest.fixture
def sample_tools():
    """Sample tool definitions."""
    return [
        {
            "name": "web_search",
            "description": "Search the web for information",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"}
                },
                "required": ["query"],
            },
        },
        {
            "name": "calculator",
            "description": "Perform mathematical calculations",
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": {"type": "string", "description": "Math expression"}
                },
                "required": ["expression"],
            },
        },
    ]
