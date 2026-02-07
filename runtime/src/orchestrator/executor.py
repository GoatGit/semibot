"""Action Executor - Execute tools with sandbox integration.

This module provides the action execution layer that integrates
sandbox security with tool execution in the orchestrator.
"""

from typing import Any

from src.constants import (
    SANDBOX_BYPASS_TOOLS,
    SANDBOX_DEFAULT_TIMEOUT,
    SANDBOX_REQUIRED_TOOLS,
)
from src.orchestrator.state import PlanStep, ToolCallResult
from src.sandbox import (
    ExecutionResult,
    PolicyEngine,
    SandboxManager,
    SandboxPermissionError,
    SandboxPolicyViolationError,
)
from src.utils.logging import get_logger

logger = get_logger(__name__)


class ActionExecutor:
    """
    Executes agent actions with sandbox integration.

    Determines whether each tool needs sandbox execution based on
    risk level and policy configuration, then routes to appropriate
    execution method.

    Example:
        ```python
        executor = ActionExecutor(
            sandbox_manager=sandbox_manager,
            policy_engine=policy_engine,
        )

        result = await executor.execute(action)
        ```
    """

    def __init__(
        self,
        sandbox_manager: SandboxManager | None = None,
        policy_engine: PolicyEngine | None = None,
        skill_registry: Any = None,
    ):
        """
        Initialize ActionExecutor.

        Args:
            sandbox_manager: Sandbox manager for isolated execution
            policy_engine: Policy engine for permission checks
            skill_registry: Skill registry for tool lookup
        """
        self.sandbox_manager = sandbox_manager
        self.policy_engine = policy_engine or PolicyEngine()
        self.skill_registry = skill_registry

    async def execute(
        self,
        action: PlanStep,
        session_id: str = "",
        agent_id: str = "",
        org_id: str = "",
    ) -> ToolCallResult:
        """
        Execute a single action.

        Args:
            action: The action to execute
            session_id: Session ID for audit
            agent_id: Agent ID for audit
            org_id: Organization ID for audit

        Returns:
            ToolCallResult with execution outcome
        """
        tool_name = action.tool
        params = action.params

        logger.info(
            f"Executing action: {tool_name}",
            extra={"action_id": action.id, "session_id": session_id},
        )

        try:
            # Check if tool requires sandbox
            if self._requires_sandbox(tool_name):
                result = await self._execute_in_sandbox(
                    tool_name=tool_name,
                    params=params,
                    session_id=session_id,
                    agent_id=agent_id,
                    org_id=org_id,
                )
            else:
                result = await self._execute_direct(
                    tool_name=tool_name,
                    params=params,
                )

            return ToolCallResult(
                tool_name=tool_name,
                params=params,
                result=result.get("output"),
                success=result.get("success", True),
                error=result.get("error"),
                duration_ms=result.get("duration_ms", 0),
            )

        except SandboxPermissionError as e:
            logger.warning(f"Permission denied for {tool_name}: {e}")
            return ToolCallResult(
                tool_name=tool_name,
                params=params,
                success=False,
                error=f"Permission denied: {e.reason}",
            )

        except SandboxPolicyViolationError as e:
            logger.warning(f"Policy violation for {tool_name}: {e}")
            return ToolCallResult(
                tool_name=tool_name,
                params=params,
                success=False,
                error=f"Policy violation: {e.details}",
            )

        except Exception as e:
            logger.error(f"Action execution failed: {e}")
            return ToolCallResult(
                tool_name=tool_name,
                params=params,
                success=False,
                error=str(e),
            )

    def _requires_sandbox(self, tool_name: str) -> bool:
        """Check if tool requires sandbox execution."""
        # Check bypass list first
        if tool_name in SANDBOX_BYPASS_TOOLS:
            return False

        # Check required list
        if tool_name in SANDBOX_REQUIRED_TOOLS:
            return True

        # Use policy engine for others
        if self.policy_engine:
            return self.policy_engine.requires_sandbox(tool_name)

        # Default to sandbox for unknown tools
        return True

    async def _execute_in_sandbox(
        self,
        tool_name: str,
        params: dict[str, Any],
        session_id: str,
        agent_id: str,
        org_id: str,
    ) -> dict[str, Any]:
        """Execute tool in sandbox."""
        if not self.sandbox_manager:
            raise RuntimeError("Sandbox manager not configured")

        # Check permission first
        self.policy_engine.check_permission(
            tool_name,
            command=params.get("command"),
            code=params.get("code"),
            path=params.get("path"),
        )

        timeout = params.get("timeout", SANDBOX_DEFAULT_TIMEOUT)

        if tool_name == "code_run":
            result = await self.sandbox_manager.execute_code(
                language=params.get("language", "python"),
                code=params["code"],
                timeout=timeout,
                files=params.get("files"),
                session_id=session_id,
                agent_id=agent_id,
                org_id=org_id,
            )
        elif tool_name == "shell_exec":
            result = await self.sandbox_manager.execute_shell(
                command=params["command"],
                timeout=timeout,
                files=params.get("files"),
                session_id=session_id,
                agent_id=agent_id,
                org_id=org_id,
            )
        elif tool_name == "file_write":
            # Execute file write in sandbox
            content = params.get("content", "")
            filepath = params.get("path", "output.txt")
            write_cmd = f"cat > {filepath} << 'SANDBOX_EOF'\n{content}\nSANDBOX_EOF"
            result = await self.sandbox_manager.execute_shell(
                command=write_cmd,
                timeout=timeout,
                session_id=session_id,
                agent_id=agent_id,
                org_id=org_id,
            )
        elif tool_name == "file_edit":
            # Execute file edit in sandbox using sed
            filepath = params.get("path")
            old_text = params.get("old_text", "")
            new_text = params.get("new_text", "")
            # Escape special characters for sed
            old_escaped = old_text.replace("/", "\\/").replace("&", "\\&")
            new_escaped = new_text.replace("/", "\\/").replace("&", "\\&")
            edit_cmd = f"sed -i 's/{old_escaped}/{new_escaped}/g' {filepath}"
            result = await self.sandbox_manager.execute_shell(
                command=edit_cmd,
                timeout=timeout,
                session_id=session_id,
                agent_id=agent_id,
                org_id=org_id,
            )
        else:
            # Generic sandbox execution
            result = await self.sandbox_manager.execute_shell(
                command=self._build_tool_command(tool_name, params),
                timeout=timeout,
                session_id=session_id,
                agent_id=agent_id,
                org_id=org_id,
            )

        return self._convert_sandbox_result(result)

    async def _execute_direct(
        self,
        tool_name: str,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        """Execute tool directly without sandbox."""
        if tool_name == "file_read":
            return await self._execute_file_read(params)
        elif tool_name == "search":
            return await self._execute_search(params)
        elif tool_name == "llm_call":
            return await self._execute_llm_call(params)
        else:
            # Use skill registry for custom tools
            if self.skill_registry:
                skill = self.skill_registry.get(tool_name)
                if skill:
                    return await skill.execute(params)

            raise ValueError(f"Unknown tool: {tool_name}")

    async def _execute_file_read(self, params: dict[str, Any]) -> dict[str, Any]:
        """Read file directly (low risk)."""
        filepath = params.get("path")
        if not filepath:
            return {"success": False, "error": "Path not specified"}

        # Check permission
        self.policy_engine.check_permission("file_read", path=filepath)

        try:
            with open(filepath, "r") as f:
                content = f.read()
            return {"success": True, "output": content}
        except FileNotFoundError:
            return {"success": False, "error": f"File not found: {filepath}"}
        except PermissionError:
            return {"success": False, "error": f"Permission denied: {filepath}"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def _execute_search(self, params: dict[str, Any]) -> dict[str, Any]:
        """Execute search (low risk)."""
        query = params.get("query", "")
        # Placeholder - integrate with actual search implementation
        return {"success": True, "output": f"Search results for: {query}"}

    async def _execute_llm_call(self, params: dict[str, Any]) -> dict[str, Any]:
        """Execute LLM call (low risk)."""
        # Placeholder - integrate with LLM provider
        return {"success": True, "output": "LLM response placeholder"}

    def _build_tool_command(self, tool_name: str, params: dict[str, Any]) -> str:
        """Build command for generic tool execution."""
        # Convert params to command-line arguments
        args = " ".join(f"--{k}={v}" for k, v in params.items())
        return f"{tool_name} {args}"

    def _convert_sandbox_result(self, result: ExecutionResult) -> dict[str, Any]:
        """Convert ExecutionResult to dict."""
        output = result.stdout
        if result.stderr and not result.success:
            output = f"{output}\nError: {result.stderr}"

        return {
            "success": result.success,
            "output": output,
            "error": result.error or (result.stderr if not result.success else None),
            "duration_ms": result.execution_time_ms,
            "exit_code": result.exit_code,
            "memory_used_mb": result.memory_used_mb,
        }


async def execute_single(action: PlanStep, executor: ActionExecutor) -> ToolCallResult:
    """Execute a single action using the executor."""
    return await executor.execute(action)


async def execute_parallel(
    actions: list[PlanStep],
    executor: ActionExecutor,
) -> list[ToolCallResult]:
    """Execute multiple actions in parallel."""
    import asyncio

    tasks = [executor.execute(action) for action in actions]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    # Convert exceptions to ToolCallResult
    final_results = []
    for i, result in enumerate(results):
        if isinstance(result, Exception):
            final_results.append(
                ToolCallResult(
                    tool_name=actions[i].tool,
                    params=actions[i].params,
                    success=False,
                    error=str(result),
                )
            )
        else:
            final_results.append(result)

    return final_results
