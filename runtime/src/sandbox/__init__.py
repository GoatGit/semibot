"""Sandbox Security Module - Isolated execution environment for AI Agent tools.

This module provides a Docker-based sandbox for safely executing:
- Python/JavaScript code
- Shell commands
- File operations

Example:
    ```python
    from src.sandbox import SandboxManager, SandboxConfig

    # Initialize manager
    manager = SandboxManager(pool_size=5)

    # Execute code safely
    result = await manager.execute_code(
        language="python",
        code="print('Hello from sandbox!')",
        timeout=30,
    )
    print(result.stdout)
    ```
"""

from src.sandbox.models import (
    AuditLogEntry,
    ExecutionResult,
    RiskLevel,
    SandboxConfig,
    SandboxStatus,
    ToolPermission,
    WorkspaceAccess,
)
from src.sandbox.manager import SandboxManager
from src.sandbox.policy import PolicyEngine
from src.sandbox.audit import AuditLogger
from src.sandbox.exceptions import (
    SandboxError,
    SandboxTimeoutError,
    SandboxPermissionError,
    SandboxResourceError,
    SandboxContainerError,
    SandboxPolicyViolationError,
)

__all__ = [
    # Core
    "SandboxManager",
    "PolicyEngine",
    "AuditLogger",
    # Models
    "SandboxConfig",
    "SandboxStatus",
    "ExecutionResult",
    "RiskLevel",
    "ToolPermission",
    "WorkspaceAccess",
    "AuditLogEntry",
    # Exceptions
    "SandboxError",
    "SandboxTimeoutError",
    "SandboxPermissionError",
    "SandboxResourceError",
    "SandboxContainerError",
    "SandboxPolicyViolationError",
]
