"""Capability Graph - Dynamic capability management for runtime sessions.

This module implements the CapabilityGraph that manages available skills, tools,
and MCP servers for a runtime session. It ensures that the planner only sees
capabilities that are actually bound to the agent.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from src.orchestrator.context import (
    CapabilityDescriptor,
    RuntimeSessionContext,
    SkillDefinition,
    ToolDefinition,
    McpServerDefinition,
    ToolCatalogEntry,
)
from src.orchestrator.tool_catalog import expand_catalog_entry_for_llm
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
        # In Python, bool is a subclass of int. Reject bools for numeric types.
        if isinstance(value, bool) and expected_type in ('integer', 'number'):
            return False
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
            **self.metadata,
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


@dataclass
class SubAgentCapability(Capability):
    """Capability representing a delegatable sub-agent."""

    agent_id: str = ""
    capability_type: str = field(default="sub_agent", init=False)

    def to_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description or f"Delegate to {self.name}",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "task": {"type": "string", "description": "Delegated task"},
                    },
                    "required": ["task"],
                },
            },
            "metadata": {
                "capability_type": "sub_agent",
                "agent_id": self.agent_id,
            },
        }

    def validate_params(self, params: dict[str, Any]) -> tuple[bool, str | None]:
        if not isinstance(params, dict):
            return False, "Parameters must be a dictionary"
        if not str(params.get("task") or "").strip():
            return False, "Missing required parameter: task"
        return True, None


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
        self.capabilities_by_name: dict[str, Capability] = {}
        self._built = False

    def rebuild(self) -> None:
        """Reset and rebuild the capability graph (e.g., after MCP server reconnection)."""
        self._built = False
        self.capabilities.clear()
        self.capabilities_by_name.clear()
        self.build()

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
        self.capabilities_by_name.clear()

        # 1. Load skills (non-executable in runtime v2; used as orchestration context only)
        for skill_def in self.context.available_skills:
            logger.debug(
                "Skip skill from executable capabilities",
                extra={
                    "session_id": self.context.session_id,
                    "skill_name": skill_def.name,
                },
            )

        descriptors = self.context.get_capability_descriptors()
        if descriptors:
            for descriptor in descriptors:
                capability = self._capability_from_descriptor(descriptor)
                if capability is None:
                    continue
                self.capabilities[descriptor.id] = capability
                self.capabilities_by_name[descriptor.name] = capability
                logger.debug(
                    "Added descriptor capability",
                    extra={
                        "capability_id": descriptor.id,
                        "capability_name": descriptor.name,
                        "kind": descriptor.kind,
                        "source_type": descriptor.source.get("type"),
                    },
                )
        else:
            for entry in self.context.get_tool_catalog():
                entry_variants = [entry, *expand_catalog_entry_for_llm(entry)]
                seen_variant_ids: set[str] = set()
                for variant in entry_variants:
                    if variant.tool_id in seen_variant_ids:
                        continue
                    seen_variant_ids.add(variant.tool_id)
                    capability = self._capability_from_catalog_entry(variant)
                    self.capabilities[variant.tool_id] = capability
                    self.capabilities_by_name[variant.tool_name] = capability
                logger.debug(
                    "Added catalog capability",
                    extra={
                        "tool_id": entry.tool_id,
                        "tool_name": entry.tool_name,
                        "source_type": entry.source_type,
                    },
                )

        self._built = True

        logger.info(
            "Capability graph built",
            extra={
                "session_id": self.context.session_id,
                "total_capabilities": len(self.capabilities),
                "skills": len([c for c in self.capabilities_by_name.values() if c.capability_type == "skill"]),
                "tools": len([c for c in self.capabilities_by_name.values() if c.capability_type == "tool"]),
                "mcp_tools": len([c for c in self.capabilities_by_name.values() if c.capability_type == "mcp"]),
            },
        )

    def _capability_from_catalog_entry(self, entry: ToolCatalogEntry) -> Capability:
        if entry.source_type == "mcp":
            return McpCapability(
                name=entry.tool_name,
                description=entry.description,
                mcp_server_id=str(entry.metadata.get("mcp_server_id") or entry.provider_id or ""),
                mcp_server_name=str(entry.metadata.get("mcp_server_name") or entry.provider_id or ""),
                tool_schema={
                    "name": entry.actual_tool_name,
                    "description": entry.description,
                    "inputSchema": dict(entry.parameters or {}),
                },
                metadata={
                    **dict(entry.metadata or {}),
                    "tool_id": entry.tool_id,
                    "actual_tool_name": entry.actual_tool_name,
                    "display_name": entry.display_name,
                    "source": "mcp",
                },
            )

        tool_definition = ToolDefinition(
            name=entry.tool_name,
            description=entry.description,
            parameters=dict(entry.parameters or {}),
            metadata={
                **dict(entry.metadata or {}),
                "tool_id": entry.tool_id,
                "actual_tool_name": entry.actual_tool_name,
                "display_name": entry.display_name,
                "source": entry.source_type,
            },
        )
        return ToolCapability(tool_definition=tool_definition)

    def _capability_from_descriptor(self, descriptor: CapabilityDescriptor) -> Capability | None:
        if str(descriptor.kind or "").strip() == "sub_agent":
            return SubAgentCapability(
                name=descriptor.name,
                description=descriptor.description,
                agent_id=str(descriptor.source.get("agentId") or ""),
                metadata={
                    "tool_id": descriptor.id,
                    "capability_id": descriptor.id,
                    "display_name": descriptor.display_name,
                    "source": "agent",
                    "risk_level": descriptor.risk_level,
                    "requires_approval": descriptor.requires_approval,
                    "approval_policy_key": descriptor.approval_policy_key,
                    "agent_id": str(descriptor.source.get("agentId") or ""),
                    "sub_agent_id": str(descriptor.source.get("agentId") or ""),
                    **dict(descriptor.constraints or {}),
                    **dict(descriptor.metadata or {}),
                },
            )

        source_type = str(descriptor.source.get("type") or "builtin").strip() or "builtin"
        if source_type == "mcp":
            return McpCapability(
                name=descriptor.name,
                description=descriptor.description,
                mcp_server_id=str(descriptor.source.get("serverId") or ""),
                mcp_server_name=str(descriptor.source.get("serverName") or ""),
                tool_schema={
                    "name": descriptor.source.get("toolName") or descriptor.name,
                    "description": descriptor.description,
                    "inputSchema": dict(descriptor.input_schema or {}),
                },
                metadata={
                    "tool_id": descriptor.id,
                    "display_name": descriptor.display_name,
                    "source": "mcp",
                    **dict(descriptor.metadata or {}),
                },
            )

        tool_definition = ToolDefinition(
            name=descriptor.name,
            description=descriptor.description,
            parameters=dict(descriptor.input_schema or {}),
            metadata={
                "tool_id": descriptor.id,
                "display_name": descriptor.display_name,
                "source": source_type,
                "requires_approval": descriptor.requires_approval,
                "risk_level": descriptor.risk_level,
                "approval_policy_key": descriptor.approval_policy_key,
                **dict(descriptor.constraints or {}),
                **dict(descriptor.metadata or {}),
            },
        )
        return ToolCapability(tool_definition=tool_definition)

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

    def get_core_schemas_for_planner(self) -> list[dict[str, Any]]:
        """Return a small stable subset of schemas for planner-side grounding."""
        if not self._built:
            self.build()

        core_names = {
            "search",
            "web_fetch",
            "file_io",
            "semi_browser",
            "http_client",
            "text_processing",
            "memory",
            "code_executor",
        }
        schemas: list[dict[str, Any]] = []
        seen: set[str] = set()
        for capability in self.capabilities.values():
            if capability.name not in core_names or capability.name in seen:
                continue
            try:
                schemas.append(capability.to_schema())
                seen.add(capability.name)
            except Exception as e:
                logger.warning(f"Failed to generate core schema for {capability.name}: {e}")
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

        is_valid = action_name in self.capabilities or action_name in self.capabilities_by_name

        if not is_valid:
            logger.warning(
                f"Action validation failed: {action_name} not in capability graph",
                extra={
                    "session_id": self.context.session_id,
                    "action_name": action_name,
                    "available_capabilities": list(self.capabilities_by_name.keys()),
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

        return self.capabilities.get(name) or self.capabilities_by_name.get(name)

    def get_capability_id(self, name: str) -> str | None:
        """Resolve canonical capability id for a capability name or id."""
        if not self._built:
            self.build()

        capability = self.get_capability(name)
        if capability is None:
            return None
        metadata = capability.metadata if isinstance(capability.metadata, dict) else {}
        return str(metadata.get("tool_id") or "").strip() or None

    def list_capabilities(self) -> list[str]:
        """
        Get list of all capability names.

        Returns:
            List of capability names
        """
        if not self._built:
            self.build()

        return list(self.capabilities_by_name.keys())

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
            for cap in self.capabilities_by_name.values()
            if cap.capability_type == capability_type
        ]
