"""State nodes for the LangGraph state machine.

Each node is a function that takes the current AgentState and returns
an updated state. These nodes implement the core Agent execution logic:

- START: Initialize context and load memories
- PLAN: Parse intent and generate execution plan
- ACT: Execute tools/skills
- DELEGATE: Delegate to SubAgents
- OBSERVE: Evaluate results and decide next step
- REFLECT: Summarize and store learnings
- RESPOND: Generate final response
"""

from typing import Any

from src.constants import MAX_REPLAN_ATTEMPTS
from src.orchestrator.execution import (
    execute_parallel,
    execute_single,
    parse_plan_response,
    parse_reflection_response,
)
from src.orchestrator.state import (
    AgentState,
    ExecutionPlan,
    Message,
    PlanStep,
    ReflectionResult,
    ToolCallResult,
)
from src.utils.logging import get_logger

logger = get_logger(__name__)


async def start_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    """
    START node: Initialize execution context and load memories.

    This is the entry point for agent execution. It:
    1. Loads short-term memory (recent conversation context)
    2. Retrieves relevant long-term memories
    3. Initializes the execution context

    Args:
        state: Current agent state
        context: Injected dependencies (memory_system, etc.)

    Returns:
        State updates with memory context loaded
    """
    logger.info(
        "Starting agent execution",
        extra={"session_id": state["session_id"], "agent_id": state["agent_id"]},
    )

    memory_system = context.get("memory_system")
    memory_context = ""

    if memory_system:
        try:
            # Load short-term memory
            short_term = await memory_system.get_short_term(state["session_id"])

            # Search long-term memory for relevant context
            user_message = state["messages"][-1]["content"] if state["messages"] else ""
            long_term = await memory_system.search_long_term(
                agent_id=state["agent_id"],
                query=user_message,
                limit=5,
            )

            # Combine into context string
            memory_parts = []
            if short_term:
                memory_parts.append(f"Recent context:\n{short_term}")
            if long_term:
                memory_parts.append(f"Relevant knowledge:\n{long_term}")

            memory_context = "\n\n".join(memory_parts)
        except Exception as e:
            logger.warning(f"Failed to load memory: {e}")

    return {
        "memory_context": memory_context,
        "iteration": 0,
        "current_step": "plan",
    }


async def plan_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    """
    PLAN node: Parse user intent and generate execution plan.

    This node uses the LLM to:
    1. Understand what the user wants to accomplish
    2. Break down the task into executable steps
    3. Determine if delegation to SubAgents is needed
    4. Generate a structured execution plan

    Args:
        state: Current agent state
        context: Injected dependencies (llm_provider, skill_registry, etc.)

    Returns:
        State updates with execution plan
    """
    logger.info(
        "Generating execution plan",
        extra={"session_id": state["session_id"], "iteration": state["iteration"]},
    )

    llm_provider = context.get("llm_provider")
    skill_registry = context.get("skill_registry")

    if not llm_provider:
        return {
            "error": "LLM provider not configured",
            "current_step": "respond",
        }

    # Build CapabilityGraph from RuntimeSessionContext
    available_skills = []
    runtime_context = state.get("context")

    if runtime_context:
        # Use CapabilityGraph to get available capabilities
        from src.orchestrator.capability import CapabilityGraph

        capability_graph = CapabilityGraph(runtime_context)
        available_skills = capability_graph.get_schemas_for_planner()

        logger.info(
            "Capability graph built for planning",
            extra={
                "session_id": state["session_id"],
                "capability_count": len(available_skills),
            },
        )
    elif skill_registry:
        # Fallback to skill_registry for backward compatibility
        available_skills = skill_registry.get_all_schemas()
        logger.warning(
            "Using skill_registry fallback (no RuntimeSessionContext)",
            extra={"session_id": state["session_id"]},
        )

    # Extract state data
    messages = state["messages"]
    memory_context = state["memory_context"]

    try:
        # Call LLM to generate plan
        plan_response = await llm_provider.generate_plan(
            messages=messages,
            memory=memory_context,
            available_tools=available_skills,
        )

        # Parse plan from response
        plan = parse_plan_response(plan_response)

        # Check if this is a simple question (no tools needed)
        if not plan.steps:
            return {
                "plan": plan,
                "pending_actions": [],
                "current_step": "respond",
            }

        return {
            "plan": plan,
            "pending_actions": plan.steps,
            "current_step": "act" if not plan.requires_delegation else "delegate",
        }

    except Exception as e:
        logger.error(f"Planning failed: {e}")
        return {
            "error": f"Planning failed: {str(e)}",
            "current_step": "respond",
        }


async def act_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    """
    ACT node: Execute pending actions (tool/skill calls).

    This node:
    1. Uses UnifiedActionExecutor if available (with RuntimeSessionContext)
    2. Falls back to legacy action_executor for backward compatibility
    3. Supports parallel execution for independent actions
    4. Collects results and errors

    Args:
        state: Current agent state
        context: Injected dependencies (action_executor, unified_executor, etc.)

    Returns:
        State updates with tool execution results
    """
    logger.info(
        "Executing actions",
        extra={
            "session_id": state["session_id"],
            "action_count": len(state["pending_actions"]),
        },
    )

    # Check for UnifiedActionExecutor first (preferred)
    unified_executor = context.get("unified_executor")
    action_executor = context.get("action_executor")

    if not unified_executor and not action_executor:
        return {
            "error": "No executor configured",
            "current_step": "observe",
            "pending_actions": [],
        }

    pending_actions = state["pending_actions"]
    if not pending_actions:
        return {
            "current_step": "observe",
        }

    # If using UnifiedActionExecutor, validation is handled internally
    if unified_executor:
        logger.info(
            "Using UnifiedActionExecutor",
            extra={"session_id": state["session_id"]},
        )

        results: list[ToolCallResult] = []

        # Separate parallel and sequential actions
        parallel_actions = [a for a in pending_actions if a.parallel]
        sequential_actions = [a for a in pending_actions if not a.parallel]

        # Execute parallel actions
        if parallel_actions:
            import asyncio
            parallel_results = await asyncio.gather(
                *[unified_executor.execute(action) for action in parallel_actions],
                return_exceptions=True,
            )
            # Convert exceptions to error results
            for i, result in enumerate(parallel_results):
                if isinstance(result, Exception):
                    results.append(
                        ToolCallResult(
                            tool_name=parallel_actions[i].tool or "unknown",
                            params=parallel_actions[i].params,
                            error=str(result),
                            success=False,
                        )
                    )
                else:
                    results.append(result)

        # Execute sequential actions
        for action in sequential_actions:
            try:
                result = await unified_executor.execute(action)
                results.append(result)
            except Exception as e:
                logger.error(f"Action execution failed: {e}")
                results.append(
                    ToolCallResult(
                        tool_name=action.tool or "unknown",
                        params=action.params,
                        error=str(e),
                        success=False,
                    )
                )

        return {
            "tool_results": results,
            "pending_actions": [],
            "current_step": "observe",
        }

    # Legacy path: use action_executor with manual validation
    logger.warning(
        "Using legacy action_executor (no UnifiedActionExecutor)",
        extra={"session_id": state["session_id"]},
    )

    # Build CapabilityGraph for validation
    capability_graph = None
    runtime_context = state.get("context")

    if runtime_context:
        from src.orchestrator.capability import CapabilityGraph

        capability_graph = CapabilityGraph(runtime_context)
        capability_graph.build()

    # Validate actions against capability graph
    validated_actions = []
    for action in pending_actions:
        tool_name = action.tool

        if not tool_name:
            logger.warning(
                "Action has no tool specified, skipping",
                extra={"session_id": state["session_id"], "action_id": action.id},
            )
            continue

        # Validate action if capability_graph is available
        if capability_graph:
            if not capability_graph.validate_action(tool_name):
                logger.error(
                    "Action validation failed: not in capability graph",
                    extra={
                        "session_id": state["session_id"],
                        "action_id": action.id,
                        "tool_name": tool_name,
                        "available_capabilities": capability_graph.list_capabilities(),
                    },
                )
                # Skip this action - it's not in the capability graph
                continue

        validated_actions.append(action)

    if not validated_actions:
        logger.warning(
            "No valid actions to execute after validation",
            extra={"session_id": state["session_id"]},
        )
        return {
            "current_step": "observe",
            "pending_actions": [],
        }

    # Separate parallel and sequential actions
    parallel_actions = [a for a in validated_actions if a.parallel]
    sequential_actions = [a for a in validated_actions if not a.parallel]

    results: list[ToolCallResult] = []

    # Execute parallel actions
    if parallel_actions:
        parallel_results = await execute_parallel(parallel_actions, action_executor)
        results.extend(parallel_results)

    # Execute sequential actions
    for action in sequential_actions:
        result = await execute_single(action, action_executor)
        results.append(result)

    return {
        "tool_results": results,
        "pending_actions": [],
        "current_step": "observe",
    }


async def delegate_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    """
    DELEGATE node: Delegate task to a SubAgent.

    This node:
    1. Identifies the appropriate SubAgent
    2. Prepares the delegation context
    3. Executes the SubAgent
    4. Collects the SubAgent's results

    Args:
        state: Current agent state
        context: Injected dependencies (sub_agent_delegator, etc.)

    Returns:
        State updates with SubAgent results
    """
    logger.info(
        "Delegating to SubAgent",
        extra={
            "session_id": state["session_id"],
            "delegate_to": state["plan"].delegate_to if state["plan"] else None,
        },
    )

    delegator = context.get("sub_agent_delegator")
    plan = state["plan"]

    if not delegator or not plan or not plan.delegate_to:
        return {
            "error": "Delegation not configured or no target specified",
            "current_step": "observe",
        }

    try:
        # Get the task from plan
        task = plan.goal
        delegation_context = {
            "memory": state["memory_context"],
            "parent_session_id": state["session_id"],
        }

        result = await delegator.delegate(
            sub_agent_id=plan.delegate_to,
            task=task,
            context=delegation_context,
        )

        # Convert SubAgent result to ToolCallResult format
        tool_result = ToolCallResult(
            tool_name=f"subagent:{plan.delegate_to}",
            params={"task": task},
            result=result.get("result"),
            success=not result.get("error"),
            error=result.get("error"),
        )

        return {
            "tool_results": [tool_result],
            "current_step": "observe",
        }

    except Exception as e:
        logger.error(f"Delegation failed: {e}")
        return {
            "tool_results": [
                ToolCallResult(
                    tool_name=f"subagent:{plan.delegate_to}",
                    params={},
                    error=str(e),
                    success=False,
                )
            ],
            "current_step": "observe",
        }


async def observe_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    """
    OBSERVE node: Evaluate results and decide next step.

    This node:
    1. Analyzes tool/skill execution results
    2. Checks for errors or failures
    3. Determines if replanning is needed
    4. Decides whether to continue, replan, or complete

    Args:
        state: Current agent state
        context: Injected dependencies (llm_provider, etc.)

    Returns:
        State updates with next step decision
    """
    logger.info(
        "Observing results",
        extra={
            "session_id": state["session_id"],
            "result_count": len(state["tool_results"]),
        },
    )

    llm_provider = context.get("llm_provider")
    config = context.get("config", {})
    max_iterations = config.get("max_iterations", 10)

    # Check iteration limit
    current_iteration = state["iteration"] + 1
    if current_iteration >= max_iterations:
        logger.warning(
            f"Max iterations reached: {max_iterations}",
            extra={"session_id": state["session_id"]},
        )
        return {
            "iteration": current_iteration,
            "current_step": "reflect",
        }

    # Analyze results
    tool_results = state["tool_results"]
    has_errors = any(not r.success for r in tool_results)
    all_failed = all(not r.success for r in tool_results) if tool_results else False

    # If all failed, try replanning
    if all_failed and current_iteration < MAX_REPLAN_ATTEMPTS:
        logger.info(
            "replan_attempt",
            current_iteration=current_iteration,
            max_attempts=MAX_REPLAN_ATTEMPTS,
        )
        return {
            "iteration": current_iteration,
            "current_step": "plan",
        }

    # Check if there are more pending steps in the plan
    plan = state["plan"]
    if plan and plan.steps and plan.current_step_index < len(plan.steps) - 1:
        # Get next batch of actions
        next_actions = plan.steps[plan.current_step_index + 1 :]
        updated_plan = ExecutionPlan(
            goal=plan.goal,
            steps=plan.steps,
            current_step_index=plan.current_step_index + 1,
            requires_delegation=plan.requires_delegation,
            delegate_to=plan.delegate_to,
        )
        return {
            "iteration": current_iteration,
            "plan": updated_plan,
            "pending_actions": next_actions[:1],  # Execute one step at a time
            "current_step": "act",
        }

    # All steps completed, move to reflection
    return {
        "iteration": current_iteration,
        "current_step": "reflect",
    }


async def reflect_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    """
    REFLECT node: Summarize execution and extract learnings.

    This node:
    1. Summarizes what was accomplished
    2. Extracts key lessons learned
    3. Determines if insights should be stored in long-term memory
    4. Stores valuable learnings

    Args:
        state: Current agent state
        context: Injected dependencies (llm_provider, memory_system, etc.)

    Returns:
        State updates with reflection summary
    """
    logger.info(
        "Reflecting on execution",
        extra={"session_id": state["session_id"]},
    )

    llm_provider = context.get("llm_provider")
    memory_system = context.get("memory_system")

    # Generate reflection
    reflection = ReflectionResult(
        summary="Task completed.",
        lessons_learned=[],
        worth_remembering=False,
        importance=0.5,
    )

    if llm_provider:
        try:
            reflection_response = await llm_provider.reflect(
                messages=state["messages"],
                plan=state["plan"],
                results=state["tool_results"],
            )
            reflection = parse_reflection_response(reflection_response)
        except Exception as e:
            logger.warning(f"Reflection generation failed: {e}")

    # Store valuable learnings in long-term memory
    if reflection.worth_remembering and memory_system:
        try:
            await memory_system.save_long_term(
                agent_id=state["agent_id"],
                content=reflection.summary,
                importance=reflection.importance,
            )
        except Exception as e:
            logger.warning(f"Failed to save to long-term memory: {e}")

    return {
        "reflection": reflection,
        "current_step": "respond",
    }


async def respond_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    """
    RESPOND node: Generate final response to user.

    This node:
    1. Synthesizes all results and reflections
    2. Generates a user-friendly response
    3. Adds the response to message history

    Args:
        state: Current agent state
        context: Injected dependencies (llm_provider, etc.)

    Returns:
        State updates with final response message
    """
    logger.info(
        "Generating response",
        extra={"session_id": state["session_id"]},
    )

    llm_provider = context.get("llm_provider")

    # Check for errors
    if state["error"]:
        error_message = Message(
            role="assistant",
            content=f"I encountered an error: {state['error']}. Please try again.",
            name=None,
            tool_call_id=None,
        )
        return {"messages": [error_message]}

    # Generate response
    response_content = "Task completed."

    if llm_provider:
        try:
            response_content = await llm_provider.generate_response(
                messages=state["messages"],
                results=state["tool_results"],
                reflection=state.get("reflection"),
            )
        except Exception as e:
            logger.error(f"Response generation failed: {e}")
            response_content = f"I completed the task but encountered an issue generating the response: {e}"

    response_message = Message(
        role="assistant",
        content=response_content,
        name=None,
        tool_call_id=None,
    )

    return {"messages": [response_message]}


# Helper functions




