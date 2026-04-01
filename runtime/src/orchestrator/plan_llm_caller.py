"""Plan LLM call helpers: chat turn execution, terminal phase retries, error handling."""

import asyncio
import json
import os
import re as _re
from contextlib import suppress
from time import perf_counter
from typing import Any

from src.orchestrator.context_budget import PLAN_COMPACT_BUDGET
from src.utils.logging import get_logger

logger = get_logger(__name__)

_PLANNER_LLM_SLOW_CALL_MS = 15000
_PLANNER_LLM_HARD_TIMEOUT_SECONDS = float(os.getenv("SEMIBOT_PLANNER_LLM_HARD_TIMEOUT_SECONDS", "90"))


# ---------------------------------------------------------------------------
# Pure utility functions (migrated from nodes_plan.py)
# ---------------------------------------------------------------------------

def _planner_llm_timeout_seconds(llm_provider: Any) -> float:
    configured = getattr(getattr(llm_provider, "config", None), "timeout", None)
    try:
        timeout = float(configured) if configured is not None else _PLANNER_LLM_HARD_TIMEOUT_SECONDS
    except (TypeError, ValueError):
        timeout = _PLANNER_LLM_HARD_TIMEOUT_SECONDS
    return max(1.0, min(timeout, _PLANNER_LLM_HARD_TIMEOUT_SECONDS))


def _planner_terminal_retry_hint(retry_index: int) -> str:
    base = (
        'Return exactly one JSON object for the planner result. '
        'Do not call tools in this phase. '
        'Do not output markdown fences. '
        'Do not output prose before or after the JSON object. '
        'Do not include a `tool_calls` field. '
        'If any string field contains multi-line text, escape newlines inside the JSON string. '
        'The JSON object must have `type` = "plan" | "delegate" | "terminate".'
    )
    if retry_index <= 1:
        return base
    if retry_index == 2:
        return base + " This is a terminal retry. Output JSON only."
    return base + " Final retry. Output one valid JSON object and nothing else."


def _sanitize_loose_json_string_literals(candidate: str) -> str:
    text = str(candidate or "")
    if not text:
        return text
    out: list[str] = []
    in_string = False
    escaped = False
    changed = False
    for ch in text:
        if in_string:
            if escaped:
                out.append(ch)
                escaped = False
                continue
            if ch == "\\":
                out.append(ch)
                escaped = True
                continue
            if ch == "\"":
                out.append(ch)
                in_string = False
                continue
            if ch == "\n":
                out.append("\\n")
                changed = True
                continue
            if ch == "\r":
                out.append("\\r")
                changed = True
                continue
            if ch == "\t":
                out.append("\\t")
                changed = True
                continue
            out.append(ch)
            continue
        if ch == "\"":
            in_string = True
        out.append(ch)
    return "".join(out) if changed else text


def _parse_planner_json_object(response_text: str) -> dict[str, Any] | None:
    text = str(response_text or "").strip()
    if not text:
        return None

    with suppress(json.JSONDecodeError):
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed

    sanitized_text = _sanitize_loose_json_string_literals(text)
    if sanitized_text != text:
        with suppress(json.JSONDecodeError):
            parsed = json.loads(sanitized_text)
            if isinstance(parsed, dict):
                return parsed

    fence_match = _re.search(r"```(?:json)?\s*(.*?)\s*```", text, _re.DOTALL | _re.IGNORECASE)
    if fence_match:
        fenced = str(fence_match.group(1) or "").strip()
        with suppress(json.JSONDecodeError):
            parsed = json.loads(fenced)
            if isinstance(parsed, dict):
                return parsed
        sanitized_fenced = _sanitize_loose_json_string_literals(fenced)
        if sanitized_fenced != fenced:
            with suppress(json.JSONDecodeError):
                parsed = json.loads(sanitized_fenced)
                if isinstance(parsed, dict):
                    return parsed
        text = fenced

    object_candidates: list[str] = []
    start_idx: int | None = None
    depth = 0
    in_string = False
    escaped = False
    for idx, ch in enumerate(text):
        if start_idx is None:
            if ch == "{":
                start_idx = idx
                depth = 1
                in_string = False
                escaped = False
            continue

        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == "\"":
                in_string = False
            continue

        if ch == "\"":
            in_string = True
            continue
        if ch == "{":
            depth += 1
            continue
        if ch == "}":
            depth -= 1
            if depth == 0:
                object_candidates.append(text[start_idx : idx + 1])
                start_idx = None
            continue

    for candidate in object_candidates:
        with suppress(json.JSONDecodeError):
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        sanitized_candidate = _sanitize_loose_json_string_literals(candidate)
        if sanitized_candidate != candidate:
            with suppress(json.JSONDecodeError):
                parsed = json.loads(sanitized_candidate)
                if isinstance(parsed, dict):
                    return parsed
    return None


def _is_context_overflow_error(error: Exception) -> bool:
    text = str(error or "").lower()
    return any(
        token in text
        for token in (
            "maximum context length",
            "context window",
            "context_length",
            "too many tokens",
            "token limit",
            "content_length",
            "max_tokens",
        )
    )


def _unwrap_exception(error: Exception) -> Exception:
    root: Exception = error
    visited: set[int] = set()
    while isinstance(root, Exception) and id(root) not in visited:
        visited.add(id(root))
        if root.__class__.__name__ == "RetryError":
            last_attempt = getattr(root, "last_attempt", None)
            if last_attempt is not None and hasattr(last_attempt, "exception"):
                with suppress(Exception):
                    inner = last_attempt.exception()
                    if isinstance(inner, Exception):
                        root = inner
                        continue
        cause = getattr(root, "__cause__", None)
        if isinstance(cause, Exception):
            root = cause
            continue
        context = getattr(root, "__context__", None)
        if isinstance(context, Exception):
            root = context
            continue
        break
    return root


def _is_bad_request_error(error: Exception) -> bool:
    root: Exception | None = error
    visited: set[int] = set()

    while root is not None and id(root) not in visited:
        visited.add(id(root))
        if root.__class__.__name__ == "RetryError":
            last_attempt = getattr(root, "last_attempt", None)
            if last_attempt is not None and hasattr(last_attempt, "exception"):
                with suppress(Exception):
                    inner = last_attempt.exception()
                    if isinstance(inner, Exception):
                        root = inner
                        continue
        cause = getattr(root, "__cause__", None)
        if isinstance(cause, Exception):
            root = cause
            continue
        context = getattr(root, "__context__", None)
        if isinstance(context, Exception):
            root = context
            continue
        break

    candidates = [item for item in (error, root) if isinstance(item, Exception)]
    for candidate in candidates:
        cls_name = type(candidate).__name__
        if "BadRequest" in cls_name:
            return True
        response = getattr(candidate, "response", None)
        status_code = getattr(response, "status_code", None)
        if status_code == 400:
            return True
        text = str(candidate or "").lower()
        if "400" in text and ("bad request" in text or "badrequesterror" in text):
            return True
    return False


def _error_response_excerpt(error: Exception, limit: int = 500) -> str:
    root = _unwrap_exception(error)
    response = getattr(root, "response", None)
    if response is not None:
        text = getattr(response, "text", None)
        if isinstance(text, str) and text.strip():
            return text[:limit]
        content = getattr(response, "content", None)
        if isinstance(content, (bytes, bytearray)):
            try:
                return content.decode("utf-8", errors="ignore")[:limit]
            except Exception:
                return ""
    return str(root or "")[:limit]


def _trim_plan_loop_messages(messages: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], bool]:
    removable_markers = (
        "== Memory Context ==",
        "## Failure Reflection",
        "Requirements For The Next Plan",
    )
    for idx in range(len(messages) - 1, -1, -1):
        message = messages[idx]
        if str(message.get("role") or "").strip() != "system":
            continue
        content = str(message.get("content") or "")
        if any(marker in content for marker in removable_markers):
            return [*messages[:idx], *messages[idx + 1 :]], True
    return list(messages), False


# ---------------------------------------------------------------------------
# Main functions
# ---------------------------------------------------------------------------

async def planner_chat_turn(
    *,
    llm_provider: Any,
    planning_messages: list[dict[str, Any]],
    agent_model: Any | None,
    plan_temperature: float,
    plan_strategy: Any,
    event_emitter: Any | None,
    state: dict[str, Any],
    compact_mode: bool,
    turn_index: int,
    phase_name: str,
    phase_tools: list[dict[str, Any]] | None,
    phase_response_format: dict[str, Any] | None,
) -> tuple[Any, int]:
    """Execute a single planner LLM chat turn with event emission."""
    planner_model = str(agent_model or getattr(llm_provider, "model", "") or "").strip()
    llm_call_started_at = perf_counter()
    if event_emitter:
        await event_emitter.emit(
            "planner.llm_call_started",
            {
                "turn_index": turn_index,
                "phase": phase_name,
                "model": planner_model or None,
                "tools_enabled": bool(phase_tools),
                "compact_mode": compact_mode,
                "message_count": len(planning_messages),
            },
        )
    response = await asyncio.wait_for(
        llm_provider.chat(
            messages=planning_messages,
            tools=phase_tools,
            temperature=plan_temperature,
            response_format=phase_response_format,
            model=agent_model,
        ),
        timeout=_planner_llm_timeout_seconds(llm_provider),
    )
    llm_call_duration_ms = int((perf_counter() - llm_call_started_at) * 1000)
    if event_emitter:
        await event_emitter.emit(
            "planner.llm_call_completed",
            {
                "turn_index": turn_index,
                "phase": phase_name,
                "model": planner_model or None,
                "tools_enabled": bool(phase_tools),
                "compact_mode": compact_mode,
                "duration_ms": llm_call_duration_ms,
                "finish_reason": str(getattr(response, "finish_reason", "") or "stop"),
                "usage": dict(getattr(response, "usage", {}) or {}),
                "tool_call_count": len(getattr(response, "tool_calls", []) or []),
                "content_len": len(str(getattr(response, "content", "") or "")),
            },
        )
        _usage = dict(getattr(response, "usage", {}) or {})
        if _usage:
            await event_emitter.emit(
                "llm.usage",
                {
                    "session_id": state["session_id"],
                    "agent_id": state.get("agent_id"),
                    "node": "plan",
                    "model": planner_model or None,
                    "prompt_tokens": int(_usage.get("prompt_tokens") or 0),
                    "completion_tokens": int(_usage.get("completion_tokens") or 0),
                    "total_tokens": int(_usage.get("total_tokens") or 0),
                    "duration_ms": llm_call_duration_ms,
                    "phase": phase_name,
                    "iteration": state.get("iteration", 0),
                },
            )
    if llm_call_duration_ms >= _PLANNER_LLM_SLOW_CALL_MS:
        logger.warning(
            "planner_llm_call_slow",
            extra={
                "session_id": state["session_id"],
                "turn_index": turn_index,
                "phase": phase_name,
                "model": planner_model or None,
                "duration_ms": llm_call_duration_ms,
                "tools_enabled": bool(phase_tools),
                "compact_mode": compact_mode,
                "finish_reason": str(getattr(response, "finish_reason", "") or "stop"),
                "usage": dict(getattr(response, "usage", {}) or {}),
            },
        )
    return response, llm_call_duration_ms


async def planner_terminal_phase_retries(
    *,
    llm_provider: Any,
    planning_messages: list[dict[str, Any]],
    agent_model: Any | None,
    plan_temperature: float,
    plan_strategy: Any,
    event_emitter: Any | None,
    state: dict[str, Any],
    compact_mode: bool,
    loaded_skill_id: str | None,
    planner_loop_trace: list[dict[str, Any]],
    turn_index: int,
    initial_response: Any,
    initial_duration_ms: int,
    retry_count: int = 3,
) -> tuple[Any, int, str, dict[str, Any] | None]:
    """Retry terminal phase until valid JSON is parsed or retries exhausted."""
    response = initial_response
    llm_call_duration_ms = initial_duration_ms
    attempt = 0
    while True:
        response_text = str(response.content or "").strip()
        parsed = _parse_planner_json_object(response_text) if response_text else None
        if parsed is not None:
            return response, llm_call_duration_ms, response_text, parsed
        if attempt >= retry_count:
            return response, llm_call_duration_ms, response_text, None
        attempt += 1
        planner_loop_trace.append(
            {
                "turn_index": turn_index,
                "phase": "terminal",
                "tools_enabled": False,
                "compact_mode": compact_mode,
                "loaded_skill_id": str(loaded_skill_id or "").strip() or None,
                "raw_response": response_text,
                "outcome": "retry_terminal_phase",
                "retry_index": attempt,
                "rejection_reason": "response did not parse as a JSON object",
            }
        )
        planning_messages.append(
            {
                "role": "system",
                "content": (
                    "Your previous terminal response was rejected because it was not "
                    "a single valid JSON object. Do not continue the conversation. "
                    "Do not explain, apologize, or ask questions. "
                    + _planner_terminal_retry_hint(attempt)
                ),
            }
        )
        response, llm_call_duration_ms = await planner_chat_turn(
            llm_provider=llm_provider,
            planning_messages=planning_messages,
            agent_model=agent_model,
            plan_temperature=plan_temperature,
            plan_strategy=plan_strategy,
            event_emitter=event_emitter,
            state=state,
            compact_mode=compact_mode,
            turn_index=turn_index,
            phase_name="terminal",
            phase_tools=None,
            phase_response_format=plan_strategy.terminal_phase_response_format,
        )


def handle_plan_llm_error(
    *,
    llm_error: Exception,
    event_emitter: Any | None,
    state: dict[str, Any],
    planner_loop_trace: list[dict[str, Any]],
    planning_messages: list[dict[str, Any]],
    turn_index: int,
    planner_model: str,
    effective_tools: list[dict[str, Any]] | None,
    compact_mode: bool,
    loaded_skill_id: str | None,
    llm_provider: Any,
    tools_available: bool,
    effective_memory: str,
    memory_system: Any | None,
    memory_snapshot: dict[str, Any],
    runtime_context: Any | None,
    available_execution_capability_names: dict[str, str],
    agent_system_prompt: str,
    loaded_skill_content: str,
    messages: list[dict[str, Any]],
    session_current_date: str,
    session_current_weekday: str,
    session_current_timezone: str,
) -> dict[str, Any]:
    """Handle planner LLM errors. Returns signal dict with action and updated state."""

    signal: dict[str, Any] = {
        "action": "raise",
        "compact_mode": compact_mode,
        "tools_available": tools_available,
        "planning_messages": planning_messages,
    }

    if isinstance(llm_error, TimeoutError) and not compact_mode:
        planner_loop_trace.append({
            "turn_index": turn_index,
            "tools_enabled": bool(effective_tools),
            "compact_mode": compact_mode,
            "loaded_skill_id": str(loaded_skill_id or "").strip() or None,
            "outcome": "timeout_retry_with_compact_mode",
            "error": f"planner LLM call exceeded {_planner_llm_timeout_seconds(llm_provider):g}s",
            "duration_ms": 0,
        })
        _, new_messages = _build_compact_mode_context(
            effective_memory=effective_memory,
            memory_system=memory_system,
            memory_snapshot=memory_snapshot,
            runtime_context=runtime_context,
            available_execution_capability_names=available_execution_capability_names,
            agent_system_prompt=agent_system_prompt,
            loaded_skill_id=loaded_skill_id,
            loaded_skill_content=loaded_skill_content,
            messages=messages,
            session_current_date=session_current_date,
            session_current_weekday=session_current_weekday,
            session_current_timezone=session_current_timezone,
            available_planning_tools=["read_skill", "inspect_sub_agent"],
        )
        logger.warning(
            "plan_loop_retry_with_compact_prompt_after_timeout",
            extra={
                "session_id": state["session_id"],
                "turn_index": turn_index,
                "timeout_seconds": _planner_llm_timeout_seconds(llm_provider),
            },
        )
        signal["action"] = "continue"
        signal["compact_mode"] = True
        signal["tools_available"] = False
        signal["planning_messages"] = new_messages
        return signal

    trimmed_messages, trimmed = _trim_plan_loop_messages(planning_messages)
    if _is_context_overflow_error(llm_error) and trimmed:
        logger.info(
            "plan_loop_messages_trimmed_after_context_overflow",
            extra={"session_id": state["session_id"], "turn_index": turn_index, "message_count": len(trimmed_messages)},
        )
        signal["action"] = "continue"
        signal["planning_messages"] = trimmed_messages
        return signal

    if _is_bad_request_error(llm_error) and not compact_mode:
        planner_loop_trace.append({
            "turn_index": turn_index,
            "tools_enabled": bool(effective_tools),
            "compact_mode": compact_mode,
            "loaded_skill_id": str(loaded_skill_id or "").strip() or None,
            "outcome": "bad_request_retry_with_compact_mode",
            "error": str(_unwrap_exception(llm_error))[:500],
            "response_excerpt": _error_response_excerpt(llm_error),
            "duration_ms": 0,
        })
        _, new_messages = _build_compact_mode_context(
            effective_memory=effective_memory,
            memory_system=memory_system,
            memory_snapshot=memory_snapshot,
            runtime_context=runtime_context,
            available_execution_capability_names=available_execution_capability_names,
            agent_system_prompt=agent_system_prompt,
            loaded_skill_id=loaded_skill_id,
            loaded_skill_content=loaded_skill_content,
            messages=messages,
            session_current_date=session_current_date,
            session_current_weekday=session_current_weekday,
            session_current_timezone=session_current_timezone,
            available_planning_tools=["read_skill", "inspect_sub_agent"],
        )
        logger.warning(
            "plan_loop_retry_with_compact_prompt_after_bad_request",
            extra={
                "session_id": state["session_id"],
                "turn_index": turn_index,
                "error": str(llm_error)[:300],
                "tools_available": bool(tools_available),
                "had_effective_tools": bool(effective_tools),
            },
        )
        signal["action"] = "continue"
        signal["compact_mode"] = True
        signal["tools_available"] = False
        signal["planning_messages"] = new_messages
        return signal

    if _is_bad_request_error(llm_error):
        planner_loop_trace.append({
            "turn_index": turn_index,
            "tools_enabled": bool(effective_tools),
            "compact_mode": compact_mode,
            "loaded_skill_id": str(loaded_skill_id or "").strip() or None,
            "outcome": "bad_request_tools_disabled_retry",
            "error": str(_unwrap_exception(llm_error))[:500],
            "response_excerpt": _error_response_excerpt(llm_error),
            "duration_ms": 0,
        })
        logger.warning(
            "plan_loop_tools_disabled_after_bad_request",
            extra={"session_id": state["session_id"], "turn_index": turn_index, "error": str(llm_error)[:300]},
        )
        signal["action"] = "continue"
        signal["tools_available"] = False
        return signal

    # Fatal — caller should re-raise
    return signal


def _recent_user_messages_for_compact_plan(messages: list[dict[str, Any]], limit: int = 6) -> list[dict[str, str]]:
    return [
        {"role": "user", "content": str(message.get("content") or "")}
        for message in messages[-limit:]
        if str(message.get("role") or "") == "user"
    ]


def _build_compact_mode_context(
    *,
    effective_memory: str,
    memory_system: Any | None,
    memory_snapshot: dict[str, Any],
    runtime_context: Any | None,
    available_execution_capability_names: dict[str, str],
    agent_system_prompt: str,
    loaded_skill_id: str | None,
    loaded_skill_content: str,
    messages: list[dict[str, Any]],
    session_current_date: str,
    session_current_weekday: str,
    session_current_timezone: str,
    available_planning_tools: list[str] | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    """Build compact mode system prompt and planning messages."""
    from src.orchestrator.nodes_shared import _serialize_tool_backfeed_content
    from src.orchestrator.plan_validator import _extract_loaded_skill_phase_outline

    compact_memory = str(effective_memory or "").strip()
    _compact_mem_limit = PLAN_COMPACT_BUDGET.max_memory_chars
    if memory_system and hasattr(memory_system, "render_memory_snapshot"):
        compact_memory = memory_system.prepare_memory_context(
            memory_system.render_memory_snapshot(memory_snapshot),
            max_chars=_compact_mem_limit,
        )
    elif memory_system and hasattr(memory_system, "prepare_memory_context"):
        compact_memory = memory_system.prepare_memory_context(
            compact_memory,
            max_chars=_compact_mem_limit,
        )
    elif len(compact_memory) > _compact_mem_limit:
        compact_memory = compact_memory[:_compact_mem_limit] + "\n... (truncated)"

    compact_skill_lines: list[str] = []
    metadata = getattr(runtime_context, "metadata", None)
    skill_index = metadata.get("skill_index") if isinstance(metadata, dict) else None
    if isinstance(skill_index, list):
        for item in skill_index[:PLAN_COMPACT_BUDGET.max_skill_index_items]:
            if not isinstance(item, dict):
                continue
            skill_id = str(item.get("id") or item.get("name") or "").strip()
            description = str(item.get("description") or "").strip()
            if skill_id:
                compact_skill_lines.append(f"- {skill_id}: {description or 'No description'}")
    compact_skill_index = "\n".join(compact_skill_lines) or "(none)"

    from src.orchestrator.prompts.plan_prompts import compact_planner_system_prompt
    compact_prompt = compact_planner_system_prompt(
        session_current_date=session_current_date,
        session_current_weekday=session_current_weekday,
        session_current_timezone=session_current_timezone,
        compact_skill_index=compact_skill_index,
        available_execution_capability_names=available_execution_capability_names,
        compact_memory=compact_memory,
        available_planning_tools=available_planning_tools,
    )
    if agent_system_prompt:
        compact_prompt = f"{agent_system_prompt}\n\n---\n\n{compact_prompt}"

    planning_messages: list[dict[str, Any]] = [{"role": "system", "content": compact_prompt}]
    if loaded_skill_id:
        loaded_phase_outline = _extract_loaded_skill_phase_outline(loaded_skill_content)
        phase_hint = ", ".join(loaded_phase_outline) if loaded_phase_outline else "skill-defined phases"
        compact_skill_excerpt = str(loaded_skill_content or "").strip()
        if len(compact_skill_excerpt) > PLAN_COMPACT_BUDGET.max_skill_md_chars:
            compact_skill_excerpt = compact_skill_excerpt[:PLAN_COMPACT_BUDGET.max_skill_md_chars].rstrip() + "\n...(truncated for compact planning mode)"
        planning_messages.append({"role": "system", "content": f"Skill '{loaded_skill_id}' was already loaded earlier in this planning session. Do not call read_skill for the same skill again unless the previous call failed. Use the already loaded skill as the methodology scaffold for the next final JSON. Phase outline: {phase_hint}."})
        if compact_skill_excerpt:
            planning_messages.append({"role": "tool", "tool_call_id": f"read_skill:loaded:{loaded_skill_id}", "content": _serialize_tool_backfeed_content(tool_name='read_skill', tool_call_id=f'read_skill:loaded:{loaded_skill_id}', payload={'success': True, 'skill_id': loaded_skill_id, 'content': compact_skill_excerpt}, purpose='planning_methodology_scaffold')})
    planning_messages.extend(_recent_user_messages_for_compact_plan(messages))
    return compact_prompt, planning_messages


# ---------------------------------------------------------------------------
# Re-exports from plan_message_builder (preserves backward-compatible import paths)
# ---------------------------------------------------------------------------
from src.orchestrator.plan_message_builder import (  # noqa: E402, F401
    _truncate_planner_text,
    _compact_planner_value,
    _latest_user_text_from_messages,
    _load_skill_md_for_planner,
    _build_plan_loop_system_prompt,
    _build_plan_loop_messages,
)
