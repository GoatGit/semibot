"""Capability Graph - Dynamic capability management for runtime sessions.

This module implements the CapabilityGraph that manages available skills, tools,
and MCP servers for a runtime session. It ensures that the planner only sees
capabilities that are actually bound to the agent.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from src.orchestrator.context import (
    RuntimeSessionContext,
    SkillDefinition,
    ToolDefinition,
    McpServerDefinition,
)
from src.utils.logging import get_logger

logger = get_logger(__name__)


@dataclass
class Capability(ABC):
    """
    Base class for all capabilities (skills, tools, MCP tools).

    A capability represents an executable action that can be invoked
    during runtime execution.
    """

    name: str = ""
    description: str | None = None
    capability_type: str = field(init=False)  # "skill", "tool", "mcp"
    metadata: dict[str, Any] = field(default_factory=dict)

    @abstractmethod
    def to_schema(self) -> dict[str, Any]:
        """
        Convert capability to LLM-compatible schema.

        Returns:
            Schema dict in OpenAI function calling format
        """
        pass

    @abstractmethod
    def validate_params(self, params: dict[str, Any]) -> tuple[bool, str | None]:
        """
        Validate parameters for this capability.

        Args:
            params: Parameters to validate

        Returns:
            Tuple of (is_valid, error_message)
        """
        pass


@dataclass
class SkillCapability(Capability):
    """Capability representing a Skill."""

    skill_definition: SkillDefinition | None = None
    capability_type: str = field(default="skill", init=False)

    def __post_init__(self):
        """Initialize from skill definition if provided."""
        if self.skill_definition:
            self.name = self.skill_definition.name
            self.description = self.skill_definition.description
            self.metadata = {
                "id": self.skill_definition.id,
                "version": self.skill_definition.version,
                "source": self.skill_definition.source,
                **self.skill_definition.metadata,
            }

    def to_schema(self) -> dict[str, Any]:
        """Convert skill to LLM schema."""
        schema = {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description or f"Execute {self.name} skill",
            },
        }

        # Add parameters from skill definition schema if available
        if self.skill_definition and self.skill_definition.schema:
            skill_schema = self.skill_definition.schema
            if "parameters" in skill_schema:
                schema["function"]["parameters"] = skill_schema["parameters"]
            elif "input_schema" in skill_schema:
                schema["function"]["parameters"] = skill_schema["input_schema"]

        # Add metadata
        schema["metadata"] = {
            "capability_type": "skill",
            "source": self.metadata.get("source", "local"),
            "version": self.metadata.get("version"),
        }

        return schema

    def validate_params(self, params: dict[str, Any]) -> tuple[bool, str | None]:
        """Validate skill parameters."""
        # Basic validation - can be extended based on skill schema
        if not isinstance(params, dict):
            return False, "Parameters must be a dictionary"

        # 如果有 schema 定义，进行基本验证
        if self.skill_definition and hasattr(self.skill_definition, 'schema') and self.skill_definition.schema:
            schema = self.skill_definition.schema

            # 检查必需参数
            if 'required' in schema and isinstance(schema['required'], list):
                for required_field in schema['required']:
                    if required_field not in params:
                        return False, f"Missing required parameter: {required_field}"

            # 检查参数类型（基本类型检查）
            if 'properties' in schema and isinstance(schema['properties'], dict):
                for param_name, param_value in params.items():
                    if param_name in schema['properties']:
                        expected_type = schema['properties'][param_name].get('type')
                        if expected_type:
                            if not self._validate_type(param_value, expected_type):
                                return False, f"Parameter '{param_name}' has invalid type (expected: {expected_type})"

        return True, None

    def _validate_type(self, value: Any, expected_type: str) -> bool:
        """验证值的类型是否匹配预期类型"""
        type_mapping = {
            'string': str,
            'number': (int, float),
            'integer': int,
            'boolean': bool,
            'array': list,
            'object': dict,
        }
        expected_python_type = type_mapping.get(expected_type)
        if expected_python_type:
            return isinstance(value, expected_python_type)
        return True  # 未知类型，跳过验证


@dataclass
class ToolCapability(Capability):
    """Capability representing a built-in Tool."""

    tool_definition: ToolDefinition | None = None
    capability_type: str = field(default="tool", init=False)

    def __post_init__(self):
        """Initialize from tool definition if provided."""
        if self.tool_definition:
            self.name = self.tool_definition.name
            self.description = self.tool_definition.description
            self.metadata = {**self.tool_definition.metadata}

    def to_schema(self) -> dict[str, Any]:
        """Convert tool to LLM schema."""
        schema = {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description or f"Execute {self.name} tool",
            },
        }

        # Add parameters from tool definition
        if self.tool_definition and self.tool_definition.parameters:
            schema["function"]["parameters"] = self.tool_definition.parameters

        # Add metadata
        schema["metadata"] = {
            "capability_type": "tool",
            "source": "builtin",
        }

        return schema

    def validate_params(self, params: dict[str, Any]) -> tuple[bool, str | None]:
        """Validate tool parameters."""
        if not isinstance(params, dict):
            return False, "Parameters must be a dictionary"

        # 如果有参数定义，进行验证
        if self.tool_definition and self.tool_definition.parameters:
            parameters = self.tool_definition.parameters

            # 检查必需参数
            if 'required' in parameters and isinstance(parameters['required'], list):
                for required_field in parameters['required']:
                    if required_field not in params:
                        return False, f"Missing required parameter: {required_field}"

            # 检查参数类型
            if 'properties' in parameters and isinstance(parameters['properties'], dict):
                for param_name, param_value in params.items():
                    if param_name in parameters['properties']:
                        expected_type = parameters['properties'][param_name].get('type')
                        if expected_type:
                            if not self._validate_type(param_value, expected_type):
                                return False, f"Parameter '{param_name}' has invalid type (expected: {expected_type})"

        return True, None

    def _validate_type(self, value: Any, expected_type: str) -> bool:
        """验证值的类型是否匹配预期类型"""
        type_mapping = {
            'string': str,
            'number': (int, float),
            'integer': int,
            'boolean': bool,
            'array': list,
            'object': dict,
        }
        expected_python_type = type_mapping.get(expected_type)
        if expected_python_type:
            return isinstance(value, expected_python_type)
        return True


@dataclass
class McpCapability(Capability):
    """Capability representing an MCP server tool."""

    mcp_server_id: str = ""
    mcp_server_name: str = ""
    tool_schema: dict[str, Any] = field(default_factory=dict)
    capability_type: str = field(default="mcp", init=False)

    def __post_init__(self):
        """Initialize metadata with MCP server info."""
        self.metadata = {
            "mcp_server_id": self.mcp_server_id,
            "mcp_server_name": self.mcp_server_name,
        }

    def to_schema(self) -> dict[str, Any]:
        """Convert MCP tool to LLM schema."""
        schema = {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description or f"Execute {self.name} via MCP",
            },
        }

        # Add parameters from MCP tool schema
        if self.tool_schema:
            if "inputSchema" in self.tool_schema:
                schema["function"]["parameters"] = self.tool_schema["inputSchema"]
            elif "parameters" in self.tool_schema:
                schema["function"]["parameters"] = self.tool_schema["parameters"]

        # Add metadata
        schema["metadata"] = {
            "capability_type": "mcp",
            "mcp_server_id": self.mcp_server_id,
            "mcp_server_name": self.mcp_server_name,
        }

        return schema

    def validate_params(self, params: dict[str, Any]) -> tuple[bool, str | None]:
        """Validate MCP tool parameters."""
        if not isinstance(params, dict):
            return False, "Parameters must be a dictionary"

        # 从 tool_schema 中提取参数定义
        parameters = None
        if self.tool_schema:
            if "inputSchema" in self.tool_schema:
                parameters = self.tool_schema["inputSchema"]
            elif "parameters" in self.tool_schema:
                parameters = self.tool_schema["parameters"]

        # 如果有参数定义，进行验证
        if parameters:
            # 检查必需参数
            if 'required' in parameters and isinstance(parameters['required'], list):
                for required_field in parameters['required']:
                    if required_field not in params:
                        return False, f"Missing required parameter: {required_field}"

            # 检查参数类型
            if 'properties' in parameters and isinstance(parameters['properties'], dict):
                for param_name, param_value in params.items():
                    if param_name in parameters['properties']:
                        expected_type = parameters['properties'][param_name].get('type')
                        if expected_type:
                            if not self._validate_type(param_value, expected_type):
                                return False, f"Parameter '{param_name}' has invalid type (expected: {expected_type})"

        return True, None

    def _validate_type(self, value: Any, expected_type: str) -> bool:
        """验证值的类型是否匹配预期类型"""
        type_mapping = {
            'string': str,
            'number': (int, float),
            'integer': int,
            'boolean': bool,
            'array': list,
            'object': dict,
        }
        expected_python_type = type_mapping.get(expected_type)
        if expected_python_type:
            return isinstance(value, expected_python_type)
        return True


class CapabilityGraph:
    """
    Session-level capability graph.

    The CapabilityGraph manages all available capabilities for a runtime session.
    It builds the graph from RuntimeSessionContext and provides methods to:
    - Generate schemas for the planner
    - Validate actions before execution
    - Look up capabilities by name
    """

    def __init__(self, context: RuntimeSessionContext):
        """
        Initialize the capability graph.

        Args:
            context: Runtime session context
        """
        self.context = context
        self.capabilities: dict[str, Capability] = {}
        self._built = False

    def build(self) -> None:
        """
        Build the capability graph from context.

        This method:
        1. Loads agent-bound skills
        2. Loads built-in tools
        3. Loads MCP server tools (if connected)
        4. Filters by permissions and status
        """
        if self._built:
            logger.debug("Capability graph already built, skipping")
            return

        logger.info(
            "Building capability graph",
            extra={
                "session_id": self.context.session_id,
                "agent_id": self.context.agent_id,
            },
        )

        # Clear existing capabilities
        self.capabilities.clear()

        # 1. Load skills
        for skill_def in self.context.available_skills:
            capability = SkillCapability(skill_definition=skill_def)
            self.capabilities[capability.name] = capability
            logger.debug(f"Added skill capability: {capability.name}")

        # 2. Load tools
        for tool_def in self.context.available_tools:
            capability = ToolCapability(tool_definition=tool_def)
            self.capabilities[capability.name] = capability
            logger.debug(f"Added tool capability: {capability.name}")

        # 3. Load MCP server tools (only from connected servers)
        for mcp_server in self.context.get_connected_mcp_servers():
            for tool in mcp_server.available_tools:
                tool_name = tool.get("name")
                if not tool_name:
                    continue

                capability = McpCapability(
                    name=tool_name,
                    description=tool.get("description"),
                    mcp_server_id=mcp_server.id,
                    mcp_server_name=mcp_server.name,
                    tool_schema=tool,
                )
                self.capabilities[capability.name] = capability
                logger.debug(
                    f"Added MCP capability: {capability.name} from {mcp_server.name}"
                )

        self._built = True

        logger.info(
            "Capability graph built",
            extra={
                "session_id": self.context.session_id,
                "total_capabilities": len(self.capabilities),
                "skills": len([c for c in self.capabilities.values() if c.capability_type == "skill"]),
                "tools": len([c for c in self.capabilities.values() if c.capability_type == "tool"]),
                "mcp_tools": len([c for c in self.capabilities.values() if c.capability_type == "mcp"]),
            },
        )

    def get_schemas_for_planner(self) -> list[dict[str, Any]]:
        """
        Generate LLM-compatible schemas for the planner.

        This method returns only the capabilities that the agent has
        permission to use.

        Returns:
            List of capability schemas in OpenAI function calling format
        """
        if not self._built:
            self.build()

        schemas = []
        for capability in self.capabilities.values():
            try:
                schema = capability.to_schema()
                schemas.append(schema)
            except Exception as e:
                logger.warning(
                    f"Failed to generate schema for {capability.name}: {e}"
                )

        logger.debug(
            f"Generated {len(schemas)} schemas for planner",
            extra={"session_id": self.context.session_id},
        )

        return schemas

    def validate_action(self, action_name: str) -> bool:
        """
        Validate that an action is in the capability graph.

        Args:
            action_name: Name of the action/tool to validate

        Returns:
            True if action is valid, False otherwise
        """
        if not self._built:
            self.build()

        is_valid = action_name in self.capabilities

        if not is_valid:
            logger.warning(
                f"Action validation failed: {action_name} not in capability graph",
                extra={
                    "session_id": self.context.session_id,
                    "action_name": action_name,
                    "available_capabilities": list(self.capabilities.keys()),
                },
            )

        return is_valid

    def get_capability(self, name: str) -> Capability | None:
        """
        Get a capability by name.

        Args:
            name: Capability name

        Returns:
            Capability instance or None if not found
        """
        if not self._built:
            self.build()

        return self.capabilities.get(name)

    def list_capabilities(self) -> list[str]:
        """
        Get list of all capability names.

        Returns:
            List of capability names
        """
        if not self._built:
            self.build()

        return list(self.capabilities.keys())

    def get_capabilities_by_type(self, capability_type: str) -> list[Capability]:
        """
        Get all capabilities of a specific type.

        Args:
            capability_type: Type of capability ("skill", "tool", "mcp")

        Returns:
            List of capabilities of the specified type
        """
        if not self._built:
            self.build()

        return [
            cap
            for cap in self.capabilities.values()
            if cap.capability_type == capability_type
        ]
