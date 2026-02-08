"""Planner Agent implementation.

The PlannerAgent is responsible for analyzing user requests and generating
execution plans. It breaks down complex tasks into actionable steps.

NOTE: This is a standalone Agent class implementation. The current runtime
uses the plan_node() function in orchestrator/nodes.py for LangGraph integration.
This class is kept as an alternative implementation for non-graph execution modes.
"""

from typing import Any

from src.agents.base import AgentConfig, BaseAgent
from src.orchestrator.execution import parse_plan_response
from src.orchestrator.state import AgentState, ExecutionPlan, Message, PlanStep
from src.utils.logging import get_logger

logger = get_logger(__name__)


PLANNER_SYSTEM_PROMPT = """You are an expert planning agent. Your role is to analyze user requests
and create detailed, actionable execution plans.

When creating a plan:
1. Understand the user's goal clearly
2. Break down the task into discrete, executable steps
3. Identify which tools/skills are needed for each step
4. Determine if steps can be executed in parallel
5. Consider potential failure modes and alternatives

Output your plan in the following JSON format:
{
    "goal": "The overall objective",
    "analysis": "Your analysis of the request",
    "steps": [
        {
            "id": "step_1",
            "title": "Step description",
            "tool": "tool_name or null",
            "params": {"key": "value"},
            "parallel": false,
            "rationale": "Why this step is needed"
        }
    ],
    "requires_delegation": false,
    "delegate_to": null
}

If the request is a simple question that doesn't require tools, return:
{
    "goal": "Answer the question",
    "analysis": "This is a simple question",
    "steps": [],
    "direct_response": "Your answer here"
}
"""


class PlannerAgent(BaseAgent):
    """
    Agent specialized in planning and task decomposition.

    The PlannerAgent analyzes user requests and generates structured
    execution plans. It can:
    - Break complex tasks into steps
    - Identify required tools/skills
    - Detect parallelizable operations
    - Recommend delegation to sub-agents
    """

    def __init__(
        self,
        config: AgentConfig | None = None,
        llm_provider: Any = None,
        skill_registry: Any = None,
        memory_system: Any = None,
    ):
        """
        Initialize the PlannerAgent.

        Args:
            config: Agent configuration (uses defaults if not provided)
            llm_provider: LLM provider for plan generation
            skill_registry: Registry of available skills
            memory_system: Memory system for context
        """
        if config is None:
            config = AgentConfig(
                id="planner",
                name="Planner Agent",
                description="Analyzes requests and generates execution plans",
                system_prompt=PLANNER_SYSTEM_PROMPT,
                model="gpt-4o",
                temperature=0.3,  # Lower temperature for more consistent planning
            )

        super().__init__(config, llm_provider, skill_registry, memory_system)

    async def execute(self, state: AgentState) -> AgentState:
        """
        Execute the planning logic.

        This method:
        1. Extracts the user's request from messages
        2. Gathers context (available skills, memory)
        3. Generates an execution plan using the LLM
        4. Parses and validates the plan
        5. Updates the state with the plan

        Args:
            state: Current agent state

        Returns:
            Updated state with execution plan
        """
        logger.info(
            "PlannerAgent executing",
            extra={"session_id": state["session_id"]},
        )

        # Get the latest user message
        user_message = self._get_latest_user_message(state["messages"])
        if not user_message:
            return {
                **state,
                "error": "No user message found",
                "current_step": "respond",
            }

        # Build planning context
        context = await self._build_planning_context(state)

        # Generate plan using LLM
        plan = await self._generate_plan(user_message, context)

        if plan is None:
            return {
                **state,
                "error": "Failed to generate plan",
                "current_step": "respond",
            }

        # Determine next step based on plan
        if not plan.steps:
            next_step = "respond"
        elif plan.requires_delegation:
            next_step = "delegate"
        else:
            next_step = "act"

        return {
            **state,
            "plan": plan,
            "pending_actions": plan.steps,
            "current_step": next_step,
        }

    def _get_latest_user_message(self, messages: list[Message]) -> str | None:
        """Extract the latest user message from the conversation."""
        for message in reversed(messages):
            if message["role"] == "user":
                return message["content"]
        return None

    async def _build_planning_context(self, state: AgentState) -> dict[str, Any]:
        """Build the context for planning."""
        context: dict[str, Any] = {
            "memory": state.get("memory_context", ""),
            "available_skills": [],
        }

        # Get available skills from RuntimeSessionContext if available
        runtime_context = state.get("context")
        if runtime_context:
            from src.orchestrator.capability import CapabilityGraph

            capability_graph = CapabilityGraph(runtime_context)
            context["available_skills"] = capability_graph.get_schemas_for_planner()

            logger.info(
                "Using CapabilityGraph for planning",
                extra={
                    "session_id": state["session_id"],
                    "capability_count": len(context["available_skills"]),
                },
            )
        elif self.skill_registry:
            # Fallback to skill_registry for backward compatibility
            context["available_skills"] = self.skill_registry.get_all_schemas()
            logger.warning(
                "Using skill_registry fallback (no RuntimeSessionContext)",
                extra={"session_id": state.get("session_id")},
            )

        return context

    async def _generate_plan(
        self,
        user_message: str,
        context: dict[str, Any],
    ) -> ExecutionPlan | None:
        """Generate an execution plan using the LLM."""
        if not self.llm_provider:
            logger.error("No LLM provider configured")
            return None

        # Build the prompt
        skills_text = self._format_skills(context.get("available_skills", []))
        memory_text = context.get("memory", "")

        messages = [
            {"role": "system", "content": self.system_prompt},
            {
                "role": "user",
                "content": f"""
User Request: {user_message}

Available Tools/Skills:
{skills_text}

Relevant Context:
{memory_text}

Please analyze this request and create an execution plan.
""",
            },
        ]

        try:
            response = await self.llm_provider.chat(
                messages=messages,
                temperature=self.config.temperature,
                response_format={"type": "json_object"},
            )

            # Parse the response
            return parse_plan_response(response)

        except Exception as e:
            logger.error(f"Plan generation failed: {e}")
            return None

    def _format_skills(self, skills: list[dict[str, Any]]) -> str:
        """Format skills list for the prompt."""
        if not skills:
            return "No tools available."

        lines = []
        for skill in skills:
            name = skill.get("name", "unknown")
            description = skill.get("description", "No description")
            lines.append(f"- {name}: {description}")

        return "\n".join(lines)
