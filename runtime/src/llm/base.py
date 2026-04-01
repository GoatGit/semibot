"""Base LLM Provider abstract interface.

All LLM provider implementations should inherit from this base class.
"""

from abc import ABC, abstractmethod
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
import json
import os
from pathlib import Path
from typing import Any, AsyncIterator

from src.memory.service import prepare_memory_context_for_prompt
from src.utils.logging import get_logger

logger = get_logger(__name__)

_RESPONSE_CONTEXT_MAX_CHARS = 12000
_RESPONSE_RESULT_MAX_ITEMS = 10
_RESPONSE_RESULT_ITEM_MAX_CHARS = 900
_RESPONSE_MESSAGE_MAX_CHARS = 3000
_RESPONSE_MEMORY_MAX_CHARS = 4000


def _truncate_text(value: str, limit: int) -> str:
    text = str(value or "")
    if len(text) <= limit:
        return text
    return text[:limit] + "... (truncated)"


def _compact_jsonish(value: Any, depth: int = 0) -> Any:
    if depth >= 2:
        if isinstance(value, str):
            return _truncate_text(value, 240)
        return str(value)
    if isinstance(value, Mapping):
        out: dict[str, Any] = {}
        for idx, (k, v) in enumerate(value.items()):
            if idx >= 8:
                out["..."] = f"+{len(value) - 8} more keys"
                break
            out[str(k)] = _compact_jsonish(v, depth + 1)
        return out
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        items = list(value)
        compact = [_compact_jsonish(item, depth + 1) for item in items[:5]]
        if len(items) > 5:
            compact.append(f"... +{len(items) - 5} more items")
        return compact
    if isinstance(value, str):
        return _truncate_text(value, 400)
    return value


def _summarize_result_for_response(result: Any) -> str:
    payload = getattr(result, "result", None) if hasattr(result, "result") else result
    error = getattr(result, "error", None) if hasattr(result, "error") else None
    success = bool(getattr(result, "success", False)) if hasattr(result, "success") else error in (None, "")
    metadata = getattr(result, "metadata", None) if hasattr(result, "metadata") else None

    selected = payload if success else error
    
    extra_text = ""
    if success and isinstance(metadata, dict):
        text_artifact = metadata.get("text_artifact")
        if isinstance(text_artifact, dict) and text_artifact.get("artifact_result_text"):
            extra_text = "\n[Extracted Document/Text]:\n" + str(text_artifact.get("artifact_result_text"))

    limit = 4000 if extra_text else _RESPONSE_RESULT_ITEM_MAX_CHARS

    if isinstance(selected, str):
        return _truncate_text(selected + extra_text, limit)
    if isinstance(selected, Mapping) or (isinstance(selected, Sequence) and not isinstance(selected, (str, bytes, bytearray))):
        try:
            compact = _compact_jsonish(selected)
            return _truncate_text(json.dumps(compact, ensure_ascii=False) + extra_text, limit)
        except Exception:
            return _truncate_text(str(selected) + extra_text, limit)
    return _truncate_text(str(selected) + extra_text, limit)


def _build_response_context(
    *,
    results: list[Any] | None,
    reflection: Any,
    memory_context: str,
) -> str:
    context_parts: list[str] = []
    total_chars = 0

    def _append_block(label: str, content: str) -> None:
        nonlocal total_chars
        if not content:
            return
        block = f"{label}\n{content}"
        remaining = _RESPONSE_CONTEXT_MAX_CHARS - total_chars
        if remaining <= 0:
            return
        if len(block) > remaining:
            block = _truncate_text(block, max(remaining - 20, 80))
        context_parts.append(block)
        total_chars += len(block) + 2

    compact_memory_context = prepare_memory_context_for_prompt(
        memory_context,
        max_chars=_RESPONSE_MEMORY_MAX_CHARS,
    )
    if compact_memory_context:
        _append_block("Conversation memory:", compact_memory_context)

    if results:
        result_lines: list[str] = []
        for item in results[:_RESPONSE_RESULT_MAX_ITEMS]:
            tool_name = getattr(item, "tool_name", None) or getattr(item, "tool", None) or "tool"
            result_lines.append(f"- {tool_name}: {_summarize_result_for_response(item)}")
        if len(results) > _RESPONSE_RESULT_MAX_ITEMS:
            result_lines.append(f"- ... {len(results) - _RESPONSE_RESULT_MAX_ITEMS} more tool results omitted")
        _append_block("Execution results:", "\n".join(result_lines))

    if reflection:
        summary = getattr(reflection, "summary", None)
        if summary:
            _append_block("Reflection:", _truncate_text(str(summary), 2000))

    return "\n\n".join(context_parts)


def _unwrap_exception(exc: Exception) -> Exception:
    current: Exception | None = exc
    visited: set[int] = set()
    while current is not None and id(current) not in visited:
        visited.add(id(current))
        if current.__class__.__name__ == "RetryError":
            last_attempt = getattr(current, "last_attempt", None)
            if last_attempt is not None and hasattr(last_attempt, "exception"):
                try:
                    inner = last_attempt.exception()
                except Exception:
                    inner = None
                if isinstance(inner, Exception):
                    current = inner
                    continue
        if isinstance(getattr(current, "__cause__", None), Exception):
            current = current.__cause__
            continue
        if isinstance(getattr(current, "__context__", None), Exception):
            current = current.__context__
            continue
        break
    return current or exc


def _filter_messages_for_final_response(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Keep final-response conversation context focused on user intent.

    Runtime-generated assistant messages often contain replan instructions,
    failure summaries, or internal progress text. Feeding them back into the
    final response model causes it to echo internal execution chatter. For the
    final user-facing answer, prefer recent user turns plus memory/results.
    """
    conversation = [m for m in messages if m.get("role") == "user"]
    trimmed = conversation[-6:] if len(conversation) > 6 else conversation
    return [
        {**m, "content": _truncate_text(str(m.get("content") or ""), _RESPONSE_MESSAGE_MAX_CHARS)}
        for m in trimmed
    ]


@dataclass
class LLMResponse:
    """Response from an LLM call."""

    content: str
    model: str
    usage: dict[str, int] = field(default_factory=dict)
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    finish_reason: str = "stop"
    reasoning_content: str | None = None
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
    provider_base: str | None = None
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

    def _dump_plan_prompt_snapshot(
        self,
        *,
        debug_meta: dict[str, Any] | None,
        planning_prompt: str,
        all_messages: list[dict[str, Any]],
        available_tools: list[dict[str, Any]] | None,
        available_sub_agents: list[dict[str, Any]] | None,
        memory: str,
        model: str | None,
    ) -> str:
        enabled = str(os.getenv("SEMIBOT_DUMP_PLAN_PROMPTS", "true")).strip().lower() not in {"0", "false", "no"}
        if not enabled:
            return ""
        dump_dir = Path(
            os.getenv("SEMIBOT_PLAN_PROMPT_DUMP_DIR", "~/.semibot/debug/plan-prompts")
        ).expanduser()

        meta = dict(debug_meta or {})
        session_id = str(meta.get("session_id") or "unknown")
        phase = str(meta.get("phase") or "plan")
        iteration = str(meta.get("iteration") or "0")
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        filename = f"{timestamp}_{session_id}_iter{iteration}_{phase}.json"
        target = dump_dir / filename

        payload = {
            "timestamp": datetime.now().isoformat(),
            "meta": meta,
            "model": model or self.model,
            "system_prompt": planning_prompt,
            "messages": all_messages,
            "memory": memory,
            "available_tools": available_tools or [],
            "available_sub_agents": available_sub_agents or [],
        }
        try:
            dump_dir.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError as exc:
            logger.warning("plan_prompt_snapshot_dump_failed", extra={"path": str(target), "error": str(exc)})
            return ""
        return str(target)

    @abstractmethod
    async def chat(
        self,
        messages: list[dict[str, str]],
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        response_format: dict[str, Any] | None = None,
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
            response_format: Optional response format (e.g., {"type": "json_object"} or {"type": "json_schema", ...})
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
        debug_meta: dict[str, Any] | None = None,
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
        tools_text = self._format_planner_tools(available_tools or [])

        from datetime import datetime
        today_str = datetime.now().strftime("%Y年%m月%d日")

        planning_prompt = f"""You are a task planner. Analyze the user's request and create an execution plan that uses the available tools.

Current date: {today_str}

IMPORTANT RULES:
1. Planning and execution are separate. Plan semantic steps only; act/execution will decide concrete tool calls later.
2. Do not answer the user directly from the planner. If no further execution is needed, use terminate instead.
3. If the task requires tools, skills, artifact outputs, or multi-step verification, do NOT output terminate prematurely.
4. Your plan must capture workflow semantics: phase, intent, expected outputs, and completion criteria.
5. If the user asks to generate a report, analysis, or summary about a topic, the plan must include evidence gathering before synthesis. Never plan a report that relies purely on model memory.
6. Respond in the same language as the user's request. If the user writes in Chinese, your plan titles/intents should be in Chinese.
7. DEPENDENCIES & ORDERING: Think about data flow between steps. A step that consumes outputs from earlier steps must come after them and should normally have "parallel": false. Only truly independent steps with zero data dependencies may use "parallel": true.
8. FRESHNESS FOR "LATEST/RECENT": If the user asks for latest/recent/today news or trends, reflect freshness requirements in the step intent and expected outputs (for example date-constrained evidence and publication dates).
9. QUANTITATIVE COVERAGE: If the user asks for year-range/period data (e.g. "近N年", "过去N年", "last N years"), the plan must explicitly require enough period-structured evidence in expected_outputs/completion_criteria.
10. WEBSITE INTERACTION: If the user asks to visit/open a website, click/submit form, login, or extract content from a webpage and browser tools are available, make that interaction explicit in the step intent.
11. ONE ROUND, ONE PRIMARY SKILL: at most one primary skill may be selected for this planning session. Do not plan execution around more than one skill in the same round.
12. If a skill is strongly relevant, you must load and follow that skill before producing a skill-based plan. Do not skip directly to generic planning when a strong skill match exists.
13. DELEGATION IN V1 IS FULL-TASK HANDOFF ONLY. If delegating, do not return execution steps. Delegation ends the round when successful.
14. CAPABILITY GAP HANDLING: installation is fallback only (not default). Use it only when there is a clear capability gap after trying available tools/skills first.
   If installation is required, express it as a semantic step whose intent explicitly states:
   - what capability is missing
   - why current tools/skills cannot satisfy it

Available tools:
{tools_text or "No tools available."}

Memory context:
{memory or "No context."}

You MUST respond with ONLY a JSON object (no markdown fences, no extra text).

Allowed top-level forms:
1. terminate
{{
  "type": "terminate",
  "goal": "...",
  "reason": "...",
  "status": "completed|blocked|no_further_action_needed",
  "summary_for_act": "..."
}}

2. semantic plan
{{
  "type": "plan",
  "goal": "...",
  "round_goal": "...",
  "selected_skill": "skill-id-or-null",
  "steps": [
    {{
      "id": "1",
      "title": "...",
      "phase": "scope|retrieve|triangulate|synthesize|package|...",
      "intent": "...",
      "expected_outputs": ["..."],
      "completion_criteria": ["..."],
      "parallel": false
    }}
  ]
}}

3. delegate (full-task handoff only)
{{
  "type": "delegate",
  "goal": "...",
  "sub_agent_id": "...",
  "context": "...",
  "expected_outputs": ["..."]
}}

Do NOT pre-bind tools or params in planner output. Tool choice belongs to the act/execution node.

Example — user asks "生成一份关于AI趋势的研究报告":
"""
        import json as _json
        example_json = _json.dumps({
            "type": "plan",
            "goal": "收集AI趋势证据并生成中文研究报告",
            "round_goal": "完成AI趋势研究的证据收集、综合分析与最终报告生成",
            "selected_skill": None,
            "steps": [
                {
                    "id": "1",
                    "title": "界定研究范围与证据标准",
                    "phase": "scope",
                    "intent": "明确研究主题、时间窗口、重点问题和来源标准",
                    "expected_outputs": ["研究范围", "关键问题", "来源标准"],
                    "completion_criteria": ["已明确时间窗口", "已列出关键问题", "已定义来源标准"],
                    "parallel": False
                },
                {
                    "id": "2",
                    "title": "收集近期AI趋势的多源证据",
                    "phase": "retrieve",
                    "intent": "获取近一年内AI趋势、关键事件和量化指标的多源证据",
                    "expected_outputs": ["多源证据集合", "来源链接", "关键数据点"],
                    "completion_criteria": ["至少覆盖多个来源域名", "包含可核对日期", "包含关键数据点"],
                    "parallel": False
                },
                {
                    "id": "3",
                    "title": "综合证据并生成最终研究报告",
                    "phase": "package",
                    "intent": "基于已收集证据输出结构化中文研究报告",
                    "expected_outputs": ["最终研究报告"],
                    "completion_criteria": ["报告已生成", "覆盖主要结论与来源"],
                    "parallel": False
                }
            ],
        }, ensure_ascii=False)
        planning_prompt += example_json + "\n"

        # Inject sub-agent candidates into planning prompt
        if available_sub_agents:
            sa_lines = []
            for sa in available_sub_agents:
                agent_id = str(sa.get("id") or "").strip()
                agent_name = str(sa.get("name") or agent_id or "unknown").strip()
                description = str(sa.get("description") or sa.get("summary") or "").strip()
                sa_lines.append(f"- {agent_name} (id: {agent_id or agent_name}): {description}")
            sub_agents_text = "\n".join(sa_lines)
            planning_prompt += f"""
Available specialized agents for delegation:
{sub_agents_text}

DELEGATION RULES:
- ALWAYS prefer planning for your own tools/skills first. Only delegate when:
  1. The entire task clearly belongs to a specialized agent
  2. Your available tools/skills cannot reasonably handle it
  3. A specialized agent's description explicitly matches the full task domain
- Delegation in V1 is FULL-TASK handoff only.
- If delegating, return type="delegate" with sub_agent_id/context/expected_outputs and do NOT return steps.
- You can only delegate to ONE agent per plan.
- Do NOT delegate simple questions or tasks your tools/skills can handle.
"""

        # Inject Agent system_prompt as persona prefix
        if agent_system_prompt:
            planning_prompt = f"{agent_system_prompt}\n\n---\n\n{planning_prompt}"

        system_message = {"role": "system", "content": planning_prompt}
        all_messages = [system_message] + messages
        prompt_dump_path = self._dump_plan_prompt_snapshot(
            debug_meta=debug_meta,
            planning_prompt=planning_prompt,
            all_messages=all_messages,
            available_tools=available_tools,
            available_sub_agents=available_sub_agents,
            memory=memory,
            model=model,
        )
        try:
            response = await self.chat(
                messages=all_messages,
                temperature=0.3,
                model=model,
            )
        except Exception as exc:
            root_exc = _unwrap_exception(exc)
            error_text = str(exc)
            root_error_text = str(root_exc)
            lowered = f"{error_text}\n{root_error_text}".lower()
            is_bad_request = (
                exc.__class__.__name__ == "BadRequestError"
                or root_exc.__class__.__name__ == "BadRequestError"
                or "400 bad request" in lowered
                or "status code 400" in lowered
                or "context length" in lowered
                or "maximum context" in lowered
            )
            if not is_bad_request:
                raise

            compact_memory = prepare_memory_context_for_prompt(memory or "", max_chars=1200)
            compact_messages = messages[-6:] if len(messages) > 6 else list(messages)
            compact_prompt = f"""You are a task planner. Create an execution plan as JSON only.

Current date: {today_str}

Rules:
1. Use only tools listed below; do not invent tool names.
2. For research/report tasks, search first, then summarize/report.
3. Keep steps semantic, executable, and ordered by dependency.
4. Output JSON object with one of the allowed forms: terminate, plan, or delegate.
5. Each semantic step must include: id, title, phase, intent, expected_outputs, completion_criteria, parallel.
6. Planner must not pre-bind tool/params for steps; tool selection happens later in act.

Available tools:
{tools_text or "No tools available."}

Memory context:
{compact_memory or "No context."}
"""
            if agent_system_prompt:
                compact_prompt = f"{agent_system_prompt}\n\n---\n\n{compact_prompt}"

            compact_system_message = {"role": "system", "content": compact_prompt}
            compact_all_messages = [compact_system_message] + compact_messages
            fallback_prompt_dump_path = self._dump_plan_prompt_snapshot(
                debug_meta={
                    **(debug_meta or {}),
                    "phase": "final_compact_retry",
                    "trigger_error": f"{error_text} | root: {root_error_text}"[:400],
                },
                planning_prompt=compact_prompt,
                all_messages=compact_all_messages,
                available_tools=available_tools,
                available_sub_agents=available_sub_agents,
                memory=compact_memory,
                model=model,
            )
            logger.warning(
                "generate_plan_retry_with_compact_prompt_after_bad_request",
                extra={
                    "error": error_text,
                    "root_error": root_error_text,
                    "original_prompt_dump_path": prompt_dump_path,
                    "fallback_prompt_dump_path": fallback_prompt_dump_path,
                },
            )
            response = await self.chat(
                messages=compact_all_messages,
                temperature=0.2,
                model=model,
            )
            if fallback_prompt_dump_path:
                prompt_dump_path = fallback_prompt_dump_path

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

        def _normalize_plan_result(parsed: Any, thinking: str) -> dict[str, Any]:
            """Normalize parsed JSON into a planner object shape."""
            if isinstance(parsed, dict):
                parsed["_thinking"] = thinking
                if prompt_dump_path:
                    parsed["_prompt_dump_path"] = prompt_dump_path
                return parsed
            return {
                "goal": "",
                "steps": [],
                "error": f"Plan must be a JSON object, got {type(parsed).__name__}",
                "_thinking": thinking,
                "_prompt_dump_path": prompt_dump_path,
            }

        # Try direct parse first
        try:
            result = json.loads(text)
            # Entire text is JSON, no thinking content.
            return _normalize_plan_result(result, "")
        except json.JSONDecodeError:
            pass
        # Try extracting from markdown code fence
        m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
        if m:
            try:
                result = json.loads(m.group(1))
                return _normalize_plan_result(result, _extract_thinking(text, m.span()))
            except json.JSONDecodeError:
                pass
        # Try finding first { ... } block
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            try:
                result = json.loads(m.group(0))
                return _normalize_plan_result(result, _extract_thinking(text, m.span()))
            except json.JSONDecodeError:
                pass
        return {
            "goal": "",
            "steps": [],
            "error": "Failed to parse plan",
            "_thinking": "",
            "_prompt_dump_path": prompt_dump_path,
        }

    def _format_planner_tools(self, tools: list[dict[str, Any]]) -> str:
        """Format planner-visible execution capability summaries."""
        if not tools:
            return ""

        lines: list[str] = []
        for item in tools:
            if not isinstance(item, dict):
                continue
            func = item.get("function", {})
            metadata = item.get("metadata", {}) if isinstance(item.get("metadata"), dict) else {}
            name = (
                func.get("name")
                or item.get("toolName")
                or item.get("display_name")
                or item.get("displayName")
                or item.get("name")
                or "unknown"
            )
            description = (
                func.get("description")
                or item.get("summary")
                or item.get("description")
                or ""
            )
            source_type = str(
                item.get("source_type")
                or item.get("sourceType")
                or metadata.get("source_type")
                or metadata.get("sourceType")
                or ""
            ).strip()
            suffix = f" [{source_type}]" if source_type else ""
            lines.append(f"- {name}{suffix}: {description}")
        return "\n".join(lines)

    async def generate_response(
        self,
        messages: list[dict[str, str]],
        results: list[Any] | None = None,
        reflection: Any = None,
        agent_system_prompt: str = "",
        model: str | None = None,
        memory_context: str = "",
        temperature: float = 0.7,
    ) -> str:
        """
        Generate a final response to the user.

        Args:
            messages: Conversation messages
            results: Tool execution results
            reflection: Reflection summary
            memory_context: Memory context from start_node (short-term + long-term)

        Returns:
            Response text
        """
        context = _build_response_context(
            results=results,
            reflection=reflection,
            memory_context=memory_context,
        )

        base_prompt = agent_system_prompt or "You are a helpful assistant."
        system_message = {
            "role": "system",
            "content": f"""{base_prompt}

---

Generate a helpful response to the user based on the conversation history and execution results.

{context}

IMPORTANT RULES:
1. Respond in the SAME LANGUAGE as the user's request. If the user writes in Chinese, you MUST respond entirely in Chinese.
2. Be detailed and informative — provide a comprehensive summary of the findings, not just a brief overview.
3. EVIDENCE GROUNDING (CRITICAL): ONLY use facts that are explicitly present in execution results. Do NOT invent numbers, prices, growth rates, dates, target prices, or analyst conclusions that are not shown in tool outputs.
4. If a requested key metric is missing from tool outputs, say it is unavailable and explicitly recommend the next data source to verify.
5. For stock/financial research, include a short "风险提示" section and avoid deterministic investment advice. Keep conclusions conditional on evidence quality and recency.
6. If tool results contain URLs or source links, you MUST include a "参考来源" (References) section at the END of your response listing all source URLs in markdown link format: [标题](url). Each link on its own line.
7. If there were errors, explain what happened and suggest alternatives.
8. If PDF/XLSX files were generated, mention them and describe ONLY sections that are explicitly present in tool outputs (no invented chapter names). If execution output contains a line like "report_summary_sections=...", you MUST use exactly those section names and MUST NOT add extra section names.
9. Use the conversation memory and history to maintain context across turns. If the user refers to something from a previous message, use the memory to answer accurately.
10. FINALITY (CRITICAL): This is the final response for the current run. Do NOT reply with promise-style text such as "我将…/稍后…/正在…/I will...". You MUST present concrete findings now.
""",
        }

        trimmed = _filter_messages_for_final_response(messages)
        all_messages = [system_message] + trimmed

        response = await self.chat(messages=all_messages, temperature=temperature, model=model)
        return response.content

    async def generate_response_stream(
        self,
        messages: list[dict[str, str]],
        results: list[Any] | None = None,
        reflection: Any = None,
        agent_system_prompt: str = "",
        model: str | None = None,
        memory_context: str = "",
        temperature: float = 0.7,
    ) -> AsyncIterator[str]:
        """
        Generate a final response to the user, streaming token by token.

        Args:
            messages: Conversation messages
            results: Tool execution results
            reflection: Reflection summary
            memory_context: Memory context from start_node (short-term + long-term)

        Yields:
            String chunks of the response
        """
        context = _build_response_context(
            results=results,
            reflection=reflection,
            memory_context=memory_context,
        )

        base_prompt = agent_system_prompt or "You are a helpful assistant."
        system_message = {
            "role": "system",
            "content": f"""{base_prompt}

---

Generate a helpful response to the user based on the conversation history and execution results.

{context}

IMPORTANT RULES:
1. Respond in the SAME LANGUAGE as the user's request. If the user writes in Chinese, you MUST respond entirely in Chinese.
2. Be detailed and informative — provide a comprehensive summary of the findings, not just a brief overview.
3. EVIDENCE GROUNDING (CRITICAL): ONLY use facts that are explicitly present in execution results. Do NOT invent numbers, prices, growth rates, dates, target prices, or analyst conclusions that are not shown in tool outputs.
4. If a requested key metric is missing from tool outputs, say it is unavailable and explicitly recommend the next data source to verify.
5. For stock/financial research, include a short "风险提示" section and avoid deterministic investment advice. Keep conclusions conditional on evidence quality and recency.
6. If tool results contain URLs or source links, you MUST include a "参考来源" (References) section at the END of your response listing all source URLs in markdown link format: [标题](url). Each link on its own line.
7. If there were errors, explain what happened and suggest alternatives.
8. If PDF/XLSX files were generated, mention them and describe ONLY sections that are explicitly present in tool outputs (no invented chapter names). If execution output contains a line like "report_summary_sections=...", you MUST use exactly those section names and MUST NOT add extra section names.
9. Use the conversation memory and history to maintain context across turns. If the user refers to something from a previous message, use the memory to answer accurately.
10. FINALITY (CRITICAL): This is the final response for the current run. Do NOT reply with promise-style text such as "我将…/稍后…/正在…/I will...". You MUST present concrete findings now.
""",
        }

        trimmed = _filter_messages_for_final_response(messages)
        all_messages = [system_message] + trimmed

        async for chunk in self.chat_stream(messages=all_messages, temperature=temperature, model=model):
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
