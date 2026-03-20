"""Audit event models and types."""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any


class AuditEventType(str, Enum):
    """Audit event types."""

    # Action execution events
    ACTION_STARTED = "action_started"
    ACTION_COMPLETED = "action_completed"
    ACTION_FAILED = "action_failed"
    ACTION_REJECTED = "action_rejected"  # Rejected by approval hook

    # Capability events
    CAPABILITY_VALIDATED = "capability_validated"
    CAPABILITY_VALIDATION_FAILED = "capability_validation_failed"

    # Approval events
    APPROVAL_REQUESTED = "approval_requested"
    APPROVAL_GRANTED = "approval_granted"
    APPROVAL_DENIED = "approval_denied"

    # MCP events
    MCP_CONNECTED = "mcp_connected"
    MCP_DISCONNECTED = "mcp_disconnected"
    MCP_CALL_STARTED = "mcp_call_started"
    MCP_CALL_COMPLETED = "mcp_call_completed"
    MCP_CALL_FAILED = "mcp_call_failed"

    # Session events
    SESSION_STARTED = "session_started"
    SESSION_ENDED = "session_ended"

    # Error events
    ERROR = "error"


class AuditSeverity(str, Enum):
    """Audit event severity levels."""

    DEBUG = "debug"
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


@dataclass
class AuditEvent:
    """
    Audit event record.

    This represents a single auditable event in the runtime system.
    All events are immutable once created.
    """

    # Event identification
    event_id: str
    event_type: AuditEventType
    timestamp: datetime

    # Context
    org_id: str
    user_id: str
    agent_id: str
    session_id: str

    # Event details
    severity: AuditSeverity = AuditSeverity.INFO
    message: str = ""

    # Action details (if applicable)
    action_id: str | None = None
    action_name: str | None = None
    action_params: dict[str, Any] = field(default_factory=dict)

    # Execution details
    capability_type: str | None = None  # "skill", "tool", "mcp"
    capability_source: str | None = None  # "local", "anthropic", "custom", "builtin"
    capability_version: str | None = None

    # MCP details (if applicable)
    mcp_server_id: str | None = None
    mcp_server_name: str | None = None

    # Result details
    success: bool | None = None
    error_message: str | None = None
    duration_ms: int | None = None

    # Approval details (if applicable)
    requires_approval: bool = False
    approval_granted: bool | None = None

    # Additional metadata
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Convert audit event to dictionary."""
        return {
            "event_id": self.event_id,
            "event_type": self.event_type.value,
            "timestamp": self.timestamp.isoformat(),
            "org_id": self.org_id,
            "user_id": self.user_id,
            "agent_id": self.agent_id,
            "session_id": self.session_id,
            "severity": self.severity.value,
            "message": self.message,
            "action_id": self.action_id,
            "action_name": self.action_name,
            "action_params": self.action_params,
            "capability_type": self.capability_type,
            "capability_source": self.capability_source,
            "capability_version": self.capability_version,
            "mcp_server_id": self.mcp_server_id,
            "mcp_server_name": self.mcp_server_name,
            "success": self.success,
            "error_message": self.error_message,
            "duration_ms": self.duration_ms,
            "requires_approval": self.requires_approval,
            "approval_granted": self.approval_granted,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AuditEvent":
        """Create audit event from dictionary."""
        return cls(
            event_id=data["event_id"],
            event_type=AuditEventType(data["event_type"]),
            timestamp=datetime.fromisoformat(data["timestamp"]),
            org_id=data["org_id"],
            user_id=data["user_id"],
            agent_id=data["agent_id"],
            session_id=data["session_id"],
            severity=AuditSeverity(data.get("severity", "info")),
            message=data.get("message", ""),
            action_id=data.get("action_id"),
            action_name=data.get("action_name"),
            action_params=data.get("action_params", {}),
            capability_type=data.get("capability_type"),
            capability_source=data.get("capability_source"),
            capability_version=data.get("capability_version"),
            mcp_server_id=data.get("mcp_server_id"),
            mcp_server_name=data.get("mcp_server_name"),
            success=data.get("success"),
            error_message=data.get("error_message"),
            duration_ms=data.get("duration_ms"),
            requires_approval=data.get("requires_approval", False),
            approval_granted=data.get("approval_granted"),
            metadata=data.get("metadata", {}),
        )


@dataclass
class AuditQuery:
    """Query parameters for searching audit events."""

    org_id: str | None = None
    user_id: str | None = None
    agent_id: str | None = None
    session_id: str | None = None
    event_types: list[AuditEventType] = field(default_factory=list)
    severity: AuditSeverity | None = None
    start_time: datetime | None = None
    end_time: datetime | None = None
    action_name: str | None = None
    success: bool | None = None
    limit: int = 100
    offset: int = 0
