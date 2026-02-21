"""Pydantic request/response models for the runtime HTTP server.

This module is kept for the standalone runtime HTTP mode used in tests
and local diagnostics.
"""

from typing import Any

from pydantic import BaseModel, Field


class HistoryMessage(BaseModel):
    """A single history message."""

    role: str = Field(..., pattern="^(user|assistant|system)$")
    content: str


class AgentConfigInput(BaseModel):
    """Agent configuration from the API layer."""

    system_prompt: str | None = None
    model: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None


class McpToolInput(BaseModel):
    """A single MCP tool definition."""

    name: str
    description: str = ""
    parameters: dict[str, Any] = Field(default_factory=dict)


class McpServerInput(BaseModel):
    """MCP server definition from the API layer."""

    id: str
    name: str
    endpoint: str
    transport: str
    is_connected: bool = False
    auth_config: dict[str, Any] | None = None
    available_tools: list[McpToolInput] = Field(default_factory=list)


class SubAgentInput(BaseModel):
    """SubAgent configuration from the API layer."""

    id: str
    name: str
    description: str = ""
    system_prompt: str = ""
    model: str | None = None
    temperature: float = 0.7
    max_tokens: int = 4096
    skills: list[str] = Field(default_factory=list)
    mcp_servers: list[McpServerInput] = Field(default_factory=list)


class RuntimeInputState(BaseModel):
    """Input payload for POST /api/v1/execute/stream.
    """

    session_id: str = Field(..., min_length=1)
    agent_id: str = Field(..., min_length=1)
    org_id: str = Field(..., min_length=1)
    user_message: str = Field(..., min_length=1)
    history_messages: list[HistoryMessage] | None = None
    agent_config: AgentConfigInput | None = None
    available_mcp_servers: list[McpServerInput] | None = None
    available_sub_agents: list[SubAgentInput] | None = None
    metadata: dict | None = None


class MemoryHealthStatus(BaseModel):
    """Memory subsystem health status."""

    short_term: bool | None = None
    long_term: bool | None = None


class HealthResponse(BaseModel):
    """Response for GET /health."""

    status: str = "healthy"
    memory: MemoryHealthStatus | None = None


class RuntimeSSEEvent(BaseModel):
    """A single SSE event emitted during execution."""

    event: str
    data: dict
    timestamp: str
