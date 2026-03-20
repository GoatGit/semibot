"""Skill and Tool Registry.

Central registry for all available tools and skills.
Provides lookup, execution, and schema generation.
"""

from typing import Any
from dataclasses import dataclass, field

from src.skills.base import BaseSkill, BaseTool, ToolResult
from src.utils.logging import get_logger

logger = get_logger(__name__)


@dataclass
class SkillMetadata:
    """Metadata for a registered skill."""

    version: str | None = None
    source: str = "local"  # "local", "anthropic", "custom"
    author: str | None = None
    tags: list[str] = field(default_factory=list)
    additional: dict[str, Any] = field(default_factory=dict)


class SkillRegistry:
    """
    Central registry for tools and skills.

    The registry:
    - Manages tool and skill registration
    - Provides lookup by name
    - Handles execution routing
    - Generates schemas for LLM function calling

    Example:
        ```python
        registry = SkillRegistry()

        # Register tools
        registry.register_tool(WebSearchTool())
        registry.register_tool(CodeExecutorTool())

        # Register skills
        registry.register_skill(ResearchSkill())

        # Execute
        result = await registry.execute("web_search", {"query": "AI news"})
        ```
    """

    def __init__(self):
        """Initialize the registry."""
        self._tools: dict[str, BaseTool] = {}
        self._skills: dict[str, BaseSkill] = {}
        self._skill_metadata: dict[str, SkillMetadata] = {}
        self._tool_metadata: dict[str, SkillMetadata] = {}

    def register_tool(
        self,
        tool: BaseTool,
        metadata: SkillMetadata | None = None,
    ) -> None:
        """
        Register a tool.

        Args:
            tool: Tool instance to register
            metadata: Optional metadata for the tool
        """
        self._tools[tool.name] = tool
        if metadata:
            self._tool_metadata[tool.name] = metadata
        logger.info(
            f"Registered tool: {tool.name}",
            extra={
                "tool_name": tool.name,
                "version": metadata.version if metadata else None,
                "source": metadata.source if metadata else "local",
            },
        )

    def register_skill(
        self,
        skill: BaseSkill,
        metadata: SkillMetadata | None = None,
    ) -> None:
        """
        Register a skill.

        Args:
            skill: Skill instance to register
            metadata: Optional metadata for the skill
        """
        self._skills[skill.name] = skill
        if metadata:
            self._skill_metadata[skill.name] = metadata
        logger.info(
            f"Registered skill: {skill.name}",
            extra={
                "skill_name": skill.name,
                "version": metadata.version if metadata else None,
                "source": metadata.source if metadata else "local",
            },
        )

    def get_tool(self, name: str) -> BaseTool | None:
        """
        Get a tool by name.

        Args:
            name: Tool name

        Returns:
            Tool instance or None
        """
        return self._tools.get(name)

    def get_skill(self, name: str) -> BaseSkill | None:
        """
        Get a skill by name.

        Args:
            name: Skill name

        Returns:
            Skill instance or None
        """
        return self._skills.get(name)

    def get_skill_metadata(self, name: str) -> SkillMetadata | None:
        """
        Get metadata for a skill.

        Args:
            name: Skill name

        Returns:
            SkillMetadata or None
        """
        return self._skill_metadata.get(name)

    def get_tool_metadata(self, name: str) -> SkillMetadata | None:
        """
        Get metadata for a tool.

        Args:
            name: Tool name

        Returns:
            SkillMetadata or None
        """
        return self._tool_metadata.get(name)

    def list_tools(self) -> list[str]:
        """Get list of registered tool names."""
        return list(self._tools.keys())

    def list_skills(self) -> list[str]:
        """Get list of registered skill names."""
        return list(self._skills.keys())

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        """
        Get schemas for all registered tools.

        Returns:
            List of tool schemas in OpenAI function calling format
        """
        return [tool.schema for tool in self._tools.values()]

    def get_skill_schemas(self) -> list[dict[str, Any]]:
        """
        Get schemas for all registered skills.

        Returns:
            List of skill schemas
        """
        return [skill.to_schema() for skill in self._skills.values()]

    def get_all_schemas(self) -> list[dict[str, Any]]:
        """
        Get schemas for all tools and skills.

        Returns:
            Combined list of all schemas with metadata
        """
        schemas = []

        # Add tool schemas
        for tool in self._tools.values():
            schema = {
                "type": "tool",
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            }
            # Add metadata if available
            metadata = self._tool_metadata.get(tool.name)
            if metadata:
                schema["metadata"] = {
                    "version": metadata.version,
                    "source": metadata.source,
                    "author": metadata.author,
                    "tags": metadata.tags,
                }
            schemas.append(schema)

        # Add skill schemas
        for skill in self._skills.values():
            schema = {
                "type": "skill",
                "name": skill.name,
                "description": skill.description,
                "trigger_keywords": skill.trigger_keywords,
            }
            # Add metadata if available
            metadata = self._skill_metadata.get(skill.name)
            if metadata:
                schema["metadata"] = {
                    "version": metadata.version,
                    "source": metadata.source,
                    "author": metadata.author,
                    "tags": metadata.tags,
                }
            schemas.append(schema)

        return schemas

    def match_skill(self, text: str) -> BaseSkill | None:
        """
        Find a skill that matches the given text.

        Args:
            text: Text to match against skill keywords

        Returns:
            Matching skill or None
        """
        for skill in self._skills.values():
            if skill.matches(text):
                return skill
        return None

    async def execute(
        self,
        name: str,
        params: dict[str, Any],
    ) -> ToolResult:
        """
        Execute a tool or skill by name.

        Args:
            name: Tool or skill name
            params: Execution parameters

        Returns:
            ToolResult with execution result
        """
        # Try as tool first
        tool = self.get_tool(name)
        if tool:
            logger.debug(f"Executing tool: {name}")
            try:
                # Validate parameters
                is_valid, error = tool.validate_params(params)
                if not is_valid:
                    return ToolResult.error_result(error or "Invalid parameters")

                return await tool.execute(**params)
            except Exception as e:
                logger.error(f"Tool {name} execution failed: {e}")
                return ToolResult.error_result(str(e))

        # Try as skill
        skill = self.get_skill(name)
        if skill:
            logger.debug(f"Executing skill: {name}")
            try:
                return await skill.execute(params)
            except Exception as e:
                logger.error(f"Skill {name} execution failed: {e}")
                return ToolResult.error_result(str(e))

        # Not found
        logger.warning(f"Tool/skill not found: {name}")
        return ToolResult.error_result(f"Tool or skill '{name}' not found")

    async def execute_parallel(
        self,
        calls: list[tuple[str, dict[str, Any]]],
    ) -> list[ToolResult]:
        """
        Execute multiple tools/skills in parallel.

        Args:
            calls: List of (name, params) tuples

        Returns:
            List of ToolResults
        """
        import asyncio

        tasks = [self.execute(name, params) for name, params in calls]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Convert exceptions to error results
        processed = []
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                processed.append(ToolResult.error_result(str(result)))
            else:
                processed.append(result)

        return processed


class ActionExecutor:
    """
    Unified action executor for the orchestrator.

    Wraps the SkillRegistry to provide a consistent interface
    for executing actions from the state machine.
    """

    def __init__(self, registry: SkillRegistry):
        """
        Initialize the executor.

        Args:
            registry: SkillRegistry instance
        """
        self.registry = registry

    async def execute(
        self,
        name: str | None,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        """
        Execute an action.

        Args:
            name: Tool/skill name
            params: Execution parameters

        Returns:
            Result dictionary with 'result' or 'error'
        """
        if not name:
            return {"error": "No tool/skill name provided"}

        result = await self.registry.execute(name, params)

        if result.success:
            return {"result": result.result, **result.metadata}
        else:
            return {"error": result.error}
