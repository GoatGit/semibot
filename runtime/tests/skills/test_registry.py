"""Tests for SkillRegistry."""

import pytest

from src.skills.base import ToolResult
from src.skills.registry import ActionExecutor, SkillRegistry
from tests.skills.conftest import MockSkill, MockTool


class TestSkillRegistry:
    """Tests for SkillRegistry class."""

    def test_create_registry(self):
        """Test creating an empty registry."""
        registry = SkillRegistry()

        assert registry.list_tools() == []
        assert registry.list_skills() == []

    def test_register_tool(self):
        """Test registering a tool."""
        registry = SkillRegistry()
        tool = MockTool(name="test_tool")

        registry.register_tool(tool)

        assert "test_tool" in registry.list_tools()
        assert registry.get_tool("test_tool") == tool

    def test_register_skill(self, mock_skill):
        """Test registering a skill."""
        registry = SkillRegistry()

        registry.register_skill(mock_skill)

        assert "mock_skill" in registry.list_skills()
        assert registry.get_skill("mock_skill") == mock_skill

    def test_get_tool_not_found(self):
        """Test getting non-existent tool."""
        registry = SkillRegistry()

        assert registry.get_tool("unknown") is None

    def test_get_skill_not_found(self):
        """Test getting non-existent skill."""
        registry = SkillRegistry()

        assert registry.get_skill("unknown") is None

    def test_get_tool_schemas(self):
        """Test getting tool schemas."""
        registry = SkillRegistry()
        registry.register_tool(MockTool(name="tool1"))
        registry.register_tool(MockTool(name="tool2"))

        schemas = registry.get_tool_schemas()

        assert len(schemas) == 2
        names = [s["function"]["name"] for s in schemas]
        assert "tool1" in names
        assert "tool2" in names

    def test_get_skill_schemas(self, mock_skill):
        """Test getting skill schemas."""
        registry = SkillRegistry()
        registry.register_skill(mock_skill)

        schemas = registry.get_skill_schemas()

        assert len(schemas) == 1
        assert schemas[0]["name"] == "mock_skill"

    def test_get_all_schemas(self, mock_skill):
        """Test getting all schemas."""
        registry = SkillRegistry()
        registry.register_tool(MockTool(name="tool1"))
        registry.register_skill(mock_skill)

        schemas = registry.get_all_schemas()

        assert len(schemas) == 2
        types = [s["type"] for s in schemas]
        assert "tool" in types
        assert "skill" in types

    def test_match_skill(self, mock_skill):
        """Test matching skills by keywords."""
        registry = SkillRegistry()
        registry.register_skill(mock_skill)

        matched = registry.match_skill("Run a mock test")

        assert matched == mock_skill

    def test_match_skill_no_match(self, mock_skill):
        """Test no skill matches."""
        registry = SkillRegistry()
        registry.register_skill(mock_skill)

        matched = registry.match_skill("No matching keywords")

        assert matched is None

    @pytest.mark.asyncio
    async def test_execute_tool(self):
        """Test executing a tool."""
        registry = SkillRegistry()
        registry.register_tool(MockTool(name="test_tool"))

        result = await registry.execute("test_tool", {"input": "hello"})

        assert result.success is True
        assert "hello" in result.result

    @pytest.mark.asyncio
    async def test_execute_skill(self, mock_skill):
        """Test executing a skill."""
        registry = SkillRegistry()
        registry.register_skill(mock_skill)

        result = await registry.execute("mock_skill", {"query": "test"})

        assert result.success is True

    @pytest.mark.asyncio
    async def test_execute_not_found(self):
        """Test executing non-existent tool/skill."""
        registry = SkillRegistry()

        result = await registry.execute("unknown", {})

        assert result.success is False
        assert "not found" in result.error

    @pytest.mark.asyncio
    async def test_execute_with_invalid_params(self):
        """Test executing tool with invalid params."""
        registry = SkillRegistry()
        registry.register_tool(MockTool(name="test_tool"))

        result = await registry.execute("test_tool", {})  # Missing required 'input'

        assert result.success is False
        assert "input" in result.error

    @pytest.mark.asyncio
    async def test_execute_parallel(self):
        """Test parallel execution of multiple tools."""
        registry = SkillRegistry()
        registry.register_tool(MockTool(name="tool1"))
        registry.register_tool(MockTool(name="tool2"))

        calls = [
            ("tool1", {"input": "first"}),
            ("tool2", {"input": "second"}),
        ]

        results = await registry.execute_parallel(calls)

        assert len(results) == 2
        assert all(r.success for r in results)


class TestActionExecutor:
    """Tests for ActionExecutor class."""

    @pytest.mark.asyncio
    async def test_execute_action(self):
        """Test executing an action."""
        registry = SkillRegistry()
        registry.register_tool(MockTool(name="test_tool"))
        executor = ActionExecutor(registry)

        result = await executor.execute("test_tool", {"input": "test"})

        assert "result" in result
        assert "test" in result["result"]

    @pytest.mark.asyncio
    async def test_execute_action_no_name(self):
        """Test executing with no name returns error."""
        registry = SkillRegistry()
        executor = ActionExecutor(registry)

        result = await executor.execute(None, {})

        assert "error" in result

    @pytest.mark.asyncio
    async def test_execute_action_failure(self):
        """Test executing failed action."""
        registry = SkillRegistry()
        registry.register_tool(MockTool(name="failing_tool", should_fail=True))
        executor = ActionExecutor(registry)

        result = await executor.execute("failing_tool", {"input": "test"})

        assert "error" in result
