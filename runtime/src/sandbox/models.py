"""Data models for Sandbox module."""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any


class RiskLevel(Enum):
    """Tool risk levels for permission control."""

    LOW = "low"  # Read-only, no side effects
    MEDIUM = "medium"  # Limited write, controlled scope
    HIGH = "high"  # System-level, needs sandbox
    CRITICAL = "critical"  # Dangerous, needs approval


class SandboxStatus(Enum):
    """Sandbox container status."""

    IDLE = "idle"
    BUSY = "busy"
    STARTING = "starting"
    STOPPING = "stopping"
    ERROR = "error"


class WorkspaceAccess(Enum):
    """Workspace access level."""

    NONE = "none"
    READ_ONLY = "ro"
    READ_WRITE = "rw"


@dataclass
class SandboxConfig:
    """Configuration for sandbox execution."""

    # Resource limits
    max_memory_mb: int = 512
    max_cpu_cores: float = 1.0
    max_execution_time_seconds: int = 30
    max_output_size_bytes: int = 10 * 1024 * 1024  # 10MB

    # Security settings
    network_access: bool = False
    workspace_access: WorkspaceAccess = WorkspaceAccess.READ_WRITE
    allowed_domains: list[str] = field(default_factory=list)
    denied_domains: list[str] = field(default_factory=list)

    # Container settings
    docker_image: str = "semibot/sandbox:latest"
    user: str = "sandbox"
    working_dir: str = "/workspace"

    # Seccomp profile
    seccomp_profile: str | None = None


@dataclass
class ToolPermission:
    """Permission settings for a specific tool."""

    tool_name: str
    risk_level: RiskLevel = RiskLevel.MEDIUM
    sandbox_enabled: bool = True
    allowed_commands: list[str] = field(default_factory=list)
    denied_commands: list[str] = field(default_factory=list)
    allowed_paths: list[str] = field(default_factory=list)
    denied_paths: list[str] = field(default_factory=list)
    max_execution_time_seconds: int = 30
    requires_approval: bool = False


@dataclass
class ExecutionResult:
    """Result of sandbox execution."""

    success: bool
    exit_code: int
    stdout: str
    stderr: str
    execution_time_ms: int
    memory_used_mb: float = 0.0
    cpu_time_ms: int = 0
    files_created: list[str] = field(default_factory=list)
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "success": self.success,
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "execution_time_ms": self.execution_time_ms,
            "memory_used_mb": self.memory_used_mb,
            "cpu_time_ms": self.cpu_time_ms,
            "files_created": self.files_created,
            "error": self.error,
        }


@dataclass
class AuditLogEntry:
    """Audit log entry for sandbox execution."""

    timestamp: datetime
    event_type: str
    session_id: str
    agent_id: str
    org_id: str
    sandbox_id: str
    tool: str
    language: str | None = None
    code_hash: str | None = None
    command: str | None = None
    execution_time_ms: int = 0
    exit_code: int = 0
    memory_used_mb: float = 0.0
    cpu_time_ms: int = 0
    network_bytes_sent: int = 0
    network_bytes_recv: int = 0
    files_read: list[str] = field(default_factory=list)
    files_written: list[str] = field(default_factory=list)
    result: str = "success"
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for logging."""
        return {
            "timestamp": self.timestamp.isoformat(),
            "event_type": self.event_type,
            "session_id": self.session_id,
            "agent_id": self.agent_id,
            "org_id": self.org_id,
            "sandbox_id": self.sandbox_id,
            "tool": self.tool,
            "language": self.language,
            "code_hash": self.code_hash,
            "command": self.command,
            "execution_time_ms": self.execution_time_ms,
            "exit_code": self.exit_code,
            "memory_used_mb": self.memory_used_mb,
            "cpu_time_ms": self.cpu_time_ms,
            "network_bytes_sent": self.network_bytes_sent,
            "network_bytes_recv": self.network_bytes_recv,
            "files_read": self.files_read,
            "files_written": self.files_written,
            "result": self.result,
            "error": self.error,
        }
