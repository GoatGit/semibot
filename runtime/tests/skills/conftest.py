"""Shared fixtures for skills tests."""

from unittest.mock import AsyncMock

import pytest

from src.skills.base import BaseSkill, BaseTool, SkillConfig, ToolResult


class MockTool(BaseTool):
    """Mock tool for testing."""

    def __init__(self, name: str = "mock_tool", should_fail: bool = False):
        self._name = name
        self._should_fail = should_fail

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return f"Mock tool: {self._name}"

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "input": {"type": "string", "description": "Input value"}
            },
            "required": ["input"],
        }

    async def execute(self, **kwargs) -> ToolResult:
        if self._should_fail:
            return ToolResult.error_result("Mock error")
        return ToolResult.success_result(f"Result for {kwargs.get('input', 'unknown')}")


class MockSkill(BaseSkill):
    """Mock skill for testing."""

    async def execute(self, context: dict) -> ToolResult:
        query = context.get("query", "")
        return ToolResult.success_result(f"Skill result for: {query}")


@pytest.fixture
def mock_tool():
    """Create a mock tool."""
    return MockTool()


@pytest.fixture
def failing_tool():
    """Create a failing mock tool."""
    return MockTool(should_fail=True)


@pytest.fixture
def mock_skill_config():
    """Create a mock skill configuration."""
    return SkillConfig(
        name="mock_skill",
        description="A mock skill for testing",
        trigger_keywords=["mock", "test", "example"],
        tools=["mock_tool"],
    )


@pytest.fixture
def mock_skill(mock_skill_config):
    """Create a mock skill."""
    return MockSkill(config=mock_skill_config)


@pytest.fixture
def sample_tool_params():
    """Sample tool parameters."""
    return {"input": "test value"}


@pytest.fixture
def sample_skill_context():
    """Sample skill context."""
    return {"query": "test query", "user_id": "user_123"}
