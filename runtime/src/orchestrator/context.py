"""Runtime session context definitions.

This module defines the RuntimeSessionContext that carries all necessary
information for a runtime execution session, including agent configuration,
available capabilities, and execution policies.
"""

from dataclasses import dataclass, field
from typing import Any


@dataclass
class NodeModelConfig:
    """Per-role model and temperature override."""

    model: str | None = None
    temperature: float | None = None


@dataclass
class ModelRoleConfig:
    """Per-role model configuration.

    Roles:
    - plan: PLAN node
    - act: ACT / RESPOND nodes and memory service (memory always uses temperature=0)
    - text_processing: text_processing builtin tool
    """

    plan: NodeModelConfig = field(default_factory=NodeModelConfig)
    act: NodeModelConfig = field(default_factory=NodeModelConfig)
    text_processing: NodeModelConfig = field(default_factory=NodeModelConfig)


def parse_node_model_config(raw: Any) -> NodeModelConfig:
    """Parse a raw dict into a NodeModelConfig.

    Accepts ``{"model": "...", "temperature": 0.2}`` or any falsy value.
    Returns an empty NodeModelConfig when input is not a dict.
    """
    if not isinstance(raw, dict):
        return NodeModelConfig()
    model = str(raw["model"]).strip() if isinstance(raw.get("model"), str) else None
    temperature = float(raw["temperature"]) if isinstance(raw.get("temperature"), (int, float)) else None
    return NodeModelConfig(model=model or None, temperature=temperature)


def parse_model_roles(raw: Any) -> ModelRoleConfig:
    """Parse a raw dict into a ModelRoleConfig.

    Accepts both camelCase (``textProcessing``) and snake_case
    (``text_processing``) for the third role key; camelCase takes precedence.
    Returns an empty ModelRoleConfig when input is not a dict.
    """
    if not isinstance(raw, dict):
        return ModelRoleConfig()
    return ModelRoleConfig(
        plan=parse_node_model_config(raw.get("plan")),
        act=parse_node_model_config(raw.get("act")),
        text_processing=parse_node_model_config(raw.get("textProcessing") or raw.get("text_processing")),
    )


@dataclass
class AgentConfig:
    """Agent configuration."""

    id: str
    name: str
    description: str | None = None
    system_prompt: str | None = None
    model: str | None = None
    temperature: float = 0.7
    model_roles: ModelRoleConfig = field(default_factory=ModelRoleConfig)
    max_tokens: int = 4096
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class SkillDefinition:
    """Skill definition with metadata."""

    id: str
    name: str
    description: str | None = None
    version: str | None = None
    source: str = "local"  # local, anthropic, custom
    schema: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class ToolDefinition:
    """Tool definition with metadata."""

    name: str
    description: str | None = None
    parameters: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class McpServerDefinition:
    """MCP server definition."""

    id: str
    name: str
    endpoint: str
    transport: str  # stdio, http, websocket
    is_connected: bool = False
    auth_config: dict[str, Any] | None = None
    available_tools: list[dict[str, Any]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class SubAgentDefinition:
    """SubAgent definition for delegation."""

    id: str
    name: str
    description: str = ""
    system_prompt: str = ""
    model: str | None = None
    temperature: float = 0.7
    max_tokens: int = 4096
    skills: list[str] = field(default_factory=list)
    mcp_servers: list[McpServerDefinition] = field(default_factory=list)


@dataclass
class RuntimePolicy:
    """Runtime execution policy."""

    max_iterations: int = 15
    max_replan_attempts: int = 3
    enable_parallel_execution: bool = True
    enable_delegation: bool = True
    require_approval_for_high_risk: bool = True
    high_risk_tools: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class RuntimeSessionContext:
    """
    Runtime session-level context.

    This context is created at the start of each runtime session and contains
    all necessary information for execution, including:
    - Session identifiers (agent_id, session_id)
    - Agent configuration
    - Available capabilities (skills, tools, MCP servers)
    - Execution policies

    `user_id` is retained as an optional compatibility field for
    legacy modules and can default to a local single-user value.
    """

    # Identifiers
    agent_id: str
    session_id: str

    # Agent configuration
    agent_config: AgentConfig

    # Compatibility identifiers (legacy modules)
    user_id: str = "local"

    # Capability inventory
    available_skills: list[SkillDefinition] = field(default_factory=list)
    available_tools: list[ToolDefinition] = field(default_factory=list)
    available_mcp_servers: list[McpServerDefinition] = field(default_factory=list)
    available_sub_agents: list[SubAgentDefinition] = field(default_factory=list)

    # Execution policy
    runtime_policy: RuntimePolicy = field(default_factory=RuntimePolicy)

    # Additional metadata
    metadata: dict[str, Any] = field(default_factory=dict)
    skill_injection_tracker: Any = None

    def get_all_capability_names(self) -> list[str]:
        """Get names of all available capabilities."""
        names = []

        # Add skill names
        names.extend(skill.name for skill in self.available_skills)

        # Add tool names
        names.extend(tool.name for tool in self.available_tools)

        # Add MCP tool names
        for mcp_server in self.available_mcp_servers:
            if mcp_server.is_connected:
                names.extend(tool.get("name") for tool in mcp_server.available_tools if tool.get("name"))

        return names

    def has_capability(self, name: str) -> bool:
        """Check if a capability is available."""
        return name in self.get_all_capability_names()

    def get_skill_by_name(self, name: str) -> SkillDefinition | None:
        """Get skill definition by name."""
        for skill in self.available_skills:
            if skill.name == name:
                return skill
        return None

    def get_tool_by_name(self, name: str) -> ToolDefinition | None:
        """Get tool definition by name."""
        for tool in self.available_tools:
            if tool.name == name:
                return tool
        return None

    def get_connected_mcp_servers(self) -> list[McpServerDefinition]:
        """Get list of connected MCP servers."""
        return [server for server in self.available_mcp_servers if server.is_connected]
