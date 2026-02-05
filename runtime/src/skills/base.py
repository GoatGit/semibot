"""Base classes for Tools and Skills.

Tools are atomic operations (search, execute code, etc.)
Skills are higher-level capabilities that combine multiple tools.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ToolResult:
    """Result of a tool execution."""

    success: bool = True
    result: Any = None
    error: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def success_result(cls, result: Any, **metadata: Any) -> "ToolResult":
        """Create a successful result."""
        return cls(success=True, result=result, metadata=metadata)

    @classmethod
    def error_result(cls, error: str, **metadata: Any) -> "ToolResult":
        """Create an error result."""
        return cls(success=False, error=error, metadata=metadata)


class BaseTool(ABC):
    """
    Abstract base class for all tools.

    Tools are atomic operations that can be invoked by agents.
    Each tool has a name, description, and parameter schema.

    Example:
        ```python
        class CalculatorTool(BaseTool):
            @property
            def name(self) -> str:
                return "calculator"

            @property
            def description(self) -> str:
                return "Perform mathematical calculations"

            @property
            def parameters(self) -> dict:
                return {
                    "type": "object",
                    "properties": {
                        "expression": {"type": "string"}
                    },
                    "required": ["expression"]
                }

            async def execute(self, expression: str) -> ToolResult:
                result = eval(expression)  # Simplified
                return ToolResult.success_result(result)
        ```
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Get the tool name."""
        pass

    @property
    @abstractmethod
    def description(self) -> str:
        """Get the tool description."""
        pass

    @property
    @abstractmethod
    def parameters(self) -> dict[str, Any]:
        """
        Get the parameter schema (JSON Schema format).

        Returns:
            JSON Schema for the tool parameters
        """
        pass

    @abstractmethod
    async def execute(self, **kwargs: Any) -> ToolResult:
        """
        Execute the tool.

        Args:
            **kwargs: Tool parameters

        Returns:
            ToolResult with success status and result/error
        """
        pass

    @property
    def schema(self) -> dict[str, Any]:
        """
        Get the tool schema for LLM function calling.

        Returns:
            OpenAI function calling format schema
        """
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }

    def validate_params(self, params: dict[str, Any]) -> tuple[bool, str | None]:
        """
        Validate parameters against the schema.

        Args:
            params: Parameters to validate

        Returns:
            Tuple of (is_valid, error_message)
        """
        # Check required parameters
        required = self.parameters.get("required", [])
        for param in required:
            if param not in params:
                return False, f"Missing required parameter: {param}"
        return True, None


@dataclass
class SkillConfig:
    """Configuration for a skill."""

    name: str
    description: str
    trigger_keywords: list[str] = field(default_factory=list)
    tools: list[str] = field(default_factory=list)
    config: dict[str, Any] = field(default_factory=dict)


class BaseSkill(ABC):
    """
    Abstract base class for all skills.

    Skills are higher-level capabilities that combine multiple tools
    to accomplish complex tasks. They provide a more natural interface
    for agents to use.

    Example:
        ```python
        class ResearchSkill(BaseSkill):
            async def execute(self, context: dict) -> ToolResult:
                query = context.get("query")

                # Use search tool
                search_result = await self.call_tool("web_search", {"query": query})

                # Use summarizer tool
                summary = await self.call_tool("summarize", {"text": search_result})

                return ToolResult.success_result(summary)
        ```
    """

    def __init__(
        self,
        config: SkillConfig,
        tool_registry: Any = None,
    ):
        """
        Initialize the skill.

        Args:
            config: Skill configuration
            tool_registry: Registry for accessing tools
        """
        self.config = config
        self.tool_registry = tool_registry

    @property
    def name(self) -> str:
        """Get the skill name."""
        return self.config.name

    @property
    def description(self) -> str:
        """Get the skill description."""
        return self.config.description

    @property
    def trigger_keywords(self) -> list[str]:
        """Get the trigger keywords."""
        return self.config.trigger_keywords

    def matches(self, text: str) -> bool:
        """
        Check if text matches this skill's trigger keywords.

        Args:
            text: Text to check

        Returns:
            True if text matches any trigger keyword
        """
        text_lower = text.lower()
        return any(kw.lower() in text_lower for kw in self.trigger_keywords)

    @abstractmethod
    async def execute(self, context: dict[str, Any]) -> ToolResult:
        """
        Execute the skill.

        Args:
            context: Execution context with parameters

        Returns:
            ToolResult with the skill's output
        """
        pass

    async def call_tool(self, tool_name: str, params: dict[str, Any]) -> Any:
        """
        Call a tool from the registry.

        Args:
            tool_name: Name of the tool
            params: Tool parameters

        Returns:
            Tool execution result
        """
        if not self.tool_registry:
            raise RuntimeError("Tool registry not configured")

        if tool_name not in self.config.tools:
            raise ValueError(f"Tool {tool_name} not available for skill {self.name}")

        result = await self.tool_registry.execute(tool_name, params)
        return result

    def to_schema(self) -> dict[str, Any]:
        """
        Get the skill schema for LLM.

        Returns:
            Schema dictionary
        """
        return {
            "name": self.name,
            "description": self.description,
            "trigger_keywords": self.trigger_keywords,
            "tools": self.config.tools,
        }
