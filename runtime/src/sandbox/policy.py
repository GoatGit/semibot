"""Policy Engine - Permission and security policy management."""

import fnmatch
import hashlib
import re
from pathlib import Path
from typing import Any

import yaml

from src.sandbox.models import RiskLevel, SandboxConfig, ToolPermission
from src.sandbox.exceptions import SandboxPermissionError, SandboxPolicyViolationError
from src.utils.logging import get_logger

logger = get_logger(__name__)


class PolicyEngine:
    """
    Security policy engine for sandbox execution.

    Manages tool permissions, command whitelists/blacklists,
    path access control, and risk-based execution policies.

    Example:
        ```python
        policy = PolicyEngine(policy_file="sandbox_policy.yaml")

        # Check permission
        if policy.check_permission("shell_exec", command="ls -la"):
            # Execute in sandbox
            pass

        # Get tool config
        config = policy.get_sandbox_config("code_run")
        ```
    """

    # Default dangerous commands (always blocked)
    BLOCKED_COMMANDS = [
        "rm -rf /",
        "rm -rf /*",
        ":(){ :|:& };:",  # Fork bomb
        "mkfs",
        "dd if=/dev/zero",
        "chmod -R 777 /",
        "> /dev/sda",
    ]

    # Default dangerous patterns
    BLOCKED_PATTERNS = [
        r"sudo\s+",
        r"su\s+-",
        r"curl\s+.*\|\s*sh",
        r"wget\s+.*\|\s*sh",
        r"nc\s+-e",
        r"bash\s+-i",
        r"/dev/tcp/",
        r"eval\s*\(",
        r"exec\s*\(",
    ]

    def __init__(
        self,
        policy_file: str | None = None,
        default_config: SandboxConfig | None = None,
    ):
        """
        Initialize PolicyEngine.

        Args:
            policy_file: Path to YAML policy configuration file
            default_config: Default sandbox configuration
        """
        self.default_config = default_config or SandboxConfig()
        self.tool_permissions: dict[str, ToolPermission] = {}
        self.agent_role_policies: dict[str, dict] = {}

        if policy_file:
            self._load_policy_file(policy_file)
        else:
            self._apply_default_policies()

    def _load_policy_file(self, policy_file: str) -> None:
        """Load policy from YAML file."""
        try:
            with open(policy_file, "r") as f:
                policy_data = yaml.safe_load(f)

            # Load default config
            if "default" in policy_data.get("policies", {}):
                default = policy_data["policies"]["default"]
                self.default_config = SandboxConfig(
                    max_memory_mb=self._parse_memory(default.get("max_memory", "512MB")),
                    max_execution_time_seconds=self._parse_time(
                        default.get("max_execution_time", "30s")
                    ),
                    max_cpu_cores=float(default.get("max_cpu", 1.0)),
                    network_access=default.get("network_access", False),
                )

            # Load tool permissions
            for tool_name, tool_config in policy_data.get("policies", {}).get(
                "tools", {}
            ).items():
                self.tool_permissions[tool_name] = ToolPermission(
                    tool_name=tool_name,
                    risk_level=RiskLevel(tool_config.get("risk_level", "medium")),
                    sandbox_enabled=tool_config.get("sandbox_enabled", True),
                    allowed_commands=tool_config.get("allowed_commands", []),
                    denied_commands=tool_config.get("denied_commands", []),
                    allowed_paths=tool_config.get("allowed_paths", []),
                    denied_paths=tool_config.get("denied_paths", []),
                    max_execution_time_seconds=self._parse_time(
                        tool_config.get("max_execution_time", "30s")
                    ),
                    requires_approval=tool_config.get("requires_approval", False),
                )

            # Load agent role policies
            self.agent_role_policies = policy_data.get("policies", {}).get(
                "agent_roles", {}
            )

            logger.info(f"Loaded policy from {policy_file}")

        except FileNotFoundError:
            logger.warning(f"Policy file not found: {policy_file}, using defaults")
            self._apply_default_policies()
        except yaml.YAMLError as e:
            logger.error(f"Failed to parse policy file: {e}")
            self._apply_default_policies()

    def _apply_default_policies(self) -> None:
        """Apply default security policies."""
        # File read - low risk
        self.tool_permissions["file_read"] = ToolPermission(
            tool_name="file_read",
            risk_level=RiskLevel.LOW,
            sandbox_enabled=False,
            allowed_paths=["/workspace/**"],
            denied_paths=["/workspace/.env", "/workspace/**/*.key", "/workspace/**/*.pem"],
        )

        # File write - medium risk
        self.tool_permissions["file_write"] = ToolPermission(
            tool_name="file_write",
            risk_level=RiskLevel.MEDIUM,
            sandbox_enabled=True,
            allowed_paths=["/workspace/**"],
            denied_paths=["/workspace/.env"],
        )

        # Shell exec - high risk
        self.tool_permissions["shell_exec"] = ToolPermission(
            tool_name="shell_exec",
            risk_level=RiskLevel.HIGH,
            sandbox_enabled=True,
            allowed_commands=["ls", "cat", "grep", "find", "head", "tail", "wc", "sort"],
            denied_commands=["rm -rf", "sudo", "su", "curl", "wget", "nc", "ssh"],
            max_execution_time_seconds=60,
        )

        # Code run - high risk
        self.tool_permissions["code_run"] = ToolPermission(
            tool_name="code_run",
            risk_level=RiskLevel.HIGH,
            sandbox_enabled=True,
            max_execution_time_seconds=120,
        )

        # Browser automation - high risk
        self.tool_permissions["browser_automation"] = ToolPermission(
            tool_name="browser_automation",
            risk_level=RiskLevel.HIGH,
            sandbox_enabled=True,
            max_execution_time_seconds=300,
        )

    def _parse_memory(self, value: str) -> int:
        """Parse memory string (e.g., '512MB') to megabytes."""
        value = value.upper().strip()
        if value.endswith("GB"):
            return int(float(value[:-2]) * 1024)
        elif value.endswith("MB"):
            return int(float(value[:-2]))
        elif value.endswith("KB"):
            return int(float(value[:-2]) / 1024)
        else:
            return int(value)

    def _parse_time(self, value: str) -> int:
        """Parse time string (e.g., '30s', '5m') to seconds."""
        value = value.lower().strip()
        if value.endswith("m"):
            return int(float(value[:-1]) * 60)
        elif value.endswith("s"):
            return int(float(value[:-1]))
        elif value.endswith("h"):
            return int(float(value[:-1]) * 3600)
        else:
            return int(value)

    def check_permission(
        self,
        tool_name: str,
        command: str | None = None,
        path: str | None = None,
        code: str | None = None,
        agent_role: str | None = None,
    ) -> bool:
        """
        Check if execution is permitted.

        Args:
            tool_name: Name of the tool to execute
            command: Shell command (for shell_exec)
            path: File path (for file operations)
            code: Code to execute (for code_run)
            agent_role: Agent role for role-based policies

        Returns:
            True if permitted, raises exception if denied

        Raises:
            SandboxPermissionError: If permission is denied
            SandboxPolicyViolationError: If policy is violated
        """
        permission = self.tool_permissions.get(tool_name)

        # Check if tool is allowed for agent role
        if agent_role and agent_role in self.agent_role_policies:
            role_tools = self.agent_role_policies[agent_role].get("tools", [])
            if tool_name not in role_tools:
                raise SandboxPermissionError(
                    tool_name, f"Tool not allowed for role '{agent_role}'"
                )

        if not permission:
            # Unknown tool - apply default high-risk policy
            logger.warning(f"Unknown tool '{tool_name}', applying high-risk policy")
            return True

        # Check if approval is required
        if permission.requires_approval:
            raise SandboxPermissionError(
                tool_name, "This action requires manual approval"
            )

        # Check command whitelist/blacklist
        if command:
            self._check_command(tool_name, command, permission)

        # Check path access
        if path:
            self._check_path(tool_name, path, permission)

        # Check code for dangerous patterns
        if code:
            self._check_code(tool_name, code)

        return True

    def _check_command(
        self, tool_name: str, command: str, permission: ToolPermission
    ) -> None:
        """Check if command is allowed."""
        command_lower = command.lower().strip()

        # Check blocked commands
        for blocked in self.BLOCKED_COMMANDS:
            if blocked.lower() in command_lower:
                raise SandboxPolicyViolationError(
                    "blocked_command", f"Command contains blocked pattern: {blocked}"
                )

        # Check blocked patterns
        for pattern in self.BLOCKED_PATTERNS:
            if re.search(pattern, command, re.IGNORECASE):
                raise SandboxPolicyViolationError(
                    "blocked_pattern", f"Command matches blocked pattern: {pattern}"
                )

        # Check denied commands
        for denied in permission.denied_commands:
            if denied.lower() in command_lower:
                raise SandboxPermissionError(
                    tool_name, f"Command contains denied pattern: {denied}"
                )

        # Check allowed commands (if specified)
        if permission.allowed_commands:
            # Extract base command
            base_command = command_lower.split()[0] if command_lower else ""
            if base_command not in [cmd.lower() for cmd in permission.allowed_commands]:
                raise SandboxPermissionError(
                    tool_name,
                    f"Command '{base_command}' not in allowed list: {permission.allowed_commands}",
                )

    def _check_path(
        self, tool_name: str, path: str, permission: ToolPermission
    ) -> None:
        """Check if path access is allowed."""
        path_obj = Path(path)
        path_str = str(path_obj.resolve())

        # Check denied paths first
        for denied_pattern in permission.denied_paths:
            if fnmatch.fnmatch(path_str, denied_pattern):
                raise SandboxPermissionError(
                    tool_name, f"Access denied to path: {path}"
                )

        # Check allowed paths (if specified)
        if permission.allowed_paths:
            allowed = False
            for allowed_pattern in permission.allowed_paths:
                if fnmatch.fnmatch(path_str, allowed_pattern):
                    allowed = True
                    break

            if not allowed:
                raise SandboxPermissionError(
                    tool_name, f"Path not in allowed list: {path}"
                )

    def _check_code(self, tool_name: str, code: str) -> None:
        """Check code for dangerous patterns."""
        dangerous_patterns = [
            (r"import\s+os\s*;?\s*os\.system", "os.system call"),
            (r"import\s+subprocess", "subprocess import"),
            (r"__import__\s*\(", "dynamic import"),
            (r"eval\s*\(", "eval call"),
            (r"exec\s*\(", "exec call"),
            (r"compile\s*\(", "compile call"),
            (r"open\s*\([^)]*['\"]\/etc", "access to /etc"),
            (r"open\s*\([^)]*['\"]\/proc", "access to /proc"),
        ]

        for pattern, description in dangerous_patterns:
            if re.search(pattern, code, re.IGNORECASE):
                logger.warning(
                    f"Code contains potentially dangerous pattern: {description}"
                )
                # Note: We log but don't block - sandbox will contain the execution

    def get_sandbox_config(
        self, tool_name: str, override: dict[str, Any] | None = None
    ) -> SandboxConfig:
        """
        Get sandbox configuration for a tool.

        Args:
            tool_name: Name of the tool
            override: Optional config overrides

        Returns:
            SandboxConfig for the tool
        """
        permission = self.tool_permissions.get(tool_name)

        config = SandboxConfig(
            max_memory_mb=self.default_config.max_memory_mb,
            max_cpu_cores=self.default_config.max_cpu_cores,
            max_execution_time_seconds=(
                permission.max_execution_time_seconds
                if permission
                else self.default_config.max_execution_time_seconds
            ),
            network_access=self.default_config.network_access,
        )

        # Apply overrides
        if override:
            for key, value in override.items():
                if hasattr(config, key):
                    setattr(config, key, value)

        return config

    def requires_sandbox(self, tool_name: str) -> bool:
        """Check if tool requires sandbox execution."""
        permission = self.tool_permissions.get(tool_name)
        if not permission:
            return True  # Unknown tools always require sandbox
        return permission.sandbox_enabled

    def get_risk_level(self, tool_name: str) -> RiskLevel:
        """Get risk level for a tool."""
        permission = self.tool_permissions.get(tool_name)
        if not permission:
            return RiskLevel.HIGH  # Unknown tools are high risk
        return permission.risk_level

    def hash_code(self, code: str) -> str:
        """Generate hash of code for audit logging."""
        return f"sha256:{hashlib.sha256(code.encode()).hexdigest()[:16]}"
