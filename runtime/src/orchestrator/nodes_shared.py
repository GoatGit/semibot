"""Shared helper functions used by orchestrator node modules."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from src.orchestrator.state import AgentState, ExecutionPlan, PlanStep, ToolCallResult

_PROMPT_PAYLOAD_MAX_STRING_CHARS = 500
_PROMPT_PAYLOAD_MAX_LIST_ITEMS = 20
_PROMPT_PAYLOAD_MAX_DICT_ITEMS = 24
_PROMPT_PAYLOAD_MAX_DEPTH = 5


def _tool_result_error_text(result: ToolCallResult | dict[str, Any]) -> str:
    """Extract a normalized error text from a tool result object/dict."""
    if isinstance(result, dict):
        parts = [str(result.get("error") or "")]
        result_payload = result.get("result")
        if isinstance(result_payload, dict):
            parts.append(str(result_payload.get("error") or ""))
            parts.append(str(result_payload.get("code") or ""))
            parts.append(str(result_payload.get("error_code") or ""))
        return " ".join(p for p in parts if p).strip()

    parts = [str(getattr(result, "error", "") or "")]
    result_payload = getattr(result, "result", None)
    if isinstance(result_payload, dict):
        parts.append(str(result_payload.get("error") or ""))
        parts.append(str(result_payload.get("code") or ""))
        parts.append(str(result_payload.get("error_code") or ""))
    return " ".join(p for p in parts if p).strip()


def _infer_artifact_semantics(path_obj: Path, artifact_role: str) -> dict[str, Any]:
    """Simplified generic artifact semantics — no domain-specific inference."""
    role = str(artifact_role or "").strip().lower() or "file"
    artifact_format = path_obj.suffix.lower().lstrip(".") or "binary"

    return {
        "artifact_role": role,
        "artifact_medium": "file",
        "artifact_format": artifact_format,
        "artifact_type": "file",
        "artifact_name": "generated file",
        "artifact_purpose": "generated output artifact",
        "is_likely_final": False,
        "inferred": True,
    }


def _iter_generated_files_from_result(result: ToolCallResult | dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    candidates: list[Any] = []
    if isinstance(result, dict):
        meta = result.get("metadata")
        payload = result.get("result")
        if isinstance(meta, dict):
            candidates.extend(meta.get("generated_files") or [])
        if isinstance(payload, dict):
            candidates.extend(payload.get("generated_files") or [])
    else:
        meta = getattr(result, "metadata", None)
        payload = getattr(result, "result", None)
        if isinstance(meta, dict):
            candidates.extend(meta.get("generated_files") or [])
        if isinstance(payload, dict):
            candidates.extend(payload.get("generated_files") or [])
    for item in candidates:
        if isinstance(item, dict):
            rows.append(item)
    return rows


def _collect_visible_artifacts(tool_results: list[ToolCallResult | dict[str, Any]]) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []
    for row in tool_results:
        metadata = row.get("metadata") if isinstance(row, dict) else getattr(row, "metadata", None)
        metadata = metadata if isinstance(metadata, dict) else {}
        generated = metadata.get("generated_files")
        if isinstance(generated, list):
            for item in generated:
                if not isinstance(item, dict) or item.get("user_visible", True) is False:
                    continue
                artifact = dict(item)
                path_value = str(
                    artifact.get("artifact_result_path")
                    or artifact.get("source_path")
                    or artifact.get("path")
                    or ""
                ).strip()
                if path_value:
                    artifact["artifact_result_path"] = path_value
                if not artifact.get("artifact_medium"):
                    artifact["artifact_medium"] = "file"
                if not artifact.get("artifact_format"):
                    suffix = Path(
                        str(artifact.get("filename") or artifact.get("path") or "")
                    ).suffix.lower().lstrip(".")
                    artifact["artifact_format"] = suffix or "binary"
                if not artifact.get("artifact_type"):
                    inferred = _infer_artifact_semantics(
                        Path(path_value or str(artifact.get("filename") or artifact.get("path") or "artifact")),
                        str(artifact.get("artifact_role") or ""),
                    )
                    artifact["artifact_type"] = inferred.get("artifact_type")
                    artifact["artifact_name"] = artifact.get("artifact_name") or inferred.get("artifact_name")
                    artifact["artifact_purpose"] = artifact.get("artifact_purpose") or inferred.get("artifact_purpose")
                    artifact["is_likely_final"] = bool(
                        artifact.get("is_likely_final", inferred.get("is_likely_final", False))
                    )
                artifacts.append(artifact)
        text_artifact = metadata.get("text_artifact")
        if isinstance(text_artifact, dict):
            text_value = str(text_artifact.get("artifact_result_text") or "").strip()
            if not text_value or text_artifact.get("user_visible", True) is False:
                continue
            artifact = dict(text_artifact)
            artifact.setdefault("artifact_medium", "text")
            artifact.setdefault("artifact_format", "plain_text")
            artifact.setdefault("artifact_role", "text")
            artifact.setdefault("artifact_type", "text_output")
            artifact.setdefault("artifact_name", "text output")
            artifact.setdefault("artifact_purpose", "text output artifact")
            artifacts.append(artifact)
    return artifacts


def _artifact_has_real_file(artifact: dict[str, Any]) -> bool:
    medium = str(artifact.get("artifact_medium") or "").strip().lower()
    path_value = str(artifact.get("artifact_result_path") or "").strip()
    return medium not in {"", "text"} and bool(path_value)


def _artifact_has_real_text(artifact: dict[str, Any]) -> bool:
    return bool(str(artifact.get("artifact_result_text") or "").strip())


def _artifact_result_payloads(entry: dict[str, Any] | None) -> dict[str, list[Any]]:
    payloads: dict[str, list[Any]] = {}
    if not isinstance(entry, dict):
        return payloads
    for key, value in entry.items():
        if not str(key or "").startswith("artifact_result_"):
            continue
        if value in (None, "", [], {}):
            continue
        payloads.setdefault(str(key), []).append(value)
    return payloads


def _has_any_artifact_result_payload(
    artifacts: list[dict[str, Any]],
    latest_structured_act_result: ToolCallResult | None = None,
) -> bool:
    if any(_artifact_result_payloads(item) for item in artifacts):
        return True
    if latest_structured_act_result is not None and isinstance(getattr(latest_structured_act_result, "metadata", None), dict):
        return bool(_artifact_result_payloads(latest_structured_act_result.metadata))
    return False


def _final_delivery_contract_fulfilled(
    *,
    final_delivery_contract: dict[str, Any] | None,
    artifacts: list[dict[str, Any]],
    latest_structured_act_result: ToolCallResult | None = None,
    execution_state: dict[str, Any] | None = None,
) -> tuple[bool, str]:
    has_payload = _has_any_artifact_result_payload(
        artifacts,
        latest_structured_act_result=latest_structured_act_result,
    )
    if not has_payload:
        return False, "final delivery requires at least one non-empty artifact_result_* payload"

    # Contract validation is advisory only — the LLM-generated final_delivery_contract
    # is not reliable enough to block task completion. Log mismatches as warnings
    # but still return fulfilled=True when any artifact payload exists.
    if final_delivery_contract and isinstance(final_delivery_contract, dict):
        import logging
        _logger = logging.getLogger(__name__)
        if final_delivery_contract.get("must_materialize_file"):
            has_file = any(_artifact_has_real_file(a) for a in artifacts)
            if not has_file:
                _logger.warning(
                    "delivery contract wants must_materialize_file but only text artifacts found; "
                    "proceeding anyway since artifact payload exists"
                )
        required_format = str(final_delivery_contract.get("file_format") or "").strip().lower()
        if required_format:
            has_format = any(
                str(a.get("artifact_format") or "").strip().lower() == required_format
                for a in artifacts
            )
            if not has_format:
                _logger.warning(
                    "delivery contract wants format '%s' but no matching artifact found; "
                    "proceeding anyway since artifact payload exists",
                    required_format,
                )

    return True, ""


def _tool_result_success(result: ToolCallResult | dict[str, Any]) -> bool:
    if isinstance(result, dict):
        return bool(result.get("success"))
    return bool(getattr(result, "success", False))


# --- Disabled: search/web_fetch specific error classification (non-generic) ---

def _is_readonly_network_tool_result(result: ToolCallResult | dict[str, Any]) -> bool:  # noqa: ARG001
    return False


def _is_transient_readonly_network_failure(result: ToolCallResult | dict[str, Any]) -> bool:  # noqa: ARG001
    return False


def _is_non_retryable_readonly_api_failure(result: ToolCallResult | dict[str, Any]) -> bool:  # noqa: ARG001
    """Disabled: non-retryable readonly API failure detection (non-generic)."""
    return False


def _current_round_skill_id(state: AgentState, action: PlanStep | None = None) -> str:
    if isinstance(action, PlanStep):
        step_skill = str(action.skill_source or "").strip()
        if step_skill:
            return step_skill
    plan = state.get("plan")
    plan_skill = ""
    if isinstance(plan, ExecutionPlan):
        skill_context = plan.skill_context_for_act
        if isinstance(skill_context, dict):
            plan_skill = str(skill_context.get("skill_id") or "").strip()
        if not plan_skill:
            plan_skill = str(plan.selected_skill or "").strip()
    if plan_skill:
        return plan_skill
    metadata = state.get("metadata") or {}
    trace = metadata.get("skill_orchestration_trace") if isinstance(metadata, dict) else None
    if isinstance(trace, dict):
        return str(trace.get("skill_context_skill_id") or trace.get("selected_skill") or "").strip()
    return ""


def _serialize_tool_backfeed_content(
    *,
    tool_name: str,
    tool_call_id: str,
    payload: Any,
    purpose: str | None = None,
) -> str:
    def _compact_prompt_payload(value: Any, *, depth: int = 0) -> Any:
        if depth >= _PROMPT_PAYLOAD_MAX_DEPTH:
            return "[truncated]"
        if isinstance(value, str):
            if len(value) <= _PROMPT_PAYLOAD_MAX_STRING_CHARS:
                return value
            return value[:_PROMPT_PAYLOAD_MAX_STRING_CHARS] + "...[truncated]"
        if isinstance(value, (int, float, bool)) or value is None:
            return value
        if isinstance(value, list):
            items = [
                _compact_prompt_payload(item, depth=depth + 1)
                for item in value[:_PROMPT_PAYLOAD_MAX_LIST_ITEMS]
            ]
            if len(value) > _PROMPT_PAYLOAD_MAX_LIST_ITEMS:
                items.append(f"...[{len(value) - _PROMPT_PAYLOAD_MAX_LIST_ITEMS} more items truncated]")
            return items
        if isinstance(value, dict):
            compact: dict[str, Any] = {}
            for idx, (key, item) in enumerate(value.items()):
                if idx >= _PROMPT_PAYLOAD_MAX_DICT_ITEMS:
                    compact["__truncated__"] = f"{len(value) - _PROMPT_PAYLOAD_MAX_DICT_ITEMS} more keys truncated"
                    break
                compact[str(key)] = _compact_prompt_payload(item, depth=depth + 1)
            return compact
        return str(value)

    normalized_tool_name = str(tool_name or "").strip().lower()
    default_purpose = "tool_execution_result"
    if normalized_tool_name == "read_skill":
        default_purpose = "planning_methodology_scaffold"
    elif normalized_tool_name == "inspect_sub_agent":
        default_purpose = "delegation_capability_context"
    envelope = {
        "semibot_message_type": "tool_result_v1",
        "toolName": str(tool_name or ""),
        "toolCallId": str(tool_call_id or ""),
        "purpose": str(purpose or default_purpose),
        "payload": _compact_prompt_payload(payload),
    }
    try:
        return json.dumps(envelope, ensure_ascii=False)
    except Exception:
        fallback = {
            "semibot_message_type": "tool_result_v1",
            "toolName": str(tool_name or ""),
            "toolCallId": str(tool_call_id or ""),
            "purpose": str(purpose or default_purpose),
            "payload": str(payload),
        }
        return json.dumps(fallback, ensure_ascii=False)


def _build_assistant_transcript_message(
    *,
    response_content: str,
    tool_calls: list[dict[str, Any]] | None = None,
    reasoning_content: str | None = None,
) -> dict[str, Any]:
    message: dict[str, Any] = {
        "role": "assistant",
        "content": response_content,
    }
    if tool_calls:
        message["tool_calls"] = tool_calls
    if isinstance(reasoning_content, str) and reasoning_content.strip():
        message["reasoning_content"] = reasoning_content
    return message


def _parse_tool_call_arguments(raw_arguments: Any) -> tuple[dict[str, Any], str | None]:
    if isinstance(raw_arguments, dict):
        return raw_arguments, None
    if isinstance(raw_arguments, str):
        text = raw_arguments.strip()
        if not text:
            return {}, None
        try:
            parsed = json.loads(text)
        except Exception as exc:
            return {}, f"Tool call arguments are not valid JSON: {exc}"
        if not isinstance(parsed, dict):
            return {}, "Tool call arguments must decode to a JSON object."
        return parsed, None
    if raw_arguments is None:
        return {}, None
    return {}, f"Unsupported tool call arguments type: {type(raw_arguments).__name__}"
