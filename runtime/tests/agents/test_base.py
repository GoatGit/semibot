"""Tests for agent base classes."""

import pytest

from src.agents.base import AgentConfig, BaseAgent


class TestAgentConfig:
    """Tests for AgentConfig dataclass."""

    def test_create_config(self):
        """Test creating an agent config."""
        config = AgentConfig(
            name="test_agent",
            description="A test agent",
            system_prompt="You are helpful.",
        )

        assert config.name == "test_agent"
        assert config.description == "A test agent"
        assert config.system_prompt == "You are helpful."

    def test_config_default_values(self):
        """Test default values."""
        config = AgentConfig(name="simple")

        assert config.description == ""
        assert config.system_prompt == ""
        assert config.skills == []
        assert config.max_iterations == 10


class TestBaseAgent:
    """Tests for BaseAgent abstract class."""

    def test_agent_properties(self, sample_agent_config):
        """Test agent properties from config."""

        class TestAgent(BaseAgent):
            async def execute(self, state):
                return state

        agent = TestAgent(config=sample_agent_config)

        assert agent.name == "test_agent"
        assert agent.description == "A test agent"

    def test_agent_to_dict(self, sample_agent_config):
        """Test agent serialization."""

        class TestAgent(BaseAgent):
            async def execute(self, state):
                return state

        agent = TestAgent(config=sample_agent_config)
        data = agent.to_dict()

        assert data["name"] == "test_agent"
        assert "description" in data

    def test_has_skill(self, sample_agent_config):
        """Test skill checking."""
        config = AgentConfig(
            name="skilled_agent",
            skills=["search", "calculate"],
        )

        class TestAgent(BaseAgent):
            async def execute(self, state):
                return state

        agent = TestAgent(config=config)

        assert agent.has_skill("search") is True
        assert agent.has_skill("unknown") is False

    def test_get_available_skills(self, sample_agent_config):
        """Test getting available skills."""
        config = AgentConfig(
            name="skilled_agent",
            skills=["search", "calculate"],
        )

        class TestAgent(BaseAgent):
            async def execute(self, state):
                return state

        agent = TestAgent(config=config)
        skills = agent.get_available_skills()

        assert "search" in skills
        assert "calculate" in skills

    @pytest.mark.asyncio
    async def test_run_lifecycle(self, sample_agent_config, sample_agent_state):
        """Test agent run lifecycle (pre_execute -> execute -> post_execute)."""
        lifecycle = []

        class TestAgent(BaseAgent):
            async def pre_execute(self, state):
                lifecycle.append("pre")
                return state

            async def execute(self, state):
                lifecycle.append("execute")
                return state

            async def post_execute(self, state):
                lifecycle.append("post")
                return state

        agent = TestAgent(config=sample_agent_config)
        await agent.run(sample_agent_state)

        assert lifecycle == ["pre", "execute", "post"]

    @pytest.mark.asyncio
    async def test_run_without_hooks(self, sample_agent_config, sample_agent_state):
        """Test agent run without pre/post hooks."""

        class TestAgent(BaseAgent):
            async def execute(self, state):
                return {**state, "executed": True}

        agent = TestAgent(config=sample_agent_config)
        result = await agent.run(sample_agent_state)

        assert result.get("executed") is True
