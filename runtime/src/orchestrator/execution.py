"""Shared execution utilities for agents and orchestrator nodes.

This module contains common execution logic used by both the orchestrator nodes
and the agent classes to avoid code duplication.
"""

import asyncio
import time
from typing import Any

from src.orchestrator.state import ExecutionPlan, PlanStep, ReflectionResult, ToolCallResult
from src.utils.logging import get_logger

logger = get_logger(__name__)


async def execute_parallel(
    actions: list[PlanStep],
    executor: Any,
) -> list[ToolCallResult]:
    """
    Execute multiple actions in parallel.

    Args:
        actions: List of plan steps to execute in parallel
        executor: Action executor instance with execute(name, params) method

    Returns:
        List of tool call results
    """
    tasks = [execute_single(action, executor) for action in actions]
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


async def execute_single(action: PlanStep, executor: Any) -> ToolCallResult:
    """
    Execute a single action.

    Args:
        action: The plan step to execute
        executor: Action executor instance with execute(name, params) method

    Returns:
        Tool call result with success/failure and timing info
    """
    start_time = time.time()

    try:
        result = await executor.execute(
            name=action.tool,
            params=action.params,
        )
        duration_ms = int((time.time() - start_time) * 1000)

        # Check for errors in result
        has_error = "error" in result and result["error"]

        return ToolCallResult(
            tool_name=action.tool or "unknown",
            params=action.params,
            result=result.get("result") if not has_error else None,
            error=result.get("error") if has_error else None,
            success=not has_error,
            duration_ms=duration_ms,
        )

    except asyncio.TimeoutError:
        duration_ms = int((time.time() - start_time) * 1000)
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
        return ToolCallResult(
            tool_name=action.tool or "unknown",
            params=action.params,
            error=str(e),
            success=False,
            duration_ms=duration_ms,
        )


def parse_plan_response(response: dict[str, Any]) -> ExecutionPlan:
    """
    Parse an LLM plan response into an ExecutionPlan.

    Args:
        response: The LLM response dict containing goal, steps, etc.

    Returns:
        Parsed ExecutionPlan object
    """
    # Handle both direct response format and content wrapper format
    content = response.get("content", response) if isinstance(response.get("content"), dict) else response

    # Handle direct response (no tools needed)
    if "direct_response" in content:
        return ExecutionPlan(
            goal=content.get("goal", "Answer the question"),
            steps=[],
        )

    # Parse steps
    steps = [
        PlanStep(
            id=step.get("id", f"step_{i}"),
            title=step.get("title", ""),
            tool=step.get("tool"),
            params=step.get("params", {}),
            parallel=step.get("parallel", False),
        )
        for i, step in enumerate(content.get("steps", []))
    ]

    return ExecutionPlan(
        goal=content.get("goal", ""),
        steps=steps,
        requires_delegation=content.get("requires_delegation", False),
        delegate_to=content.get("delegate_to"),
    )


def parse_reflection_response(response: dict[str, Any]) -> ReflectionResult:
    """
    Parse an LLM reflection response.

    Args:
        response: The LLM response dict containing summary, lessons, etc.

    Returns:
        Parsed ReflectionResult object
    """
    return ReflectionResult(
        summary=response.get("summary", "Task completed."),
        lessons_learned=response.get("lessons_learned", []),
        worth_remembering=response.get("worth_remembering", False),
        importance=response.get("importance", 0.5),
    )


def is_critical_failure(result: ToolCallResult) -> bool:
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
