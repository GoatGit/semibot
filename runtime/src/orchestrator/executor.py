"""Action Executor - Execute tools with sandbox integration.

This module provides the action execution layer that integrates
sandbox security with tool execution in the orchestrator.
"""

import asyncio
import json
import re
from typing import Any

from src.constants import (
    SANDBOX_BYPASS_TOOLS,
    SANDBOX_DEFAULT_TIMEOUT,
    SANDBOX_MAX_TIMEOUT,
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
from src.utils.validation import ensure_relative_path

logger = get_logger(__name__)
_CLI_FLAG_PATTERN = re.compile(r"[^A-Za-z0-9_-]+")


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
        llm_provider: Any = None,
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
        self.llm_provider = llm_provider

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

        # Clamp timeout to safe range — params come from LLM output
        raw_timeout = params.get("timeout", SANDBOX_DEFAULT_TIMEOUT)
        try:
            timeout = min(max(float(raw_timeout), 1), SANDBOX_MAX_TIMEOUT)
        except (TypeError, ValueError):
            timeout = SANDBOX_DEFAULT_TIMEOUT

        try:
            return await asyncio.wait_for(
                self._execute_inner(
                    action=action,
                    session_id=session_id,
                    agent_id=agent_id,
                    org_id=org_id,
                ),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            logger.error(
                "Action execution timed out: %s (timeout=%ss)",
                tool_name,
                timeout,
                extra={"action_id": action.id},
            )
            return ToolCallResult(
                tool_name=tool_name,
                params=params,
                success=False,
                error="Tool execution timed out",
                metadata={"error_type": "TimeoutError"},
            )

    async def _execute_inner(
        self,
        action: PlanStep,
        session_id: str = "",
        agent_id: str = "",
        org_id: str = "",
    ) -> ToolCallResult:
        """Inner execution logic without overall timeout wrapper."""
        tool_name = action.tool
        params = action.params

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
            filepath = str(ensure_relative_path(params.get("path", "output.txt")))
            content = str(params.get("content", ""))
            result = await self.sandbox_manager.execute_code(
                language="python",
                code=self._build_file_write_code(filepath=filepath, content=content),
                timeout=timeout,
                session_id=session_id,
                agent_id=agent_id,
                org_id=org_id,
            )
        elif tool_name == "file_edit":
            filepath = str(ensure_relative_path(params.get("path", "")))
            old_text = str(params.get("old_text", ""))
            new_text = str(params.get("new_text", ""))
            result = await self.sandbox_manager.execute_code(
                language="python",
                code=self._build_file_edit_code(
                    filepath=filepath,
                    old_text=old_text,
                    new_text=new_text,
                ),
                timeout=timeout,
                session_id=session_id,
                agent_id=agent_id,
                org_id=org_id,
            )
        else:
            result = await self.sandbox_manager.execute_code(
                language="python",
                code=self._build_tool_command_runner(tool_name, params),
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
                result = await self.skill_registry.execute(tool_name, params)
                return {
                    "success": result.success,
                    "output": result.result,
                    "error": result.error,
                    "metadata": result.metadata,
                }

            raise ValueError(f"Unknown tool: {tool_name}")

    async def _execute_file_read(self, params: dict[str, Any]) -> dict[str, Any]:
        """Read file directly (low risk)."""
        filepath = params.get("path")
        if not filepath:
            return {"success": False, "error": "Path not specified"}

        # Normalize path to prevent traversal attacks (consistent with file_write).
        filepath = str(ensure_relative_path(filepath))

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
        queries = params.get("queries") or []
        # Backward compat: legacy `query` string
        legacy_query = params.get("query", "")
        if not queries and legacy_query:
            queries = [legacy_query]
        if not queries:
            return {"success": False, "error": "queries not specified"}

        if not self.skill_registry:
            return {"success": False, "error": "Skill registry not configured"}

        tool_name = "search"

        result = await self.skill_registry.execute(
            tool_name,
            {
                "queries": queries,
                "max_results": params.get("max_results", 5),
                "search_depth": params.get("search_depth", "basic"),
            },
        )

        return {
            "success": result.success,
            "output": result.result,
            "error": result.error,
            "metadata": result.metadata,
        }

    async def _execute_llm_call(self, params: dict[str, Any]) -> dict[str, Any]:
        """Execute LLM call (low risk)."""
        if not self.llm_provider:
            return {"success": False, "error": "LLM provider not configured"}

        messages = params.get("messages", [])
        if not isinstance(messages, list) or not messages:
            return {"success": False, "error": "messages must be a non-empty list"}

        try:
            response = await self.llm_provider.chat(
                messages=messages,
                tools=params.get("tools"),
                temperature=params.get("temperature"),
                max_tokens=params.get("max_tokens"),
                response_format=params.get("response_format"),
                model=params.get("model"),
            )

            content = getattr(response, "content", None)
            usage = getattr(response, "usage", None)
            if isinstance(response, dict):
                content = response.get("content", "")
                usage = response.get("usage")

            return {
                "success": True,
                "output": content or "",
                "usage": usage,
            }
        except Exception as e:
            return {"success": False, "error": str(e)}

    def _build_tool_command_runner(self, tool_name: str, params: dict[str, Any]) -> str:
        argv = [str(tool_name)]
        for key, value in params.items():
            flag = _CLI_FLAG_PATTERN.sub("_", str(key or "").strip()).strip("_")
            if not flag:
                continue
            argv.append(f"--{flag}={str(value)}")
        argv_literal = json.dumps(argv, ensure_ascii=False)
        return (
            "import subprocess\n"
            f"argv = {argv_literal}\n"
            "completed = subprocess.run(argv, capture_output=True, text=True, check=False)\n"
            "if completed.stdout:\n"
            "    print(completed.stdout, end='')\n"
            "if completed.stderr:\n"
            "    print(completed.stderr, end='')\n"
            "raise SystemExit(completed.returncode)\n"
        )

    def _build_file_write_code(self, *, filepath: str, content: str) -> str:
        return (
            "from pathlib import Path\n"
            f"path = Path({json.dumps(filepath, ensure_ascii=False)})\n"
            "path.parent.mkdir(parents=True, exist_ok=True)\n"
            f"path.write_text({json.dumps(content, ensure_ascii=False)}, encoding='utf-8')\n"
            "print(str(path))\n"
        )

    def _build_file_edit_code(self, *, filepath: str, old_text: str, new_text: str) -> str:
        return (
            "from pathlib import Path\n"
            f"path = Path({json.dumps(filepath, ensure_ascii=False)})\n"
            "content = path.read_text(encoding='utf-8')\n"
            f"old_text = {json.dumps(old_text, ensure_ascii=False)}\n"
            "if old_text not in content:\n"
            "    raise ValueError('old_text not found in file, edit aborted')\n"
            f"updated = content.replace(old_text, {json.dumps(new_text, ensure_ascii=False)})\n"
            "path.write_text(updated, encoding='utf-8')\n"
            "print(str(path))\n"
        )

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
    tasks = [executor.execute(action) for action in actions]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    # Convert exceptions to ToolCallResult
    final_results = []
    for i, result in enumerate(results):
        if isinstance(result, Exception):
            error_type = type(result).__name__
            if isinstance(result, (TimeoutError, asyncio.TimeoutError)):
                logger.warning(
                    "Parallel action timed out: %s", actions[i].tool,
                    extra={"action_id": actions[i].id, "error_type": error_type},
                )
            elif isinstance(result, SandboxPermissionError):
                logger.warning(
                    "Parallel action permission denied: %s", actions[i].tool,
                    extra={"action_id": actions[i].id, "error_type": error_type},
                )
            else:
                logger.error(
                    "Unexpected error in parallel action %s: %s",
                    actions[i].tool,
                    result,
                    extra={"action_id": actions[i].id, "error_type": error_type},
                )
            final_results.append(
                ToolCallResult(
                    tool_name=actions[i].tool,
                    params=actions[i].params,
                    success=False,
                    error=str(result),
                    metadata={"error_type": error_type},
                )
            )
        else:
            final_results.append(result)

    return final_results
