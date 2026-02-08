"""Executor Agent implementation.

The ExecutorAgent is responsible for executing plans by invoking tools
and skills. It handles the actual work of carrying out the planned steps.

NOTE: This is a standalone Agent class implementation. The current runtime
uses the act_node() function in orchestrator/nodes.py for LangGraph integration.
This class is kept as an alternative implementation for non-graph execution modes.
"""

from typing import Any

from src.agents.base import AgentConfig, BaseAgent
from src.orchestrator.execution import (
    execute_parallel,
    execute_single,
    is_critical_failure,
)
from src.orchestrator.state import AgentState, PlanStep, ToolCallResult
from src.utils.logging import get_logger

logger = get_logger(__name__)


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
            parallel_results = await execute_parallel(parallel_actions, self.action_executor)
            results.extend(parallel_results)

        # Then execute sequential actions
        for action in sequential_actions:
            logger.info(f"Executing action: {action.tool}")
            result = await execute_single(action, self.action_executor)
            results.append(result)

            # Check for critical failures
            if not result.success and is_critical_failure(result):
                logger.warning(f"Critical failure in action {action.tool}")
                break

        return {
            **state,
            "tool_results": results,
            "pending_actions": [],
            "current_step": "observe",
        }

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
