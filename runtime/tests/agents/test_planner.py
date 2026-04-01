from types import SimpleNamespace

import pytest

from src.agents.planner import PlannerAgent
from src.orchestrator.context import AgentConfig, RuntimeSessionContext, SubAgentDefinition, ToolDefinition
from src.orchestrator.state import create_initial_state


@pytest.mark.asyncio
async def test_planner_build_context_includes_sub_agent_summaries():
    planner = PlannerAgent(
        config=AgentConfig(id="planner", name="Planner"),
        llm_provider=SimpleNamespace(),
    )
    runtime_context = RuntimeSessionContext(
        user_id="user-1",
        agent_id="agent-1",
        session_id="session-1",
        agent_config=AgentConfig(id="agent-1", name="Primary Agent"),
        available_tools=[ToolDefinition(name="search", description="Search the web")],
        available_sub_agents=[
            SubAgentDefinition(
                id="researcher",
                name="Researcher",
                description="Research specialist",
            )
        ],
    )
    state = create_initial_state(
        session_id="session-1",
        agent_id="agent-1",
        user_message="帮我做研究",
        context=runtime_context,
    )

    context = await planner._build_planning_context(state)

    assert context["available_sub_agents"] == [
        {
            "id": "researcher",
            "name": "Researcher",
            "description": "Research specialist",
        }
    ]
