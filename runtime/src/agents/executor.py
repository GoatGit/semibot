"""Executor Agent implementation.

The ExecutorAgent is responsible for executing plans by invoking tools
and skills. It handles the actual work of carrying out the planned steps.
"""

import asyncio
import logging
from typing import Any

from src.agents.base import AgentConfig, BaseAgent
from src.orchestrator.state import AgentState, PlanStep, ToolCallResult

logger = logging.getLogger(__name__)


EXECUTOR_SYSTEM_PROMPT = """You are an execution agent. Your role is to execute planned tasks
using the available tools and skills.

When executing:
1. Follow the plan steps precisely
2. Use the correct tool with the specified parameters
3. Handle errors gracefully
4. Report results clearly

If a step fails, analyze the error and suggest alternatives if possible.
"""


class ExecutorAgent(BaseAgent):
    """
    Agent specialized in executing plans and tool calls.

    The ExecutorAgent takes execution plans and carries them out by:
    - Invoking the appropriate tools/skills
    - Managing parallel execution
    - Handling errors and retries
    - Collecting and reporting results
    """

    def __init__(
        self,
        config: AgentConfig | None = None,
        llm_provider: Any = None,
        skill_registry: Any = None,
        memory_system: Any = None,
        action_executor: Any = None,
    ):
        """
        Initialize the ExecutorAgent.

        Args:
            config: Agent configuration (uses defaults if not provided)
            llm_provider: LLM provider for error analysis
            skill_registry: Registry of available skills
            memory_system: Memory system for context
            action_executor: Executor for running tools/skills
        """
        if config is None:
            config = AgentConfig(
                id="executor",
                name="Executor Agent",
                description="Executes plans by invoking tools and skills",
                system_prompt=EXECUTOR_SYSTEM_PROMPT,
                model="gpt-4o-mini",  # Use faster model for execution
                temperature=0.1,  # Low temperature for precise execution
            )

        super().__init__(config, llm_provider, skill_registry, memory_system)
        self.action_executor = action_executor

    async def execute(self, state: AgentState) -> AgentState:
        """
        Execute the pending actions from the plan.

        This method:
        1. Gets pending actions from state
        2. Separates parallel and sequential actions
        3. Executes actions (parallel first, then sequential)
        4. Collects results
        5. Updates state with results

        Args:
            state: Current agent state with pending_actions

        Returns:
            Updated state with tool_results
        """
        logger.info(
            "ExecutorAgent executing",
            extra={
                "session_id": state["session_id"],
                "pending_count": len(state.get("pending_actions", [])),
            },
        )

        pending_actions = state.get("pending_actions", [])

        if not pending_actions:
            logger.info("No pending actions to execute")
            return {
                **state,
                "current_step": "observe",
            }

        if not self.action_executor:
            logger.error("No action executor configured")
            return {
                **state,
                "error": "Action executor not configured",
                "current_step": "observe",
            }

        # Separate parallel and sequential actions
        parallel_actions = [a for a in pending_actions if a.parallel]
        sequential_actions = [a for a in pending_actions if not a.parallel]

        results: list[ToolCallResult] = []

        # Execute parallel actions first
        if parallel_actions:
            logger.info(f"Executing {len(parallel_actions)} actions in parallel")
            parallel_results = await self._execute_parallel(parallel_actions)
            results.extend(parallel_results)

        # Then execute sequential actions
        for action in sequential_actions:
            logger.info(f"Executing action: {action.tool}")
            result = await self._execute_single(action)
            results.append(result)

            # Check for critical failures
            if not result.success and self._is_critical_failure(result):
                logger.warning(f"Critical failure in action {action.tool}")
                break

        return {
            **state,
            "tool_results": results,
            "pending_actions": [],
            "current_step": "observe",
        }

    async def _execute_parallel(
        self,
        actions: list[PlanStep],
    ) -> list[ToolCallResult]:
        """Execute multiple actions in parallel."""
        tasks = [self._execute_single(action) for action in actions]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Convert exceptions to error results
        processed_results = []
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                processed_results.append(
                    ToolCallResult(
                        tool_name=actions[i].tool or "unknown",
                        params=actions[i].params,
                        error=str(result),
                        success=False,
                    )
                )
            else:
                processed_results.append(result)

        return processed_results

    async def _execute_single(self, action: PlanStep) -> ToolCallResult:
        """Execute a single action."""
        import time

        start_time = time.time()

        try:
            # Update action status
            action.status = "running"

            # Execute via action executor
            result = await self.action_executor.execute(
                name=action.tool,
                params=action.params,
            )

            duration_ms = int((time.time() - start_time) * 1000)

            # Check for errors in result
            has_error = "error" in result and result["error"]

            tool_result = ToolCallResult(
                tool_name=action.tool or "unknown",
                params=action.params,
                result=result.get("result") if not has_error else None,
                error=result.get("error") if has_error else None,
                success=not has_error,
                duration_ms=duration_ms,
            )

            # Update action status
            action.status = "completed" if tool_result.success else "failed"
            action.result = tool_result.result
            action.error = tool_result.error

            return tool_result

        except asyncio.TimeoutError:
            duration_ms = int((time.time() - start_time) * 1000)
            action.status = "failed"
            action.error = "Execution timeout"
            return ToolCallResult(
                tool_name=action.tool or "unknown",
                params=action.params,
                error="Execution timeout",
                success=False,
                duration_ms=duration_ms,
            )

        except Exception as e:
            duration_ms = int((time.time() - start_time) * 1000)
            logger.error(f"Action execution failed: {e}")
            action.status = "failed"
            action.error = str(e)
            return ToolCallResult(
                tool_name=action.tool or "unknown",
                params=action.params,
                error=str(e),
                success=False,
                duration_ms=duration_ms,
            )

    def _is_critical_failure(self, result: ToolCallResult) -> bool:
        """
        Determine if a failure is critical and should stop execution.

        Critical failures include:
        - Authentication errors
        - Rate limiting
        - Service unavailable

        Args:
            result: The failed tool call result

        Returns:
            True if this is a critical failure
        """
        if not result.error:
            return False

        critical_patterns = [
            "authentication",
            "unauthorized",
            "rate limit",
            "quota exceeded",
            "service unavailable",
        ]

        error_lower = result.error.lower()
        return any(pattern in error_lower for pattern in critical_patterns)

    async def analyze_failure(
        self,
        result: ToolCallResult,
        context: dict[str, Any],
    ) -> dict[str, Any]:
        """
        Use the LLM to analyze a failure and suggest alternatives.

        Args:
            result: The failed tool call result
            context: Additional context for analysis

        Returns:
            Analysis with suggestions
        """
        if not self.llm_provider:
            return {"suggestion": "Retry or try an alternative approach"}

        prompt = f"""
A tool execution failed. Please analyze and suggest alternatives.

Tool: {result.tool_name}
Parameters: {result.params}
Error: {result.error}

Context: {context}

Provide a brief analysis and suggest what to do next.
"""

        try:
            response = await self.llm_provider.chat(
                messages=[
                    {"role": "system", "content": self.system_prompt},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.3,
            )
            return {"suggestion": response.get("content", "")}
        except Exception as e:
            logger.error(f"Failure analysis failed: {e}")
            return {"suggestion": "Retry or try an alternative approach"}
