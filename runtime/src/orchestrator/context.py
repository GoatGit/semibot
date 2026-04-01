"""Runtime session context definitions.

This module defines the RuntimeSessionContext that carries all necessary
information for a runtime execution session, including agent configuration,
available capabilities, and execution policies.
"""

from dataclasses import dataclass, field
from typing import Any, TypedDict


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
class ToolCatalogEntry:
    """Unified tool catalog entry for planner/act injection."""

    tool_id: str
    tool_name: str
    actual_tool_name: str
    display_name: str
    description: str | None = None
    source_type: str = "builtin"
    provider_id: str | None = None
    parameters: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_tool_schema(self) -> dict[str, Any]:
        schema = {
            "type": "function",
            "function": {
                "name": self.tool_name,
                "description": self.description or f"Execute {self.display_name}",
            },
            "metadata": {
                "tool_id": self.tool_id,
                "source_type": self.source_type,
                **dict(self.metadata or {}),
            },
        }
        if self.parameters:
            schema["function"]["parameters"] = self.parameters
        return schema

    def to_dict(self) -> dict[str, Any]:
        return {
            "toolId": self.tool_id,
            "toolName": self.tool_name,
            "actualToolName": self.actual_tool_name,
            "displayName": self.display_name,
            "description": self.description or "",
            "sourceType": self.source_type,
            "providerId": self.provider_id,
            "parameters": dict(self.parameters or {}),
            "metadata": dict(self.metadata or {}),
        }

    def to_catalog_card(self) -> dict[str, Any]:
        return {
            "toolId": self.tool_id,
            "toolName": self.tool_name,
            "displayName": self.display_name,
            "sourceType": self.source_type,
            "providerId": self.provider_id,
            "summary": self.description or "",
            "metadata": dict(self.metadata or {}),
        }


@dataclass
class CapabilityDescriptor:
    """Canonical executable capability descriptor."""

    id: str
    kind: str
    name: str
    display_name: str
    description: str = ""
    org_id: str | None = None
    source: dict[str, Any] = field(default_factory=dict)
    input_schema: dict[str, Any] = field(default_factory=dict)
    output_schema: dict[str, Any] = field(default_factory=dict)
    risk_level: str = "low"
    requires_approval: bool = False
    approval_policy_key: str | None = None
    visibility: dict[str, bool] = field(
        default_factory=lambda: {
            "planner": True,
            "executor": True,
            "audit": True,
        }
    )
    constraints: dict[str, Any] = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class SkillContextBinding:
    """Skill context binding for planner and runtime skill injection."""

    skill_id: str
    skill_definition_id: str | None = None
    skill_package_id: str | None = None
    description: str | None = None
    has_skill_md: bool = False
    script_files: list[str] = field(default_factory=list)
    package_files: list[str] = field(default_factory=list)
    selected_by_planner: bool | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class RuntimeActionRequest:
    """Structured runtime action request."""

    action_id: str
    step_id: str
    capability_id: str
    capability_name: str
    arguments: dict[str, Any] = field(default_factory=dict)
    requested_by: "RuntimeActionRequester" = field(
        default_factory=lambda: {
            "session_id": "",
            "agent_id": "",
            "user_id": "",
        }
    )


@dataclass
class RuntimeActionResult:
    """Structured runtime action result."""

    action_id: str
    capability_id: str
    status: str
    output: dict[str, Any] = field(default_factory=dict)
    error: dict[str, Any] = field(default_factory=dict)
    usage: dict[str, Any] = field(default_factory=dict)
    started_at: str | None = None
    finished_at: str | None = None
    duration_ms: int | None = None


class RuntimeActionRequester(TypedDict):
    """Canonical action requester identity."""

    session_id: str
    agent_id: str
    user_id: str


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
    tool_catalog: list[ToolCatalogEntry] = field(default_factory=list)
    available_sub_agents: list[SubAgentDefinition] = field(default_factory=list)
    capabilities: list[CapabilityDescriptor] = field(default_factory=list)
    skill_context: list[SkillContextBinding] = field(default_factory=list)

    # Execution policy
    runtime_policy: RuntimePolicy = field(default_factory=RuntimePolicy)

    # Additional metadata
    metadata: dict[str, Any] = field(default_factory=dict)
    skill_injection_tracker: Any = None

    def __post_init__(self) -> None:
        raw_capabilities = list(self.capabilities or [])
        raw_skill_context = list(self.skill_context or [])
        self._explicit_capabilities_provided = bool(raw_capabilities)
        self._explicit_skill_context_provided = bool(raw_skill_context)
        self.capabilities = [self._coerce_capability_descriptor(item) for item in raw_capabilities if item]
        self.skill_context = [self._coerce_skill_context_binding(item) for item in raw_skill_context if item]
        if not self.skill_context and self.available_skills:
            self.skill_context = self._derive_skill_context()
        if not self.capabilities:
            self.capabilities = self._derive_capabilities()

    def get_all_capability_names(self) -> list[str]:
        """Get names of executable capabilities available in this session."""
        names: list[str] = []
        seen: set[str] = set()

        for descriptor in self.get_capability_descriptors():
            name = str(descriptor.name or "").strip()
            if name and name not in seen:
                seen.add(name)
                names.append(name)

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

    def get_tool_catalog(self) -> list[ToolCatalogEntry]:
        """Return the unified tool catalog built from the current runtime state."""
        from src.orchestrator.tool_catalog import build_runtime_tool_catalog

        self.tool_catalog = build_runtime_tool_catalog(self)
        return list(self.tool_catalog)

    def get_capability_descriptors(self) -> list[CapabilityDescriptor]:
        """Return canonical executable capability descriptors for the session."""
        if not getattr(self, "_explicit_capabilities_provided", False):
            self.capabilities = self._derive_capabilities()
        return list(self.capabilities)

    def get_tool_catalog_entry(self, key: str) -> ToolCatalogEntry | None:
        """Get a catalog entry by tool_id or tool_name."""
        key_text = str(key or "").strip()
        if not key_text:
            return None
        for tool in self.get_tool_catalog():
            if tool.tool_id == key_text or tool.tool_name == key_text:
                return tool
        return None

    def get_connected_mcp_servers(self) -> list[McpServerDefinition]:
        """Get list of connected MCP servers."""
        return [server for server in self.available_mcp_servers if server.is_connected]

    def get_sub_agent_summaries(self) -> list[dict[str, Any]]:
        """Return planner/route friendly sub-agent summaries, preferring capabilities."""
        summaries: list[dict[str, Any]] = []
        seen_ids: set[str] = set()

        for descriptor in self.get_capability_descriptors():
            if str(descriptor.kind or "").strip() != "sub_agent":
                continue
            agent_id = str(
                descriptor.metadata.get("sub_agent_id")
                or descriptor.source.get("agentId")
                or descriptor.id.removeprefix("agent:")
            ).strip()
            name = str(descriptor.display_name or descriptor.name or agent_id).strip()
            description = str(descriptor.description or "").strip()
            if not agent_id or agent_id in seen_ids:
                continue
            seen_ids.add(agent_id)
            summaries.append({"id": agent_id, "name": name, "description": description})

        for item in self.available_sub_agents:
            agent_id = str(getattr(item, "id", "") or "").strip()
            name = str(getattr(item, "name", "") or "").strip()
            description = str(getattr(item, "description", "") or "").strip()
            if not agent_id or agent_id in seen_ids:
                continue
            seen_ids.add(agent_id)
            summaries.append({"id": agent_id, "name": name or agent_id, "description": description})

        return summaries

    def get_sub_agent_summary(self, agent_id: str) -> dict[str, Any] | None:
        """Return a planner-friendly sub-agent summary by id."""
        target = str(agent_id or "").strip()
        if not target:
            return None
        for item in self.get_sub_agent_summaries():
            if str(item.get("id") or "").strip() == target:
                return item
        return None

    def get_sub_agent_definition(self, agent_id: str) -> SubAgentDefinition | None:
        """Return a concrete sub-agent definition, deriving from capabilities when needed."""
        target = str(agent_id or "").strip()
        if not target:
            return None
        for item in self.available_sub_agents:
            if str(getattr(item, "id", "") or "").strip() == target:
                return item
        descriptor = self.get_sub_agent_capability(target)
        if descriptor is None:
            return None
        return self._sub_agent_definition_from_descriptor(descriptor)
        return None

    def has_sub_agent(self, agent_id: str) -> bool:
        """Check whether the session exposes a given sub-agent capability."""
        target = str(agent_id or "").strip()
        if not target:
            return False
        if self.get_sub_agent_definition(target) is not None:
            return True
        return any(str(item.get("id") or "").strip() == target for item in self.get_sub_agent_summaries())

    def get_sub_agent_capability(self, agent_id: str) -> CapabilityDescriptor | None:
        """Return the canonical sub-agent capability descriptor by id."""
        target = str(agent_id or "").strip()
        if not target:
            return None
        for descriptor in self.get_capability_descriptors():
            if str(descriptor.kind or "").strip() != "sub_agent":
                continue
            descriptor_agent_id = str(
                descriptor.metadata.get("sub_agent_id")
                or descriptor.source.get("agentId")
                or descriptor.id.removeprefix("agent:")
            ).strip()
            if descriptor_agent_id == target:
                return descriptor
        return None

    def _coerce_capability_descriptor(self, value: Any) -> CapabilityDescriptor:
        if isinstance(value, CapabilityDescriptor):
            return value
        if not isinstance(value, dict):
            raise TypeError(f"Unsupported capability descriptor: {type(value)!r}")
        return CapabilityDescriptor(
            id=str(value.get("id") or "").strip(),
            kind=str(value.get("kind") or "tool").strip() or "tool",
            name=str(value.get("name") or "").strip(),
            display_name=str(value.get("displayName") or value.get("display_name") or value.get("name") or "").strip(),
            description=str(value.get("description") or "").strip(),
            org_id=str(value.get("orgId") or value.get("org_id") or "").strip() or None,
            source=dict(value.get("source") or {}),
            input_schema=dict(value.get("inputSchema") or value.get("input_schema") or {}),
            output_schema=dict(value.get("outputSchema") or value.get("output_schema") or {}),
            risk_level=str(value.get("riskLevel") or value.get("risk_level") or "low").strip() or "low",
            requires_approval=bool(value.get("requiresApproval") if "requiresApproval" in value else value.get("requires_approval")),
            approval_policy_key=str(value.get("approvalPolicyKey") or value.get("approval_policy_key") or "").strip() or None,
            visibility=dict(value.get("visibility") or {}) or {"planner": True, "executor": True, "audit": True},
            constraints=dict(value.get("constraints") or {}),
            tags=[str(tag) for tag in (value.get("tags") or []) if str(tag).strip()],
            metadata=dict(value.get("metadata") or {}),
        )

    def _coerce_skill_context_binding(self, value: Any) -> SkillContextBinding:
        if isinstance(value, SkillContextBinding):
            return value
        if not isinstance(value, dict):
            raise TypeError(f"Unsupported skill context binding: {type(value)!r}")
        return SkillContextBinding(
            skill_id=str(value.get("skillId") or value.get("skill_id") or "").strip(),
            skill_definition_id=str(value.get("skillDefinitionId") or value.get("skill_definition_id") or "").strip() or None,
            skill_package_id=str(value.get("skillPackageId") or value.get("skill_package_id") or "").strip() or None,
            description=str(value.get("description") or "").strip() or None,
            has_skill_md=bool(value.get("hasSkillMd") if "hasSkillMd" in value else value.get("has_skill_md")),
            script_files=[str(item) for item in (value.get("scriptFiles") or value.get("script_files") or []) if str(item).strip()],
            package_files=[str(item) for item in (value.get("packageFiles") or value.get("package_files") or []) if str(item).strip()],
            selected_by_planner=(
                bool(value.get("selectedByPlanner"))
                if "selectedByPlanner" in value
                else (bool(value.get("selected_by_planner")) if "selected_by_planner" in value else None)
            ),
            metadata=dict(value.get("metadata") or {}),
        )

    def _sub_agent_definition_from_descriptor(self, descriptor: CapabilityDescriptor) -> SubAgentDefinition:
        metadata = dict(descriptor.metadata or {})
        source = dict(descriptor.source or {})

        raw_mcp_servers = (
            metadata.get("mcp_servers")
            or metadata.get("mcpServers")
            or source.get("mcp_servers")
            or source.get("mcpServers")
            or []
        )
        mcp_servers: list[McpServerDefinition] = []
        for item in raw_mcp_servers:
            if isinstance(item, McpServerDefinition):
                mcp_servers.append(item)
                continue
            if not isinstance(item, dict):
                continue
            mcp_servers.append(
                McpServerDefinition(
                    id=str(item.get("id") or "").strip(),
                    name=str(item.get("name") or "").strip(),
                    endpoint=str(item.get("endpoint") or "").strip(),
                    transport=str(item.get("transport") or "stdio").strip() or "stdio",
                    is_connected=bool(item.get("is_connected") if "is_connected" in item else item.get("isConnected")),
                    auth_config=item.get("auth_config") if isinstance(item.get("auth_config"), dict) else item.get("authConfig"),
                    available_tools=list(item.get("available_tools") or item.get("availableTools") or []),
                    metadata=dict(item.get("metadata") or {}),
                )
            )

        raw_temperature = metadata.get("temperature", 0.7)
        try:
            temperature = float(raw_temperature)
        except Exception:
            temperature = 0.7

        raw_max_tokens = metadata.get("max_tokens") or metadata.get("maxTokens") or 4096
        try:
            max_tokens = int(raw_max_tokens)
        except Exception:
            max_tokens = 4096

        return SubAgentDefinition(
            id=str(metadata.get("sub_agent_id") or source.get("agentId") or descriptor.id.removeprefix("agent:") or "").strip(),
            name=str(descriptor.display_name or descriptor.name or metadata.get("sub_agent_id") or "").strip(),
            description=str(descriptor.description or "").strip(),
            system_prompt=str(metadata.get("system_prompt") or metadata.get("systemPrompt") or "").strip(),
            model=str(metadata.get("model") or "").strip() or None,
            temperature=temperature,
            max_tokens=max_tokens,
            skills=[str(item) for item in (metadata.get("skills") or []) if str(item).strip()],
            mcp_servers=mcp_servers,
        )

    def _derive_skill_context(self) -> list[SkillContextBinding]:
        bindings: list[SkillContextBinding] = []
        for skill in self.available_skills:
            metadata = dict(skill.metadata or {})
            bindings.append(
                SkillContextBinding(
                    skill_id=skill.name,
                    skill_definition_id=skill.id,
                    skill_package_id=str(metadata.get("package_id") or "").strip() or None,
                    description=skill.description,
                    has_skill_md=bool(metadata.get("has_skill_md") or metadata.get("hasSkillMd") or False),
                    script_files=[str(item) for item in (metadata.get("script_files") or metadata.get("scriptFiles") or []) if str(item).strip()],
                    package_files=[str(item) for item in (metadata.get("package_files") or metadata.get("packageFiles") or []) if str(item).strip()],
                    metadata=metadata,
                )
            )
        return bindings

    def _derive_capabilities(self) -> list[CapabilityDescriptor]:
        descriptors: list[CapabilityDescriptor] = []
        from src.orchestrator.tool_catalog import expand_catalog_entry_for_llm

        for entry in self.get_tool_catalog():
            entry_variants = [entry, *expand_catalog_entry_for_llm(entry)]
            seen_variant_ids: set[str] = set()
            for variant in entry_variants:
                if variant.tool_id in seen_variant_ids:
                    continue
                seen_variant_ids.add(variant.tool_id)
                metadata = {
                    "tool_id": variant.tool_id,
                    "actual_tool_name": variant.actual_tool_name,
                    "display_name": variant.display_name,
                    **dict(variant.metadata or {}),
                }
                source_type = str(variant.source_type or "builtin").strip() or "builtin"
                source: dict[str, Any]
                if source_type == "mcp":
                    source = {
                        "type": "mcp",
                        "serverId": str(metadata.get("mcp_server_id") or variant.provider_id or ""),
                        "serverName": str(metadata.get("mcp_server_name") or variant.provider_id or ""),
                        "toolName": variant.actual_tool_name,
                    }
                elif source_type == "cli":
                    source = {
                        "type": "cli",
                        "providerId": str(variant.provider_id or ""),
                        "packageId": str(metadata.get("package_id") or "").strip() or None,
                        "actualToolName": variant.actual_tool_name,
                    }
                else:
                    source = {
                        "type": "builtin",
                        "key": variant.actual_tool_name,
                    }
                descriptors.append(
                    CapabilityDescriptor(
                        id=variant.tool_id,
                        kind="tool",
                        name=variant.tool_name,
                        display_name=variant.display_name,
                        description=variant.description or "",
                        org_id=(
                            str(self.metadata.get("org_id") or self.metadata.get("orgId") or "").strip() or None
                            if isinstance(self.metadata, dict)
                            else None
                        ),
                        source=source,
                        input_schema=dict(variant.parameters or {}),
                        risk_level=str(
                            metadata.get("risk_level")
                            or metadata.get("riskLevel")
                            or "low"
                        ).strip()
                        or "low",
                        requires_approval=bool(
                            metadata.get("requires_approval")
                            if "requires_approval" in metadata
                            else metadata.get("requiresApproval", False)
                        ),
                        approval_policy_key=str(
                            metadata.get("approval_policy_key") or metadata.get("approvalPolicyKey") or ""
                        ).strip()
                        or None,
                        constraints={
                            key: value
                            for key, value in {
                                "timeoutMs": metadata.get("timeout_ms") or metadata.get("timeoutMs"),
                                "maxRetries": metadata.get("max_retries") or metadata.get("maxRetries"),
                                "concurrencyKey": metadata.get("concurrency_key") or metadata.get("concurrencyKey"),
                                "sideEffectLevel": metadata.get("side_effect_level") or metadata.get("sideEffectLevel"),
                            }.items()
                            if value is not None
                        },
                        metadata=metadata,
                    )
                )
        for sub_agent in self.available_sub_agents:
            sub_agent_id = str(getattr(sub_agent, "id", "") or "").strip()
            if not sub_agent_id:
                continue
            descriptors.append(
                CapabilityDescriptor(
                    id=f"agent:{sub_agent_id}",
                    kind="sub_agent",
                    name=f"subagent:{sub_agent_id}",
                    display_name=str(getattr(sub_agent, "name", "") or sub_agent_id),
                    description=str(getattr(sub_agent, "description", "") or ""),
                    org_id=(
                        str(self.metadata.get("org_id") or self.metadata.get("orgId") or "").strip() or None
                        if isinstance(self.metadata, dict)
                        else None
                    ),
                    source={"type": "agent", "agentId": sub_agent_id},
                    risk_level="medium",
                    requires_approval=False,
                    constraints={
                        "timeoutMs": 120_000,
                    },
                    metadata={
                        "sub_agent_id": sub_agent_id,
                        "skills": list(getattr(sub_agent, "skills", []) or []),
                    },
                )
            )
        return descriptors
