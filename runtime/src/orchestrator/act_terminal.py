"""ACT terminal JSON parsing, result building, and event payload helpers."""

import json
import re as _re
from contextlib import suppress
from typing import Any

from src.orchestrator.state import AgentState, PlanStep, ToolCallResult
from src.orchestrator.act_context import _infer_text_artifact_type
from src.utils.logging import get_logger

logger = get_logger(__name__)


def _act_response_format() -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "act_response",
            "strict": False,
            "schema": {
                "type": "object",
                "properties": {
                    "execution_concerns": {"type": "string"},
                    "artifact_result_text": {"type": "string"},
                    "artifact_result_path": {"type": "string"},
                },
                "required": [],
                "additionalProperties": True,
            },
        },
    }


def _build_act_decision_event_payload(
    *,
    state: AgentState,
    action: PlanStep,
    decision: str,
    tool_name: str | None,
    arguments: dict[str, Any],
    selected_skill_name: str,
    artifact_result_text: str | None = None,
    artifact_type: str | None = None,
) -> dict[str, Any]:
    plan = state.get("plan")
    inferred_plan_version = max(int(state.get("iteration", 0)) + 1, 1)
    plan_version = int(getattr(plan, "plan_version", 0) or 0) if plan is not None else 0
    return {
        "plan_version": max(plan_version, inferred_plan_version),
        "iteration": max(int(state.get("iteration", 0)), 0),
        "step_id": action.id,
        "title": action.title,
        "planner_phase": action.phase,
        "planner_intent": action.intent,
        "planner_expected_outputs": action.expected_outputs,
        "planner_completion_criteria": action.completion_criteria,
        "decision": decision,
        "tool_name": tool_name,
        "arguments": arguments,
        "selected_skill": selected_skill_name,
        "artifact_result_text": artifact_result_text,
        "artifact_type": artifact_type,
    }


def _step_requires_interactive_browser(action: PlanStep, latest_user_text: str = "") -> bool:
    phase = str(action.phase or "").strip().lower()
    title = str(action.title or "").strip().lower()
    intent = str(action.intent or "").strip().lower()
    expected = " ".join(str(item) for item in (action.expected_outputs or []))
    haystack = " ".join([phase, title, intent, expected, str(latest_user_text or "").strip()]).lower()
    interactive_keywords = (
        "browser",
        "click",
        "login",
        "form",
        "scroll",
        "open page",
        "page interaction",
        "page state",
        "截图",
        "点击",
        "登录",
        "表单",
        "滚动",
        "页面交互",
        "动态页面",
        "浏览器",
    )
    return any(keyword in haystack for keyword in interactive_keywords)


def _build_text_artifact_payload(action: PlanStep, text: str) -> dict[str, Any]:
    output_contract = action.output_contract
    artifact_type = _infer_text_artifact_type(action)
    artifact_role = (
        str(getattr(output_contract, "artifact_role", "") or "").strip()
        or "text"
    )
    handoff_purpose = (
        str(getattr(output_contract, "handoff_purpose", "") or "").strip()
        or "reasoning_continuation"
    )
    return {
        "artifact_medium": "text",
        "artifact_format": "plain_text",
        "artifact_type": artifact_type,
        "artifact_role": artifact_role,
        "artifact_name": str(action.title or "text output").strip() or "text output",
        "artifact_purpose": (
            str(action.intent or "text output artifact").strip() or "text output artifact"
        ),
        "artifact_result_text": text,
        "is_likely_final": artifact_type in {"research_report", "validation_result"},
        "source_step_id": str(action.id or "").strip(),
        "source_step_title": str(action.title or "").strip(),
        "handoff_mode": (
            str(getattr(output_contract, "handoff_mode", "") or "").strip()
            or "reasoning_text"
        ),
        "handoff_purpose": handoff_purpose,
    }


def _parse_structured_json_object(response_text: str) -> dict[str, Any] | None:
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
    code_fence_match = _re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, _re.DOTALL)
    if code_fence_match:
        candidate = code_fence_match.group(1)
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
                object_candidates.append(text[start_idx:idx + 1])
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


def _structured_json_diagnostics(response_text: str) -> dict[str, Any]:
    text = str(response_text or "").strip()
    if not text:
        return {
            "content_len": 0,
            "starts_with_brace": False,
            "ends_with_brace": False,
            "brace_balance": 0,
            "looks_truncated_json": False,
            "prefix": "",
            "suffix": "",
        }

    depth = 0
    in_string = False
    escaped = False
    for ch in text:
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
        elif ch == "}":
            depth -= 1

    starts_with_brace = text.startswith("{")
    ends_with_brace = text.endswith("}")
    looks_truncated_json = starts_with_brace and (depth > 0 or not ends_with_brace)
    return {
        "content_len": len(text),
        "starts_with_brace": starts_with_brace,
        "ends_with_brace": ends_with_brace,
        "brace_balance": depth,
        "looks_truncated_json": looks_truncated_json,
        "prefix": text[:240],
        "suffix": text[-240:],
    }


def _build_llm_act_terminal_result(
    *,
    action: PlanStep,
    payload: dict[str, Any],
) -> ToolCallResult:
    observations = payload.get("observations") if isinstance(payload.get("observations"), list) else []
    observation_summaries = [
        str(item.get("summary") or "").strip()
        for item in observations
        if isinstance(item, dict) and str(item.get("summary") or "").strip()
    ]
    artifacts_produced = [
        str(item or "").strip()
        for item in (payload.get("artifacts_produced") if isinstance(payload.get("artifacts_produced"), list) else [])
        if str(item or "").strip()
    ]
    summary_text = "\n".join(observation_summaries[:6]).strip()

    extracted_data = str(
        payload.get("extracted_data")
        or payload.get("completionText")
        or payload.get("completion_text")
        or payload.get("artifact_result_text")
        or payload.get("artifactResultText")
        or ""
    ).strip()
    # LLMs sometimes double-escape newlines in JSON string values (\\n instead
    # of \n), which after json.loads become literal two-char sequences.  Unescape
    # common control characters so the delivered text renders correctly.
    if extracted_data and "\\n" in extracted_data:
        extracted_data = (
            extracted_data
            .replace("\\n", "\n")
            .replace("\\t", "\t")
        )
        extracted_data = extracted_data.strip()
    artifact_text_value = extracted_data or summary_text
    if extracted_data:
        if summary_text:
            summary_text += "\n\nExtracted Data:\n" + extracted_data
        else:
            summary_text = extracted_data

    # Extract execution_concerns — ACT reports problems here instead of deciding to replan.
    execution_concerns = str(payload.get("execution_concerns") or "").strip()

    # --- System-derived decision (LLM no longer declares this) ---
    # Decision is derived from EXPLICIT artifact presence in the payload,
    # NOT from observation summaries (which are progress notes, not deliverables).
    has_explicit_artifact_text = bool(extracted_data and len(extracted_data) > 20)
    has_artifact_path = bool(str(payload.get("artifact_result_path") or "").strip())
    has_artifact = has_explicit_artifact_text or has_artifact_path or bool(artifacts_produced)

    # Legacy LLM outputs may still include "decision"; capture for backward-compat logging only.
    legacy_llm_decision = str(payload.get("decision") or "").strip().lower()
    if legacy_llm_decision == "replan" and not execution_concerns:
        execution_concerns = str(payload.get("reason") or payload.get("replan_reason") or "execution encountered issues").strip()

    if has_artifact:
        decision = "advance_step"
    else:
        decision = "continue_current_step"

    if legacy_llm_decision and legacy_llm_decision != decision:
        logger.debug(
            "act_decision_override",
            extra={
                "step_id": str(action.id or ""),
                "llm_declared": legacy_llm_decision,
                "system_derived": decision,
            },
        )

    if not summary_text:
        summary_text = f"Step '{action.title}' finished ({decision})."
    if artifacts_produced:
        summary_text += "\nArtifacts:\n" + "\n".join(f"- {item}" for item in artifacts_produced[:8])
    text_artifact = _build_text_artifact_payload(action, artifact_text_value or summary_text)
    result_metadata: dict[str, Any] = {
        "capability_type": "llm",
        "act_result_type": "execution_result",
        "act_result_payload": payload,
        "act_decision": decision,
        "act_step_id": str(action.id or "").strip(),
        "act_observations": observations,
        "act_artifacts_produced": artifacts_produced,
        "text_artifact": text_artifact,
        "artifact_result_text": text_artifact.get("artifact_result_text"),
        "artifact_result_path": str(payload.get("artifact_result_path") or "").strip() or None,
        "artifact_type": text_artifact.get("artifact_type"),
        "artifact_medium": text_artifact.get("artifact_medium"),
        "artifact_format": text_artifact.get("artifact_format"),
        "artifact_name": text_artifact.get("artifact_name"),
        "artifact_purpose": text_artifact.get("artifact_purpose"),
    }
    if execution_concerns:
        result_metadata["execution_concerns"] = execution_concerns
    # Lazy import to avoid circular dependency (act_terminal ↔ act_tool_executor).
    from src.orchestrator.act_tool_executor import _ensure_step_result_handoff_contract
    return _ensure_step_result_handoff_contract(action, ToolCallResult(
        tool_name="llm_act",
        params={"title": action.title},
        result=summary_text,
        success=True,
        metadata=result_metadata,
    ))


def _terminal_result_is_fake_partial_progress(
    terminal_result: ToolCallResult,
    *,
    tool_call_count: int,
) -> bool:
    """Detect terminal results that represent no real progress.

    Returns True when the terminal phase produced no explicit artifacts and no tool calls
    were made — i.e. the LLM emitted a terminal JSON without doing any work.
    Observation summaries (which fall back into artifact_result_text in metadata) are NOT
    considered real artifacts for this check.
    """
    if not terminal_result.success:
        return False
    if tool_call_count > 0:
        return False
    metadata = terminal_result.metadata if isinstance(terminal_result.metadata, dict) else {}
    # Check the RAW payload for explicit artifact fields (not the metadata which includes
    # fallback summary text as artifact_result_text).
    payload = metadata.get("act_result_payload") if isinstance(metadata.get("act_result_payload"), dict) else {}
    explicit_artifact_text = str(
        payload.get("extracted_data")
        or payload.get("completionText")
        or payload.get("completion_text")
        or payload.get("artifact_result_text")
        or payload.get("artifactResultText")
        or ""
    ).strip()
    if explicit_artifact_text and len(explicit_artifact_text) > 20:
        return False
    if str(payload.get("artifact_result_path") or "").strip():
        return False
    artifacts = [str(item or "").strip() for item in (metadata.get("act_artifacts_produced") or []) if str(item or "").strip()]
    if artifacts:
        return False
    if any(str(key).startswith("artifact_result_") and payload.get(key) not in (None, "", [], {}) for key in payload):
        return False
    return True


def _terminal_result_allows_step_advance(
    terminal: ToolCallResult | None,
    *,
    action: PlanStep,
) -> bool:
    """Check whether a terminal result indicates the step should advance.

    System-derived: a successful terminal result with act_decision == "advance_step"
    (set by _build_llm_act_terminal_result based on artifact presence) means advance.
    """
    if terminal is None or not terminal.success:
        return False

    metadata = terminal.metadata if isinstance(terminal.metadata, dict) else {}
    return str(metadata.get("act_decision") or "").strip().lower() == "advance_step"


# ---------------------------------------------------------------------------
# Loop-level helpers called from the rewritten _execute_llm_act_step
# ---------------------------------------------------------------------------


def validate_act_terminal_response(
    *,
    response: Any,
    state: AgentState,
    action: PlanStep,
    step_transcript: list[dict[str, Any]],
    step_results: list[ToolCallResult],
    act_loop_trace: list[dict[str, Any]],
    turn_count: int,
    act_phase: str,
    terminal_retry_count: int,
    max_terminal_retries: int,
    tool_call_count: int,
) -> dict[str, Any]:
    """Validate terminal JSON from the LLM response.

    Returns a signal dict:
      {"action": "accepted", "structured_payload": {...}, "completion_text": "..."}
      {"action": "continue", "act_phase": "terminal", "terminal_retry_count": N}
      {"action": "return"}
    """
    from src.orchestrator.nodes_shared import _build_assistant_transcript_message
    from src.orchestrator.act_context import (
        _persist_act_loop_trace_to_state,
        _persist_step_transcript_to_state,
    )

    completion_text = str(response.content or "").strip()
    structured_payload = _parse_structured_json_object(completion_text)
    legacy_decision = str(structured_payload.get("decision") or "").strip().lower() if structured_payload else ""
    legacy_type = str(structured_payload.get("type") or "").strip().lower() if structured_payload else ""
    is_valid_terminal = bool(structured_payload) and (
        legacy_decision in {"continue_current_step", "advance_step", "complete_task", "replan"}
        or legacy_type in {"execution_result", "execution_blocked"}
        or any(
            str(key).startswith("artifact_result_") and structured_payload.get(key) not in (None, "", [], {})
            for key in structured_payload
        )
        or str(structured_payload.get("execution_concerns") or "").strip()
        or isinstance(structured_payload.get("observations"), list)
    )

    if is_valid_terminal:
        return {"action": "accepted", "structured_payload": structured_payload, "completion_text": completion_text}

    # Invalid terminal JSON — handle retries
    diagnostics = _structured_json_diagnostics(completion_text)
    logger.warning(
        "act_terminal_json_invalid",
        extra={
            "session_id": state["session_id"],
            "step_id": str(action.id or "").strip(),
            "turn_count": turn_count,
            "finish_reason": str(getattr(response, "finish_reason", "") or ""),
            "usage": dict(getattr(response, "usage", {}) or {}),
            "tool_call_count": tool_call_count,
            "transcript_len": len(step_transcript),
            **diagnostics,
        },
    )

    if act_phase == "tool":
        step_transcript.append(
            _build_assistant_transcript_message(
                response_content=completion_text,
                tool_calls=None,
                reasoning_content=getattr(response, "reasoning_content", None),
            )
        )
        _persist_step_transcript_to_state(state, action.id, step_transcript)
        act_loop_trace.append({
            "turn_index": turn_count,
            "phase": act_phase,
            "outcome": "switch_to_terminal_phase",
            "reason": "invalid_terminal_json_retry",
            "response_excerpt": completion_text[:500],
        })
        _persist_act_loop_trace_to_state(state, action.id, act_loop_trace)
        return {"action": "continue", "act_phase": "terminal", "terminal_retry_count": terminal_retry_count}

    if act_phase == "terminal" and terminal_retry_count < max_terminal_retries:
        new_retry = terminal_retry_count + 1
        step_transcript.append(
            _build_assistant_transcript_message(
                response_content=completion_text,
                tool_calls=None,
                reasoning_content=getattr(response, "reasoning_content", None),
            )
        )
        _persist_step_transcript_to_state(state, action.id, step_transcript)
        act_loop_trace.append({
            "turn_index": turn_count,
            "phase": act_phase,
            "outcome": "retry_terminal_phase",
            "retry_index": new_retry,
            "response_excerpt": completion_text[:500],
        })
        _persist_act_loop_trace_to_state(state, action.id, act_loop_trace)
        return {"action": "continue", "act_phase": "terminal", "terminal_retry_count": new_retry}

    # Exhausted retries
    validation_error = (
        "ACT terminal response must be a JSON object with artifact_result_text, "
        "artifact_result_path, observations, or execution_concerns."
    )
    step_transcript.append(
        _build_assistant_transcript_message(
            response_content=completion_text,
            tool_calls=None,
            reasoning_content=getattr(response, "reasoning_content", None),
        )
    )
    _persist_step_transcript_to_state(state, action.id, step_transcript)
    act_loop_trace.append({
        "turn_index": turn_count,
        "phase": act_phase,
        "outcome": "rejected",
        "rejection_reason": "invalid_terminal_json",
        "response_excerpt": completion_text[:500],
    })
    _persist_act_loop_trace_to_state(state, action.id, act_loop_trace)
    step_results.append(
        ToolCallResult(
            tool_name="llm_act",
            params={"title": action.title},
            error=validation_error,
            success=False,
            metadata={"guard": "llm_act_validation"},
        )
    )
    return {"action": "return"}


async def finalize_act_terminal_result(
    *,
    structured_payload: dict[str, Any],
    completion_text: str,
    response: Any,
    state: AgentState,
    action: PlanStep,
    step_transcript: list[dict[str, Any]],
    step_results: list[ToolCallResult],
    act_loop_trace: list[dict[str, Any]],
    turn_count: int,
    act_phase: str,
    tool_call_count: int,
    current_skill_id: str,
    event_emitter: Any | None,
) -> list[ToolCallResult]:
    """Build terminal result, check for fake progress, emit events, return final results."""
    from src.orchestrator.nodes_shared import _build_assistant_transcript_message
    from src.orchestrator.act_context import (
        _persist_act_loop_trace_to_state,
        _persist_step_transcript_to_state,
    )

    step_transcript.append(
        _build_assistant_transcript_message(
            response_content=completion_text,
            tool_calls=None,
            reasoning_content=getattr(response, "reasoning_content", None),
        )
    )
    _persist_step_transcript_to_state(state, action.id, step_transcript)
    act_loop_trace.append({
        "turn_index": turn_count,
        "phase": act_phase,
        "outcome": "terminal_json_accepted",
        "decision": str(structured_payload.get("decision") or structured_payload.get("type") or "").strip().lower(),
    })
    _persist_act_loop_trace_to_state(state, action.id, act_loop_trace)

    terminal_result = _build_llm_act_terminal_result(
        action=action,
        payload=structured_payload,
    )
    if _terminal_result_is_fake_partial_progress(
        terminal_result,
        tool_call_count=tool_call_count,
    ):
        validation_error = (
            "ACT terminal response reported partial_progress/continue without any real tool execution, "
            "completed step, or produced artifact. Execute the required tool first or return a terminal "
            "result that honestly reflects the current step state."
        )
        step_results.append(
            ToolCallResult(
                tool_name="llm_act",
                params={"title": action.title},
                error=validation_error,
                success=False,
                metadata={"guard": "llm_act_validation"},
            )
        )
        return step_results

    if event_emitter:
        await event_emitter.emit(
            "act_decision",
            {
                **_build_act_decision_event_payload(
                    state=state,
                    action=action,
                    decision="no_tool",
                    tool_name=None,
                    arguments={},
                    selected_skill_name=current_skill_id,
                    artifact_result_text=str(
                        (terminal_result.metadata or {}).get("artifact_result_text") or ""
                    ),
                    artifact_type=str((terminal_result.metadata or {}).get("artifact_type") or ""),
                ),
                "artifact_medium": (terminal_result.metadata or {}).get("artifact_medium"),
                "artifact_format": (terminal_result.metadata or {}).get("artifact_format"),
                "artifact_name": (terminal_result.metadata or {}).get("artifact_name"),
                "artifact_purpose": (terminal_result.metadata or {}).get("artifact_purpose"),
                "completion_text": completion_text,
                "act_decision": (terminal_result.metadata or {}).get("act_decision"),
            },
        )
    step_results.append(terminal_result)
    return step_results