"""Direct Reasoning node implementation."""

from __future__ import annotations

import asyncio
import ast
import json
import re as _re
import time
from typing import Any

from src.events.runtime_emitter import emit_runtime_event
from src.orchestrator.act_tool_executor import (
    _build_act_tool_schemas,
    _build_tool_transcript_message,
    execute_single_act_tool_call,
)
from src.orchestrator.nodes_shared import _build_assistant_transcript_message, _latest_user_text
from src.orchestrator.state import AgentState, DirectReasoningResult, PlanStep, ToolCallResult
from src.utils.logging import get_logger

logger = get_logger(__name__)

_DR_WRAPPER_KEYS = {
    "status",
    "answer",
    "upgrade_reason",
    "evidence",
    "diagnostics",
    "intermediate_context",
    "resource_usage",
    "artifacts",
    "failure",
    "tool_usage",
}


def _raw_delivery_payload_dict_like(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    keys = {str(key).strip().lower() for key in value.keys()}
    raw_web_fetch_keys = {"url", "status_code", "content_type", "title", "text"}
    if len(keys & raw_web_fetch_keys) >= 3:
        return True
    if "text" in keys and "url" in keys:
        text_value = str(value.get("text") or "").strip()
        return len(text_value) > 200
    return False


def _parse_structured_text_payload(value: Any) -> dict[str, Any] | list[Any] | None:
    if not isinstance(value, str):
        return None
    content = value.strip()
    if not content or not content.startswith(("{", "[")):
        return None
    for parser in (json.loads, ast.literal_eval):
        try:
            parsed = parser(content)
        except Exception:
            continue
        if isinstance(parsed, (dict, list)):
            return parsed
    return None


def _looks_like_python_literal_payload_text(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    content = value.strip()
    if not content or not content.startswith(("{", "[")):
        return False
    lowered = content.lower()
    strong_markers = ("'rank':", "'title':", "'author':", "'url':", "'likes':")
    marker_hits = sum(1 for marker in strong_markers if marker in lowered)
    if marker_hits >= 2:
        return True
    if "[{" in content and ("':" in content or "}, {" in content):
        return True
    return False


def _looks_like_raw_delivery_payload(value: Any) -> bool:
    if _raw_delivery_payload_dict_like(value):
        return True
    if isinstance(value, list) and value and all(_raw_delivery_payload_dict_like(item) for item in value):
        return True
    if not isinstance(value, str):
        return False
    content = value.strip()
    if not content or not content.startswith(("{", "[")):
        return False
    parsed_literal = _parse_structured_text_payload(content)
    if parsed_literal is not None:
        return _looks_like_raw_delivery_payload(parsed_literal)
    if _looks_like_python_literal_payload_text(content):
        return True
    try:
        parsed = json.loads(content)
    except Exception:
        # Handle common case where multiple raw JSON objects are concatenated
        # by newlines: "{...}\n\n{...}".
        parts = [item.strip() for item in _re.split(r"\}\s*\n+\s*\{", content) if item.strip()]
        if len(parts) > 1:
            parsed_parts: list[Any] = []
            for idx, part in enumerate(parts):
                block = part
                if idx > 0 and not block.startswith("{"):
                    block = "{" + block
                if idx < len(parts) - 1 and not block.endswith("}"):
                    block = block + "}"
                try:
                    parsed_parts.append(json.loads(block))
                except Exception:
                    parsed_parts = []
                    break
            if parsed_parts and all(_raw_delivery_payload_dict_like(item) for item in parsed_parts):
                return True
        lowered = content.lower()
        return (
            '"url"' in lowered
            and '"status_code"' in lowered
            and '"content_type"' in lowered
            and '"text"' in lowered
        )
    return _looks_like_raw_delivery_payload(parsed)


def _filter_recent_messages(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    relevant = []
    for item in messages[-8:]:
        role = str(item.get("role") or "").strip()
        if role not in {"user", "assistant", "system"}:
            continue
        content = str(item.get("content") or "")
        if not content:
            continue
        relevant.append({"role": role, "content": content})
    return relevant


def _dr_tool_phase_prompt(goal: str, dr_policy: dict[str, Any] | None) -> str:
    max_tool_calls = int((dr_policy or {}).get("max_tool_calls") or 0)
    max_iterations = int((dr_policy or {}).get("max_react_iterations") or 0)
    return (
        "You are executing Direct Reasoning Mode.\n"
        "Goal: complete the user's request in one bounded execution.\n"
        "You may use a SMALL number of tool calls if truly necessary.\n"
        "Do not plan a multi-step workflow. Do not explain internal process to the user.\n"
        f"Hard limits: max_tool_calls={max_tool_calls}, max_react_iterations={max_iterations}.\n"
        "If tools are needed, call them directly. If not, answer from current context.\n"
        "Never present raw tool payloads, scraped JSON, HTML extracts, or unformatted fetch results as the final answer.\n"
        "If you used any tool call in this run, your final response MUST be exactly one JSON object with this shape:\n"
        '{"status":"completed|partial|upgrade_required|failed","answer":"user-facing markdown answer or null","upgrade_reason":"optional string","diagnostics":{"budget_exceeded":false,"loop_signal":false,"context_insufficient":false},"evidence":[],"artifacts":[],"failure":null,"intermediate_context":null,"resource_usage":{}}\n'
        "When tools were used, do not return plain prose, Python literals, markdown lists, or raw snippets outside that JSON object.\n"
        "When you have enough evidence, stop requesting tools and provide a concise assistant message.\n"
        f"Task goal: {goal}\n"
    )


def _dr_post_tool_contract_prompt() -> str:
    return (
        "Tool results are now available.\n"
        "If you need another tool, call it directly.\n"
        "Otherwise, return exactly one JSON object only, with keys status and answer at minimum.\n"
        "Do not return free-form prose, markdown, Python literals, or raw tool payloads outside the JSON wrapper.\n"
    )


def _parse_dr_json(text: str) -> dict[str, Any] | None:
    from src.orchestrator.plan_llm_caller import _parse_planner_json_object

    return _parse_planner_json_object(text)


def _token_total(usage: dict[str, Any]) -> int:
    return int(
        usage.get("total_tokens")
        or (int(usage.get("prompt_tokens") or 0) + int(usage.get("completion_tokens") or 0))
    )


def _tool_result_has_pending_approval(result: ToolCallResult) -> bool:
    metadata = getattr(result, "metadata", None)
    if not isinstance(metadata, dict):
        return False
    return str(metadata.get("approval_status") or "").strip().lower() == "pending"


def _tool_result_snapshot(rows: list[ToolCallResult]) -> list[dict[str, Any]]:
    snapshots: list[dict[str, Any]] = []
    for row in rows[-8:]:
        result_summary: Any = row.result
        if isinstance(result_summary, (dict, list)):
            result_summary = str(result_summary)[:1000]
        else:
            result_summary = str(result_summary or "")[:1000]
        snapshots.append(
            {
                "tool_name": str(row.tool_name or ""),
                "success": bool(row.success),
                "error": str(row.error or "")[:300] or None,
                "result_summary": result_summary or None,
            }
        )
    return snapshots


def _humanize_dr_key(value: str) -> str:
    text = str(value or "").strip().replace("_", " ").replace("-", " ")
    if not text:
        return "Item"
    return text[:1].upper() + text[1:]


def _compact_scalar(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "Yes" if value else "No"
    text = str(value).strip()
    return text


def _render_dr_structured_value(value: Any, *, depth: int = 0) -> list[str]:
    indent = "  " * max(depth, 0)
    child_indent = "  " * (depth + 1)
    if isinstance(value, dict):
        lines: list[str] = []
        for key, item in value.items():
            label = _humanize_dr_key(str(key))
            if isinstance(item, (dict, list)):
                heading = "##" if depth == 0 else "###" if depth == 1 else None
                if heading:
                    lines.append(f"{heading} {label}")
                else:
                    lines.append(f"{indent}- {label}:")
                nested = _render_dr_structured_value(item, depth=depth + 1)
                if heading and nested:
                    lines.append("")
                lines.extend(nested)
                if heading and nested:
                    lines.append("")
            else:
                scalar = _compact_scalar(item)
                if scalar:
                    lines.append(f"{indent}- {label}: {scalar}")
        return lines
    if isinstance(value, list):
        lines: list[str] = []
        for item in value:
            if isinstance(item, (dict, list)):
                nested = _render_dr_structured_value(item, depth=depth + 1)
                if nested:
                    lines.append(f"{indent}-")
                    lines.extend(nested)
            else:
                scalar = _compact_scalar(item)
                if scalar:
                    lines.append(f"{indent}- {scalar}")
        return lines
    scalar = _compact_scalar(value)
    return [f"{child_indent if depth > 0 else ''}{scalar}"] if scalar else []


def _render_dr_structured_list_markdown(items: list[Any]) -> str:
    lines: list[str] = []
    for index, item in enumerate(items, start=1):
        if isinstance(item, dict):
            title_key = next(
                (
                    key
                    for key in ("title", "name", "label", "summary", "author", "url")
                    if _compact_scalar(item.get(key))
                ),
                None,
            )
            title = _compact_scalar(item.get(title_key)) if title_key else ""
            heading = f"### {index}. {title}" if title else f"### {index}"
            lines.append(heading)
            remaining = {key: value for key, value in item.items() if key != title_key}
            lines.extend(_render_dr_structured_value(remaining, depth=0))
            lines.append("")
            continue
        if isinstance(item, list):
            lines.append(f"### {index}")
            lines.extend(_render_dr_structured_value(item, depth=0))
            lines.append("")
            continue
        scalar = _compact_scalar(item)
        if scalar:
            lines.append(f"{index}. {scalar}")
    return "\n".join(line for line in lines if line is not None).strip()


def _render_dr_structured_payload_markdown(payload: dict[str, Any]) -> str:
    lines: list[str] = []
    if isinstance(payload.get("executive_summary"), str) and str(payload.get("executive_summary")).strip():
        lines.append("## Executive Summary")
        lines.append(str(payload.get("executive_summary")).strip())
        lines.append("")
    remaining = {
        key: value
        for key, value in payload.items()
        if not (key == "executive_summary" and isinstance(value, str))
    }
    lines.extend(_render_dr_structured_value(remaining, depth=0))
    rendered = "\n".join(line for line in lines if line is not None).strip()
    # Never fall back to raw JSON in user-facing DR answers.
    return rendered


def _render_structured_answer_candidate(value: Any) -> str | None:
    if isinstance(value, dict):
        return None if _looks_like_raw_delivery_payload(value) else _render_dr_structured_payload_markdown(value)
    if isinstance(value, list):
        return None if _looks_like_raw_delivery_payload(value) else _render_dr_structured_list_markdown(value)
    parsed = _parse_structured_text_payload(value)
    if parsed is None:
        candidate = str(value or "").strip() or None
        if not candidate or _looks_like_raw_delivery_payload(candidate) or _looks_like_python_literal_payload_text(candidate):
            return None
        return candidate
    if _looks_like_raw_delivery_payload(parsed):
        return None
    if isinstance(parsed, dict):
        return _render_dr_structured_payload_markdown(parsed)
    return _render_dr_structured_list_markdown(parsed)


def _is_dr_wrapper_payload(raw: dict[str, Any]) -> bool:
    return any(key in raw for key in _DR_WRAPPER_KEYS)


def _ensure_dict(value: Any, default: dict[str, Any] | None = None) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    return dict(default or {})


def _ensure_list(value: Any, default: list[Any] | None = None) -> list[Any]:
    if isinstance(value, list):
        return list(value)
    return list(default or [])


def _normalize_dr_result(
    raw: dict[str, Any] | None,
    *,
    elapsed_ms: int,
    tool_call_count: int,
    total_tokens: int,
    tool_results: list[ToolCallResult],
    fallback_answer: str | None = None,
) -> DirectReasoningResult:
    safe_fallback_answer = _render_structured_answer_candidate(fallback_answer)
    if not isinstance(raw, dict):
        return {
            "status": "completed" if safe_fallback_answer else "failed",
            "answer": safe_fallback_answer,
            "artifacts": [],
            "tool_usage": {"tool_calls": tool_call_count, "tokens": total_tokens, "wall_clock_ms": elapsed_ms},
            "evidence": _tool_result_snapshot(tool_results),
            "upgrade_reason": None,
            "failure": None
            if safe_fallback_answer
            else {
                "code": "dr_parse_failed",
                "message": "DR response was not valid JSON",
                "retryable": False,
            },
            "diagnostics": {"budget_exceeded": False, "loop_signal": False, "context_insufficient": False},
            "intermediate_context": {"tool_results": _tool_result_snapshot(tool_results)} if tool_results else None,
            "resource_usage": {
                "tool_calls": tool_call_count,
                "wall_clock_ms": elapsed_ms,
                "tokens": total_tokens,
            },
        }

    if not _is_dr_wrapper_payload(raw):
        rendered_answer = None
        diagnostics = {"budget_exceeded": False, "loop_signal": False, "context_insufficient": False}
        if not _looks_like_raw_delivery_payload(raw):
            rendered_answer = _render_dr_structured_payload_markdown(raw)
        else:
            diagnostics["raw_payload_suppressed"] = True
        status_value = "completed" if rendered_answer else "upgrade_required"
        upgrade_reason = None
        failure_value = None
        if rendered_answer is None:
            upgrade_reason = "direct reasoning produced raw payload instead of a user-facing answer"
            failure_value = {
                "code": "dr_raw_payload",
                "message": "DR output was raw tool payload and was suppressed",
                "retryable": False,
            }
        return {
            "status": status_value,
            "answer": rendered_answer,
            "artifacts": [],
            "tool_usage": {
                "tool_calls": tool_call_count,
                "tokens": total_tokens,
                "wall_clock_ms": elapsed_ms,
            },
            "evidence": _tool_result_snapshot(tool_results),
            "upgrade_reason": upgrade_reason,
            "failure": failure_value,
            "diagnostics": diagnostics,
            "intermediate_context": {
                "structured_payload": raw,
                "tool_results": _tool_result_snapshot(tool_results),
            },
            "resource_usage": {
                "tool_calls": tool_call_count,
                "wall_clock_ms": elapsed_ms,
                "tokens": total_tokens,
            },
        }

    status = str(raw.get("status") or "").strip().lower() or "completed"
    if status not in {"completed", "partial", "upgrade_required", "failed"}:
        status = "completed"

    has_explicit_answer_field = "answer" in raw
    answer_value = raw.get("answer")
    rendered_answer: str | None = None
    diagnostics = _ensure_dict(raw.get("diagnostics"))
    candidate_answer = answer_value if has_explicit_answer_field else safe_fallback_answer
    rendered_answer = _render_structured_answer_candidate(candidate_answer)
    if candidate_answer is not None and rendered_answer is None:
        diagnostics["raw_payload_suppressed"] = True

    if rendered_answer is None and status in {"completed", "partial"}:
        if diagnostics.get("raw_payload_suppressed"):
            status = "upgrade_required"
            if not str(raw.get("upgrade_reason") or "").strip():
                raw["upgrade_reason"] = "direct reasoning produced raw payload instead of a user-facing answer"
            if not isinstance(raw.get("failure"), dict):
                raw["failure"] = {
                    "code": "dr_raw_payload",
                    "message": "DR output was raw tool payload and was suppressed",
                    "retryable": False,
                }
        elif status == "completed":
            status = "partial"
    return {
        "status": status,  # type: ignore[return-value]
        "answer": rendered_answer,
        "artifacts": _ensure_list(raw.get("artifacts")),
        "tool_usage": {
            "tool_calls": tool_call_count,
            "tokens": total_tokens,
            "wall_clock_ms": elapsed_ms,
        },
        "evidence": _ensure_list(raw.get("evidence"), _tool_result_snapshot(tool_results)),
        "upgrade_reason": str(raw.get("upgrade_reason") or "").strip() or None,
        "failure": raw.get("failure") if isinstance(raw.get("failure"), dict) else None,
        "diagnostics": diagnostics,
        "intermediate_context": (
            raw.get("intermediate_context")
            if isinstance(raw.get("intermediate_context"), dict)
            else {"tool_results": _tool_result_snapshot(tool_results)}
            if tool_results
            else None
        ),
        "resource_usage": _ensure_dict(
            raw.get("resource_usage"),
            {
                "tool_calls": tool_call_count,
                "wall_clock_ms": elapsed_ms,
                "tokens": total_tokens,
            },
        ),
    }


async def dr_node(state: AgentState, context: dict[str, Any]) -> dict[str, Any]:
    """Execute one bounded direct reasoning run."""
    session_id = str(state.get("session_id") or "").strip()
    runtime_context = state.get("context")
    runtime_event_emitter = context.get("runtime_event_emitter")
    llm_provider = context.get("llm_provider")
    skill_registry = context.get("skill_registry")
    unified_executor = context.get("unified_executor") or context.get("action_executor")
    event_emitter = context.get("event_emitter")

    await emit_runtime_event(
        runtime_event_emitter,
        event_type="dr.started",
        source="runtime.dr_node",
        subject=session_id or None,
        payload={"session_id": session_id},
    )

    routing_decision = state.get("routing_decision") or {}
    dr_policy = routing_decision.get("dr_policy") if isinstance(routing_decision, dict) else None
    goal = str((routing_decision or {}).get("goal") or _latest_user_text(state)).strip() or "direct reasoning task"

    if llm_provider is None:
        dr_result: DirectReasoningResult = {
            "status": "failed",
            "answer": None,
            "artifacts": [],
            "tool_usage": {"tool_calls": 0, "tokens": 0, "wall_clock_ms": 0},
            "evidence": [],
            "upgrade_reason": "llm provider unavailable",
            "failure": {
                "code": "llm_not_configured",
                "message": "LLM provider not configured for DR execution",
                "retryable": False,
            },
            "diagnostics": {"budget_exceeded": False, "loop_signal": False, "context_insufficient": True},
            "intermediate_context": {"goal": goal},
            "resource_usage": {"tool_calls": 0, "wall_clock_ms": 0},
        }
        await emit_runtime_event(
            runtime_event_emitter,
            event_type="dr.failed",
            source="runtime.dr_node",
            subject=session_id or None,
            payload={"session_id": session_id, "failure": dr_result.get("failure")},
        )
        return {"dr_result": dr_result, "tool_results": [], "current_step": "dr"}

    started_at = time.perf_counter()
    model = None
    temperature = 0.2
    if runtime_context and getattr(runtime_context, "agent_config", None):
        role_cfg = runtime_context.agent_config.model_roles.act
        model = role_cfg.model or runtime_context.agent_config.model
        if role_cfg.temperature is not None:
            temperature = role_cfg.temperature

    max_timeout_ms = int((dr_policy or {}).get("max_wall_clock_ms") or 45000)
    max_iterations = max(1, int((dr_policy or {}).get("max_react_iterations") or 2))
    max_tool_calls = max(0, int((dr_policy or {}).get("max_tool_calls") or 0))
    allow_tools = bool((dr_policy or {}).get("allow_tools", True))
    available_tools = (
        _build_act_tool_schemas(runtime_context, skill_registry)
        if allow_tools and unified_executor is not None
        else []
    )

    messages: list[dict[str, Any]] = (
        [{"role": "system", "content": _dr_tool_phase_prompt(goal, dr_policy if isinstance(dr_policy, dict) else None)}]
        + _filter_recent_messages(state.get("messages") or [])
    )
    step_results: list[ToolCallResult] = []
    tool_call_count = 0
    total_tokens = 0
    last_tool_phase_response_content = ""
    terminal_raw: dict[str, Any] | None = None

    try:
        for _ in range(max_iterations):
            tool_response = await asyncio.wait_for(
                llm_provider.chat(
                    messages=messages,
                    tools=available_tools or None,
                    temperature=temperature,
                    model=model,
                ),
                timeout=max(1.0, max_timeout_ms / 1000.0),
            )
            usage = dict(getattr(tool_response, "usage", {}) or {})
            total_tokens += _token_total(usage)
            last_tool_phase_response_content = str(getattr(tool_response, "content", "") or "").strip()

            tool_calls = list(getattr(tool_response, "tool_calls", []) or [])
            if tool_calls and allow_tools and unified_executor is not None:
                remaining_budget = max_tool_calls - tool_call_count
                if remaining_budget <= 0:
                    terminal_raw = {
                        "status": "upgrade_required",
                        "answer": None,
                        "upgrade_reason": "direct reasoning exhausted tool call budget",
                        "evidence": _tool_result_snapshot(step_results),
                        "diagnostics": {"budget_exceeded": True},
                    }
                    break
                tool_calls = tool_calls[:remaining_budget]
                messages.append(
                    _build_assistant_transcript_message(
                        response_content=last_tool_phase_response_content,
                        tool_calls=tool_calls,
                        reasoning_content=getattr(tool_response, "reasoning_content", None),
                    )
                )
                synthetic_action = PlanStep(
                    id="dr",
                    title=goal,
                    tool="llm_act",
                    params={},
                    parallel=False,
                )
                for call in tool_calls:
                    execution_result = await execute_single_act_tool_call(
                        call,
                        state=state,
                        action=synthetic_action,
                        current_skill_id="",
                        runtime_context=runtime_context,
                        prior_results=[],
                        pipeline=None,
                        step_results=step_results,
                        latest_user_text=_latest_user_text(state),
                        unified_executor=unified_executor,
                        event_emitter=event_emitter,
                        current_step_snapshot=list(step_results),
                    )
                    step_results.append(execution_result)
                    tool_call_count += 1
                    messages.append(
                        _build_tool_transcript_message(
                            tool_call_id=str(call.get("id") or ""),
                            result=execution_result,
                        )
                    )
                    if _tool_result_has_pending_approval(execution_result):
                        terminal_raw = {
                            "status": "partial",
                            "answer": None,
                            "evidence": _tool_result_snapshot(step_results),
                            "diagnostics": {"approval_pending": True},
                            "intermediate_context": {"tool_results": _tool_result_snapshot(step_results)},
                        }
                        break
                if terminal_raw is not None:
                    break
                messages.append({"role": "system", "content": _dr_post_tool_contract_prompt()})
                continue

            parsed_tool_phase = _parse_dr_json(last_tool_phase_response_content) if last_tool_phase_response_content else None
            if parsed_tool_phase is not None:
                terminal_raw = parsed_tool_phase
                break
            if last_tool_phase_response_content:
                if tool_call_count > 0:
                    terminal_raw = {
                        "status": "upgrade_required",
                        "answer": None,
                        "upgrade_reason": "direct reasoning returned a non-wrapper terminal response after tool use",
                        "failure": {
                            "code": "dr_missing_terminal_wrapper",
                            "message": "DR used tools but did not return the required terminal JSON wrapper",
                            "retryable": False,
                        },
                        "diagnostics": {
                            "budget_exceeded": False,
                            "loop_signal": False,
                            "context_insufficient": False,
                            "contract_violation": True,
                            "missing_wrapper": True,
                        },
                        "intermediate_context": {
                            "raw_terminal_response": last_tool_phase_response_content[:2000],
                            "tool_results": _tool_result_snapshot(step_results),
                        },
                    }
                else:
                    terminal_raw = {"status": "completed", "answer": last_tool_phase_response_content}
            else:
                terminal_raw = {
                    "status": "failed",
                    "answer": None,
                    "upgrade_reason": "direct reasoning returned empty response",
                    "failure": {
                        "code": "dr_empty_response",
                        "message": "DR returned no content and no tool call",
                        "retryable": False,
                    },
                }
            break

        if terminal_raw is None:
            terminal_raw = {
                "status": "upgrade_required",
                "answer": None,
                "upgrade_reason": "direct reasoning reached iteration budget",
                "evidence": _tool_result_snapshot(step_results),
                "diagnostics": {"budget_exceeded": True},
            }

        elapsed_ms = int((time.perf_counter() - started_at) * 1000)
        dr_result = _normalize_dr_result(
            terminal_raw,
            elapsed_ms=elapsed_ms,
            tool_call_count=tool_call_count,
            total_tokens=total_tokens,
            tool_results=step_results,
            fallback_answer=last_tool_phase_response_content or None,
        )
    except asyncio.TimeoutError:
        elapsed_ms = int((time.perf_counter() - started_at) * 1000)
        dr_result = {
            "status": "failed",
            "answer": None,
            "artifacts": [],
            "tool_usage": {"tool_calls": tool_call_count, "tokens": total_tokens, "wall_clock_ms": elapsed_ms},
            "evidence": _tool_result_snapshot(step_results),
            "upgrade_reason": "direct reasoning exceeded wall-clock budget",
            "failure": {"code": "dr_timeout", "message": "DR execution timed out", "retryable": False},
            "diagnostics": {"budget_exceeded": True, "loop_signal": False, "context_insufficient": False},
            "intermediate_context": {"tool_results": _tool_result_snapshot(step_results)},
            "resource_usage": {"tool_calls": tool_call_count, "wall_clock_ms": elapsed_ms, "tokens": total_tokens},
        }
    except Exception as exc:
        elapsed_ms = int((time.perf_counter() - started_at) * 1000)
        logger.warning("dr_node_failed", extra={"session_id": session_id, "error": str(exc)}, exc_info=True)
        dr_result = {
            "status": "failed",
            "answer": None,
            "artifacts": [],
            "tool_usage": {"tool_calls": tool_call_count, "tokens": total_tokens, "wall_clock_ms": elapsed_ms},
            "evidence": _tool_result_snapshot(step_results),
            "upgrade_reason": str(exc)[:300] or "direct reasoning failed",
            "failure": {"code": "dr_failed", "message": str(exc)[:500], "retryable": False},
            "diagnostics": {"budget_exceeded": False, "loop_signal": False, "context_insufficient": False},
            "intermediate_context": {"tool_results": _tool_result_snapshot(step_results)},
            "resource_usage": {"tool_calls": tool_call_count, "wall_clock_ms": elapsed_ms, "tokens": total_tokens},
        }

    for item in step_results:
        metadata = getattr(item, "metadata", None)
        if isinstance(metadata, dict):
            metadata["dr_mode"] = True
            metadata["execution_mode"] = "direct_reasoning"

    event_type = "dr.failed" if dr_result.get("status") == "failed" else "dr.completed"
    await emit_runtime_event(
        runtime_event_emitter,
        event_type=event_type,
        source="runtime.dr_node",
        subject=session_id or None,
        payload={
            "session_id": session_id,
            "status": dr_result.get("status"),
            "upgrade_reason": dr_result.get("upgrade_reason"),
            "resource_usage": dr_result.get("resource_usage"),
        },
    )

    return {"dr_result": dr_result, "tool_results": step_results, "current_step": "dr"}
