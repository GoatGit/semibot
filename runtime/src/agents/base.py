"""Base Agent abstract class.

All Agent implementations should inherit from this base class.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from src.orchestrator.state import AgentState


@dataclass
class AgentConfig:
    """Configuration for an Agent."""

    id: str
    name: str
    description: str = ""
    system_prompt: str = ""
    model: str = "gpt-4o"
    fallback_model: str = "gpt-4o-mini"
    temperature: float = 0.7
    max_tokens: int = 4096
    skills: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


class BaseAgent(ABC):
    """
    Abstract base class for all Agent implementations.

    Agents are the core execution units in the Semibot runtime. Each Agent
    can be configured with different capabilities (skills), prompts, and
    models to handle specific types of tasks.

    Attributes:
        config: The Agent's configuration
        llm_provider: LLM provider for text generation
        skill_registry: Registry of available skills
        memory_system: Memory system for context management

    Example:
        ```python
        class MyCustomAgent(BaseAgent):
            async def execute(self, state: AgentState) -> AgentState:
                # Custom execution logic
                return state
        ```
    """

    def __init__(
        self,
        config: AgentConfig,
        llm_provider: Any = None,
        skill_registry: Any = None,
        memory_system: Any = None,
    ):
        """
        Initialize the Agent.

        Args:
            config: Agent configuration
            llm_provider: LLM provider for text generation
            skill_registry: Registry of available skills
            memory_system: Memory system for context management
        """
        self.config = config
        self.llm_provider = llm_provider
        self.skill_registry = skill_registry
        self.memory_system = memory_system

    @property
    def id(self) -> str:
        """Get the Agent ID."""
        return self.config.id

    @property
    def name(self) -> str:
        """Get the Agent name."""
        return self.config.name

    @property
    def system_prompt(self) -> str:
        """Get the Agent's system prompt."""
        return self.config.system_prompt

    @abstractmethod
    async def execute(self, state: AgentState) -> AgentState:
        """
        Execute the Agent's logic.

        This is the main entry point for Agent execution. Subclasses must
        implement this method to define their specific behavior.

        Args:
            state: The current agent state

        Returns:
            Updated agent state after execution
        """
        pass

    async def pre_execute(self, state: AgentState) -> AgentState:
        """
        Hook called before main execution.

        Override this method to add pre-processing logic.

        Args:
            state: The current agent state

        Returns:
            Potentially modified agent state
        """
        return state

    async def post_execute(self, state: AgentState) -> AgentState:
        """
        Hook called after main execution.

        Override this method to add post-processing logic.

        Args:
            state: The current agent state

        Returns:
            Potentially modified agent state
        """
        return state

    async def run(self, state: AgentState) -> AgentState:
        """
        Run the complete Agent execution pipeline.

        This method orchestrates the full execution flow:
        1. pre_execute hook
        2. main execute method
        3. post_execute hook

        Args:
            state: The initial agent state

        Returns:
            Final agent state after complete execution
        """
        state = await self.pre_execute(state)
        state = await self.execute(state)
        state = await self.post_execute(state)
        return state

    def get_available_skills(self) -> list[str]:
        """
        Get the list of skills available to this Agent.

        Returns:
            List of skill names
        """
        return self.config.skills

    def has_skill(self, skill_name: str) -> bool:
        """
        Check if this Agent has access to a specific skill.

        Args:
            skill_name: Name of the skill to check

        Returns:
            True if the Agent has access to the skill
        """
        return skill_name in self.config.skills

    def to_dict(self) -> dict[str, Any]:
        """
        Convert the Agent to a dictionary representation.

        Returns:
            Dictionary containing Agent configuration
        """
        return {
            "id": self.config.id,
            "name": self.config.name,
            "description": self.config.description,
            "model": self.config.model,
            "skills": self.config.skills,
        }
