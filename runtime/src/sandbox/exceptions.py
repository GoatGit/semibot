"""Exception classes for Sandbox module."""


class SandboxError(Exception):
    """Base exception for sandbox errors."""

    def __init__(self, message: str, details: dict | None = None):
        super().__init__(message)
        self.message = message
        self.details = details or {}


class SandboxTimeoutError(SandboxError):
    """Raised when sandbox execution times out."""

    def __init__(self, timeout_seconds: int, message: str | None = None):
        msg = message or f"Sandbox execution timed out after {timeout_seconds}s"
        super().__init__(msg, {"timeout_seconds": timeout_seconds})
        self.timeout_seconds = timeout_seconds


class SandboxPermissionError(SandboxError):
    """Raised when sandbox permission is denied."""

    def __init__(self, tool: str, reason: str):
        msg = f"Permission denied for tool '{tool}': {reason}"
        super().__init__(msg, {"tool": tool, "reason": reason})
        self.tool = tool
        self.reason = reason


class SandboxResourceError(SandboxError):
    """Raised when sandbox resource limits are exceeded."""

    def __init__(self, resource: str, limit: str, actual: str):
        msg = f"Resource limit exceeded: {resource} (limit: {limit}, actual: {actual})"
        super().__init__(msg, {"resource": resource, "limit": limit, "actual": actual})
        self.resource = resource
        self.limit = limit
        self.actual = actual


class SandboxContainerError(SandboxError):
    """Raised when container operations fail."""

    def __init__(self, operation: str, container_id: str | None, reason: str):
        msg = f"Container {operation} failed: {reason}"
        super().__init__(
            msg,
            {"operation": operation, "container_id": container_id, "reason": reason},
        )
        self.operation = operation
        self.container_id = container_id
        self.reason = reason


class SandboxPolicyViolationError(SandboxError):
    """Raised when execution violates security policy."""

    def __init__(self, violation_type: str, details: str):
        msg = f"Policy violation ({violation_type}): {details}"
        super().__init__(msg, {"violation_type": violation_type, "details": details})
        self.violation_type = violation_type
