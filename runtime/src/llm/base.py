"""Base LLM Provider abstract interface.

All LLM provider implementations should inherit from this base class.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, AsyncIterator


@dataclass
class LLMResponse:
    """Response from an LLM call."""

    content: str
    model: str
    usage: dict[str, int] = field(default_factory=dict)
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    finish_reason: str = "stop"
    raw_response: Any = None

    @property
    def tokens_input(self) -> int:
        """Get input token count."""
        return self.usage.get("prompt_tokens", 0)

    @property
    def tokens_output(self) -> int:
        """Get output token count."""
        return self.usage.get("completion_tokens", 0)

    @property
    def tokens_total(self) -> int:
        """Get total token count."""
        return self.usage.get("total_tokens", self.tokens_input + self.tokens_output)


@dataclass
class LLMConfig:
    """Configuration for an LLM provider."""

    model: str
    api_key: str | None = None
    base_url: str | None = None
    temperature: float = 0.7
    max_tokens: int = 4096
    timeout: int = 60
    max_retries: int = 3


class LLMProvider(ABC):
    """
    Abstract base class for LLM providers.

    All LLM provider implementations (OpenAI, Anthropic, etc.) should
    inherit from this class and implement the required methods.

    Example:
        ```python
        class MyProvider(LLMProvider):
            async def chat(self, messages, **kwargs):
                # Implementation
                pass
        ```
    """

    def __init__(self, config: LLMConfig):
        """
        Initialize the LLM provider.

        Args:
            config: Provider configuration
        """
        self.config = config

    @property
    def model(self) -> str:
        """Get the model name."""
        return self.config.model

    def _validate_messages(self, messages: list[dict[str, str]]) -> None:
        """
        Validate messages list before sending to LLM.

        Args:
            messages: List of message dicts

        Raises:
            ValueError: If messages is empty or invalid
        """
        if not messages:
            raise ValueError("messages cannot be empty")

        for i, msg in enumerate(messages):
            if not isinstance(msg, dict):
                raise ValueError(f"Message {i} must be a dict, got {type(msg).__name__}")
            if "role" not in msg:
                raise ValueError(f"Message {i} missing 'role' field")
            if "content" not in msg and "tool_calls" not in msg:
                raise ValueError(f"Message {i} missing 'content' field")

    @abstractmethod
    async def chat(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        response_format: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> LLMResponse:
        """
        Send a chat completion request.

        Args:
            messages: List of message dicts with 'role' and 'content'
            tools: Optional list of tool definitions
            temperature: Override default temperature
            max_tokens: Override default max_tokens
            response_format: Optional response format (e.g., {"type": "json_object"})
            **kwargs: Additional provider-specific arguments

        Returns:
            LLMResponse containing the model's response
        """
        pass

    @abstractmethod
    async def chat_stream(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[str]:
        """
        Send a streaming chat completion request.

        Args:
            messages: List of message dicts with 'role' and 'content'
            tools: Optional list of tool definitions
            temperature: Override default temperature
            max_tokens: Override default max_tokens
            **kwargs: Additional provider-specific arguments

        Yields:
            String chunks of the response
        """
        pass

    async def generate_plan(
        self,
        messages: list[dict[str, str]],
        memory: str = "",
        available_tools: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """
        Generate an execution plan from user messages.

        Args:
            messages: Conversation messages
            memory: Memory context
            available_tools: List of available tools

        Returns:
            Plan dictionary with goal and steps
        """
        # Build planning prompt
        tools_text = ""
        if available_tools:
            tool_lines = []
            for t in available_tools:
                # Support both flat {"name": ...} and nested {"function": {"name": ...}} formats
                func = t.get("function", {})
                name = func.get("name") or t.get("name", "unknown")
                desc = func.get("description") or t.get("description", "")
                tool_lines.append(f"- {name}: {desc}")
            tools_text = "\n".join(tool_lines)

        planning_prompt = f"""Analyze the user's request and create an execution plan.

Available tools:
{tools_text or "No tools available."}

Memory context:
{memory or "No context."}

You MUST respond with ONLY a JSON object (no markdown fences, no extra text) with these keys:
- goal: The overall objective
- steps: Array of steps, each with id, title, tool (or null), params, parallel (bool)
- requires_delegation: Boolean if sub-agent needed
- delegate_to: Sub-agent ID if delegation needed
"""

        system_message = {"role": "system", "content": planning_prompt}
        all_messages = [system_message] + messages

        response = await self.chat(
            messages=all_messages,
            temperature=0.3,
        )

        # Parse JSON response — extract JSON from content which may contain
        # markdown fences or surrounding text from thinking models.
        import json
        import re

        text = response.content.strip()
        # Try direct parse first
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass
        # Try extracting from markdown code fence
        m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(1))
            except json.JSONDecodeError:
                pass
        # Try finding first { ... } block
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                pass
        return {"goal": "", "steps": [], "error": "Failed to parse plan"}

    async def generate_response(
        self,
        messages: list[dict[str, str]],
        results: list[Any] | None = None,
        reflection: Any = None,
    ) -> str:
        """
        Generate a final response to the user.

        Args:
            messages: Conversation messages
            results: Tool execution results
            reflection: Reflection summary

        Returns:
            Response text
        """
        # Build context with results
        context_parts = []
        if results:
            results_text = "\n".join(
                f"- {r.tool_name}: {r.result if r.success else r.error}"
                for r in results
            )
            context_parts.append(f"Execution results:\n{results_text}")

        if reflection:
            context_parts.append(f"Reflection: {reflection.summary}")

        context = "\n\n".join(context_parts)

        system_message = {
            "role": "system",
            "content": f"""Generate a helpful response to the user based on the execution results.

{context}

Be concise but informative. If there were errors, explain what happened and suggest alternatives.
""",
        }

        all_messages = [system_message] + messages

        response = await self.chat(messages=all_messages, temperature=0.7)
        return response.content

    async def generate_response_stream(
        self,
        messages: list[dict[str, str]],
        results: list[Any] | None = None,
        reflection: Any = None,
    ) -> AsyncIterator[str]:
        """
        Generate a final response to the user, streaming token by token.

        Args:
            messages: Conversation messages
            results: Tool execution results
            reflection: Reflection summary

        Yields:
            String chunks of the response
        """
        # Build context with results (same as generate_response)
        context_parts = []
        if results:
            results_text = "\n".join(
                f"- {r.tool_name}: {r.result if r.success else r.error}"
                for r in results
            )
            context_parts.append(f"Execution results:\n{results_text}")

        if reflection:
            context_parts.append(f"Reflection: {reflection.summary}")

        context = "\n\n".join(context_parts)

        system_message = {
            "role": "system",
            "content": f"""Generate a helpful response to the user based on the execution results.

{context}

Be concise but informative. If there were errors, explain what happened and suggest alternatives.
""",
        }

        all_messages = [system_message] + messages

        async for chunk in self.chat_stream(messages=all_messages, temperature=0.7):
            yield chunk

    async def reflect(
        self,
        messages: list[dict[str, str]],
        plan: Any | None = None,
        results: list[Any] | None = None,
    ) -> dict[str, Any]:
        """
        Generate a reflection on the execution.

        Args:
            messages: Conversation messages
            plan: The execution plan
            results: Tool execution results

        Returns:
            Reflection dictionary
        """
        # Build reflection prompt
        prompt = """Reflect on this task execution. Analyze what was accomplished,
what could be improved, and if there are valuable insights to remember.

You MUST respond with ONLY a JSON object (no markdown fences, no extra text) with these keys:
- summary: Brief summary of what was accomplished
- lessons_learned: Array of key lessons
- worth_remembering: Boolean if this should be stored in memory
- importance: Float 0-1 indicating importance
"""

        response = await self.chat(
            messages=[{"role": "system", "content": prompt}] + messages,
            temperature=0.5,
        )

        import json
        import re

        text = response.content.strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass
        m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(1))
            except json.JSONDecodeError:
                pass
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                pass
        return {
            "summary": "Task completed.",
            "lessons_learned": [],
            "worth_remembering": False,
            "importance": 0.5,
        }

    async def health_check(self) -> bool:
        """
        Check if the provider is healthy.

        Returns:
            True if the provider is working correctly
        """
        try:
            response = await self.chat(
                messages=[{"role": "user", "content": "Hello"}],
                max_tokens=10,
            )
            return bool(response.content)
        except Exception:
            return False
