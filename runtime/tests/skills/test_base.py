"""Tests for skills base classes."""

import pytest

from src.skills.base import BaseSkill, BaseTool, SkillConfig, ToolResult


class TestToolResult:
    """Tests for ToolResult dataclass."""

    def test_create_success_result(self):
        """Test creating a success result."""
        result = ToolResult.success_result("Hello", extra="metadata")

        assert result.success is True
        assert result.result == "Hello"
        assert result.error is None
        assert result.metadata["extra"] == "metadata"

    def test_create_error_result(self):
        """Test creating an error result."""
        result = ToolResult.error_result("Something went wrong", code=500)

        assert result.success is False
        assert result.result is None
        assert result.error == "Something went wrong"
        assert result.metadata["code"] == 500

    def test_default_values(self):
        """Test default values."""
        result = ToolResult()

        assert result.success is True
        assert result.result is None
        assert result.error is None
        assert result.metadata == {}


class TestBaseTool:
    """Tests for BaseTool abstract class."""

    def test_tool_schema(self, mock_tool):
        """Test tool schema generation."""
        schema = mock_tool.schema

        assert schema["type"] == "function"
        assert schema["function"]["name"] == "mock_tool"
        assert "description" in schema["function"]
        assert "parameters" in schema["function"]

    def test_validate_params_success(self, mock_tool, sample_tool_params):
        """Test parameter validation success."""
        is_valid, error = mock_tool.validate_params(sample_tool_params)

        assert is_valid is True
        assert error is None

    def test_validate_params_missing_required(self, mock_tool):
        """Test parameter validation with missing required param."""
        is_valid, error = mock_tool.validate_params({})

        assert is_valid is False
        assert "input" in error

    @pytest.mark.asyncio
    async def test_execute_success(self, mock_tool, sample_tool_params):
        """Test successful tool execution."""
        result = await mock_tool.execute(**sample_tool_params)

        assert result.success is True
        assert "test value" in result.result

    @pytest.mark.asyncio
    async def test_execute_failure(self, failing_tool, sample_tool_params):
        """Test failed tool execution."""
        result = await failing_tool.execute(**sample_tool_params)

        assert result.success is False
        assert result.error == "Mock error"


class TestSkillConfig:
    """Tests for SkillConfig dataclass."""

    def test_create_config(self):
        """Test creating a skill config."""
        config = SkillConfig(
            name="research",
            description="Research skill",
            trigger_keywords=["search", "find", "research"],
            tools=["web_search", "summarize"],
        )

        assert config.name == "research"
        assert len(config.trigger_keywords) == 3
        assert len(config.tools) == 2

    def test_default_values(self):
        """Test default values."""
        config = SkillConfig(name="simple", description="Simple skill")

        assert config.trigger_keywords == []
        assert config.tools == []
        assert config.config == {}


class TestBaseSkill:
    """Tests for BaseSkill abstract class."""

    def test_skill_properties(self, mock_skill, mock_skill_config):
        """Test skill properties."""
        assert mock_skill.name == "mock_skill"
        assert mock_skill.description == "A mock skill for testing"
        assert mock_skill.trigger_keywords == ["mock", "test", "example"]

    def test_matches_keyword(self, mock_skill):
        """Test keyword matching."""
        assert mock_skill.matches("This is a mock request") is True
        assert mock_skill.matches("Run the test") is True
        assert mock_skill.matches("No keywords here") is False

    def test_matches_case_insensitive(self, mock_skill):
        """Test case-insensitive matching."""
        assert mock_skill.matches("MOCK request") is True
        assert mock_skill.matches("Test REQUEST") is True

    @pytest.mark.asyncio
    async def test_execute(self, mock_skill, sample_skill_context):
        """Test skill execution."""
        result = await mock_skill.execute(sample_skill_context)

        assert result.success is True
        assert "test query" in result.result

    def test_to_schema(self, mock_skill):
        """Test schema generation."""
        schema = mock_skill.to_schema()

        assert schema["name"] == "mock_skill"
        assert "description" in schema
        assert "trigger_keywords" in schema
        assert "tools" in schema

    @pytest.mark.asyncio
    async def test_call_tool_without_registry(self, mock_skill):
        """Test calling tool without registry raises error."""
        with pytest.raises(RuntimeError, match="Tool registry not configured"):
            await mock_skill.call_tool("mock_tool", {})

    @pytest.mark.asyncio
    async def test_call_tool_not_in_config(self, mock_skill_config):
        """Test calling tool not in skill's tool list raises error."""
        from unittest.mock import MagicMock

        skill = MockSkill(config=mock_skill_config, tool_registry=MagicMock())

        with pytest.raises(ValueError, match="not available"):
            await skill.call_tool("unknown_tool", {})
