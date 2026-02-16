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
    timeout: int = 30
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
        model: str | None = None,
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
        model: str | None = None,
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
        available_sub_agents: list[dict[str, Any]] | None = None,
        agent_system_prompt: str = "",
        model: str | None = None,
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

        planning_prompt = f"""You are a task planner. Analyze the user's request and create an execution plan that uses the available tools.

IMPORTANT RULES:
1. You MUST use tools whenever the task requires actions beyond simple text answers.
2. If the user asks to generate, create, or produce a file (PDF, CSV, image, etc.), you MUST include a step that calls the "code_executor" tool with the appropriate code.
3. Only return an empty steps array if the request is a simple question that needs no tool usage.
4. If the user asks to generate a report, analysis, or summary about a topic, you MUST FIRST search for relevant up-to-date information using available search/MCP tools, THEN generate the report based on the search results. Never generate reports purely from your own knowledge — always search first.
5. Respond in the same language as the user's request. If the user writes in Chinese, your plan titles and the generated content should be in Chinese.
6. For PDF generation with Chinese content, you MUST use the CJK font: pdf.add_font('HiraginoGB', '', '/System/Library/Fonts/Hiragino Sans GB.ttc', uni=True). Do NOT use Helvetica/Times/Courier for Chinese text.
7. DEPENDENCIES & ORDERING: Think about data flow between steps. A step that consumes output from earlier steps MUST come after them and MUST have "parallel": false. Only steps with no data dependencies on each other may run in parallel. Order steps so that data producers always precede data consumers.

Available tools:
{tools_text or "No tools available."}

Memory context:
{memory or "No context."}

You MUST respond with ONLY a JSON object (no markdown fences, no extra text) with these keys:
- goal: The overall objective
- steps: Array of steps, each with id (string), title, tool (tool name string or null), params (object), parallel (bool)
- requires_delegation: Boolean if sub-agent needed
- delegate_to: Sub-agent ID if delegation needed

IMPORTANT: You MUST use the exact tool names from the "Available tools" list above. Do NOT invent tool names like "search" — use the actual name (e.g. "tavily-search", "bailian_web_search", etc.).

Example — user asks "生成一份关于AI趋势的PDF报告" (assuming "tavily-search" is available):
"""
        # Build the example JSON separately to avoid f-string escaping hell.
        # Use real newlines so json.dumps produces clean \n escapes in the JSON,
        # preventing the LLM from seeing garbled escape sequences and generating
        # code with mismatched quotes (e.g. 'HiraginoGB").
        example_code = (
            "from fpdf import FPDF\n"
            "pdf = FPDF()\n"
            "pdf.add_page()\n"
            "pdf.add_font('HiraginoGB', '', '/System/Library/Fonts/Hiragino Sans GB.ttc', uni=True)\n"
            "pdf.set_font('HiraginoGB', size=18)\n"
            "pdf.cell(200, 10, text='AI趋势报告', new_x='LMARGIN', new_y='NEXT', align='C')\n"
            "pdf.set_font('HiraginoGB', size=12)\n"
            "pdf.multi_cell(0, 8, text='根据搜索结果整理的AI趋势...')\n"
            "pdf.output('ai_trends_report.pdf')\n"
            "print('PDF generated')"
        )
        import json as _json
        example_json = _json.dumps({
            "goal": "搜索最新AI趋势信息并生成中文PDF报告",
            "steps": [
                {"id": "1", "title": "搜索最新AI趋势信息", "tool": "tavily-search",
                 "params": {"query": "2024 2025 AI trends latest developments"}, "parallel": False},
                {"id": "2", "title": "使用code_executor生成中文PDF报告", "tool": "code_executor",
                 "params": {"language": "python", "code": example_code}, "parallel": False},
            ],
            "requires_delegation": False,
            "delegate_to": None,
        }, ensure_ascii=False)
        planning_prompt += example_json + "\n"

        # Inject sub-agent candidates into planning prompt
        if available_sub_agents:
            sa_lines = []
            for sa in available_sub_agents:
                sa_lines.append(f"- {sa['name']} (id: {sa['id']}): {sa['description']}")
            sub_agents_text = "\n".join(sa_lines)
            planning_prompt += f"""
Available specialized agents for delegation:
{sub_agents_text}

DELEGATION RULES:
- ALWAYS prefer using your own tools first. Only delegate when:
  1. The task clearly requires expertise that a specialized agent has but you don't
  2. Your available tools cannot accomplish the task
  3. A specialized agent's description explicitly matches the task domain
- Set requires_delegation=true and delegate_to=<agent_id> ONLY when delegating
- You can only delegate to ONE agent per plan
- Do NOT delegate simple questions or tasks your tools can handle
"""

        # Inject Agent system_prompt as persona prefix
        if agent_system_prompt:
            planning_prompt = f"{agent_system_prompt}\n\n---\n\n{planning_prompt}"

        system_message = {"role": "system", "content": planning_prompt}
        all_messages = [system_message] + messages

        response = await self.chat(
            messages=all_messages,
            temperature=0.3,
            model=model,
        )

        # Parse JSON response — extract JSON from content which may contain
        # markdown fences or surrounding text from thinking models.
        # We also capture the non-JSON text as "_thinking" so the caller
        # can emit it as the LLM's reasoning process.
        import json
        import re

        text = response.content.strip()

        def _extract_thinking(full_text: str, json_span: tuple[int, int]) -> str:
            """Extract non-JSON text as thinking content."""
            before = full_text[:json_span[0]].strip()
            after = full_text[json_span[1]:].strip()
            parts = [p for p in (before, after) if p]
            return "\n\n".join(parts)

        # Try direct parse first
        try:
            result = json.loads(text)
            # Entire text is JSON, no thinking content
            result["_thinking"] = ""
            return result
        except json.JSONDecodeError:
            pass
        # Try extracting from markdown code fence
        m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
        if m:
            try:
                result = json.loads(m.group(1))
                result["_thinking"] = _extract_thinking(text, m.span())
                return result
            except json.JSONDecodeError:
                pass
        # Try finding first { ... } block
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            try:
                result = json.loads(m.group(0))
                result["_thinking"] = _extract_thinking(text, m.span())
                return result
            except json.JSONDecodeError:
                pass
        return {"goal": "", "steps": [], "error": "Failed to parse plan", "_thinking": ""}

    async def generate_response(
        self,
        messages: list[dict[str, str]],
        results: list[Any] | None = None,
        reflection: Any = None,
        agent_system_prompt: str = "",
        model: str | None = None,
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

        base_prompt = agent_system_prompt or "You are a helpful assistant."
        system_message = {
            "role": "system",
            "content": f"""{base_prompt}

---

Generate a helpful response to the user based on the execution results.

{context}

Be concise but informative. If there were errors, explain what happened and suggest alternatives.
""",
        }

        all_messages = [system_message] + messages

        response = await self.chat(messages=all_messages, temperature=0.7, model=model)
        return response.content

    async def generate_response_stream(
        self,
        messages: list[dict[str, str]],
        results: list[Any] | None = None,
        reflection: Any = None,
        agent_system_prompt: str = "",
        model: str | None = None,
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

        base_prompt = agent_system_prompt or "You are a helpful assistant."
        system_message = {
            "role": "system",
            "content": f"""{base_prompt}

---

Generate a helpful response to the user based on the execution results.

{context}

Be concise but informative. If there were errors, explain what happened and suggest alternatives.
""",
        }

        all_messages = [system_message] + messages

        async for chunk in self.chat_stream(messages=all_messages, temperature=0.7, model=model):
            yield chunk

    async def reflect(
        self,
        messages: list[dict[str, str]],
        plan: Any | None = None,
        results: list[Any] | None = None,
        agent_system_prompt: str = "",
        model: str | None = None,
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

        # Inject Agent system_prompt as persona prefix
        if agent_system_prompt:
            prompt = f"{agent_system_prompt}\n\n---\n\n{prompt}"

        response = await self.chat(
            messages=[{"role": "system", "content": prompt}] + messages,
            temperature=0.5,
            model=model,
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
