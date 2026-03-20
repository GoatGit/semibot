"""ACT context building, transcript management, and step memory helpers."""

import re as _re
from pathlib import Path
from typing import Any

from src.orchestrator.context_budget import ACT_TOOL_BUDGET, get_act_budget
from src.orchestrator.state import AgentState, PlanStep, ToolCallResult
from src.orchestrator.nodes_stateflow import _build_act_artifact_context
from src.utils.logging import get_logger

logger = get_logger(__name__)


def _match_generated_artifact_reference(
    generated: list[str],
    raw_reference: str,
) -> str | None:
    reference = str(raw_reference or "").strip().strip("'\"")
    if not reference or reference.startswith("/"):
        return None
    normalized_reference = reference.replace("\\", "/").lstrip("./")
    basename = Path(normalized_reference).name
    if not basename:
        return None

    for candidate in reversed(generated):
        try:
            candidate_path = Path(str(candidate)).expanduser().resolve()
        except Exception:
            continue
        if not candidate_path.exists():
            continue
        candidate_norm = str(candidate_path).replace("\\", "/")
        if candidate_path.name == basename or candidate_norm.endswith(normalized_reference):
            return str(candidate_path)
    return None


def _normalize_workspace_rel_path(raw_path: str) -> str:
    value = str(raw_path or "").strip().strip("'\"").replace("\\", "/")
    if value in {"", ".", "./"}:
        return "."
    parts: list[str] = []
    for part in value.split("/"):
        token = part.strip()
        if token in {"", "."}:
            continue
        if token == "..":
            if parts:
                parts.pop()
            continue
        parts.append(token)
    return "/".join(parts) if parts else "."


def _semantic_file_tokens(raw_path: str) -> set[str]:
    normalized = _normalize_workspace_rel_path(raw_path)
    name = Path(normalized).stem.lower()
    tokens = {
        token
        for token in _re.split(r"[^a-z0-9]+", name)
        if token and len(token) > 1 and token not in {"current", "final", "latest", "new"}
    }
    return tokens


def _paths_look_semantically_equivalent(left: str, right: str) -> bool:
    left_norm = _normalize_workspace_rel_path(left)
    right_norm = _normalize_workspace_rel_path(right)
    if left_norm == right_norm:
        return True
    left_path = Path(left_norm)
    right_path = Path(right_norm)
    if left_path.suffix.lower() != right_path.suffix.lower():
        return False
    left_tokens = _semantic_file_tokens(left_norm)
    right_tokens = _semantic_file_tokens(right_norm)
    if not left_tokens or not right_tokens:
        return False
    overlap = left_tokens & right_tokens
    denominator = max(len(left_tokens), len(right_tokens))
    return bool(overlap) and (len(overlap) / denominator) >= 0.6


def _build_step_memory(
    step_results: list[ToolCallResult],
    runtime_context: Any | None,
) -> dict[str, list[dict[str, Any]]]:
    loaded_resources: list[dict[str, Any]] = []
    modified_resources: list[dict[str, Any]] = []
    current_outputs: list[dict[str, Any]] = []
    current_primary_output: dict[str, Any] | None = None
    seen_loaded: set[str] = set()
    seen_modified: set[str] = set()
    seen_outputs: set[tuple[str, str]] = set()

    for row in step_results:
        if not getattr(row, "success", False):
            continue
        tool_name = str(getattr(row, "tool_name", "") or "").strip()
        params = getattr(row, "params", {}) or {}
        metadata = getattr(row, "metadata", {}) or {}

        if tool_name == "file_io":
            action_name = str(params.get("action") or params.get("operation") or "").strip().lower()
            raw_path = str(params.get("path") or "").strip()
            normalized_path = _normalize_workspace_rel_path(raw_path)
            if action_name == "read" and normalized_path != "." and normalized_path not in seen_loaded:
                row_result = getattr(row, "result", None)
                content = ""
                truncated = False
                if isinstance(row_result, dict):
                    content = str(row_result.get("content") or "")
                    truncated = bool(row_result.get("truncated", False))
                loaded_resources.append(
                    {
                        "path": normalized_path,
                        "kind": "file_io_read",
                        "content_length": len(content),
                        "truncated": truncated,
                        "content_preview": content[:240],
                    }
                )
                seen_loaded.add(normalized_path)
            if action_name in {"write", "edit"} and normalized_path != ".":
                if normalized_path not in seen_modified:
                    modified_resources.append(
                        {
                            "path": normalized_path,
                            "kind": f"file_io_{action_name}",
                        }
                    )
                    seen_modified.add(normalized_path)
                output_key = ("path", normalized_path)
                if output_key not in seen_outputs:
                    content_preview = ""
                    row_result = getattr(row, "result", None)
                    if isinstance(row_result, dict):
                        content_preview = str(row_result.get("content_preview") or "").strip()
                    if not content_preview and action_name == "write":
                        content_preview = str(params.get("content") or "").strip()
                    output_item = {
                        "artifact_name": Path(normalized_path).name or normalized_path,
                        "artifact_type": "workspace_file",
                        "artifact_medium": "file",
                        "artifact_format": Path(normalized_path).suffix.lstrip(".").lower() or "text",
                        "artifact_purpose": f"current step {action_name} target",
                        "artifact_result_path": normalized_path,
                        "workspace_relative_path": normalized_path,
                        "artifact_result_text": content_preview[:2000] if content_preview else "",
                    }
                    current_outputs.append(output_item)
                    current_primary_output = output_item
                    seen_outputs.add(output_key)

        text_artifact = metadata.get("text_artifact")
        if isinstance(text_artifact, dict):
            text_value = str(text_artifact.get("artifact_result_text") or "").strip()
            artifact_name = str(text_artifact.get("artifact_name") or "").strip()
            output_key = ("text", artifact_name or text_value[:80])
            if text_value and output_key not in seen_outputs:
                output_item = {
                    "artifact_name": artifact_name or "text_output",
                    "artifact_type": str(text_artifact.get("artifact_type") or "text_output"),
                    "artifact_medium": str(text_artifact.get("artifact_medium") or "text"),
                    "artifact_format": str(text_artifact.get("artifact_format") or "plain_text"),
                    "artifact_purpose": str(text_artifact.get("artifact_purpose") or "current step text output"),
                    "artifact_result_text": text_value[:2000],
                    "is_likely_final": bool(text_artifact.get("is_likely_final")),
                }
                current_outputs.append(output_item)
                current_primary_output = output_item
                seen_outputs.add(output_key)

    artifact_context = _build_act_artifact_context(step_results, runtime_context)
    for item in artifact_context:
        artifact_path = str(item.get("artifact_result_path") or "").strip()
        artifact_text = str(item.get("artifact_result_text") or "").strip()
        output_key = ("path", artifact_path) if artifact_path else ("text", artifact_text[:80])
        if output_key in seen_outputs:
            continue
        current_outputs.append(item)
        current_primary_output = item
        seen_outputs.add(output_key)

    return {
        "already_loaded_resources": loaded_resources[:20],
        "modified_resources": modified_resources[:20],
        "current_step_outputs": current_outputs[:20],
        "current_primary_output": current_primary_output or {},
    }




def _format_loaded_resource_summary(step_memory: dict[str, Any]) -> str:
    loaded = step_memory.get("already_loaded_resources") or []
    modified = step_memory.get("modified_resources") or []
    lines: list[str] = []
    if loaded:
        lines.append("Already loaded files in this step:")
        for item in loaded[:12]:
            path = str(item.get("path") or "").strip()
            if not path:
                continue
            details = [
                "read_success=true",
                f"truncated={bool(item.get('truncated', False))}",
                f"content_length={int(item.get('content_length') or 0)}",
            ]
            preview = str(item.get("content_preview") or "").strip().replace("\n", " ")
            if preview:
                details.append(f"preview={preview[:120]}")
            lines.append(f"- {path} ({', '.join(details)})")
        lines.append("Do not read the same file again unless that file was modified in this step.")
    else:
        lines.append("Already loaded files in this step:\n- none")

    if modified:
        lines.append("")
        lines.append("Files modified in this step:")
        for item in modified[:12]:
            path = str(item.get("path") or "").strip()
            if not path:
                continue
            lines.append(f"- {path} ({str(item.get('kind') or 'file_io_write')})")
    else:
        lines.append("")
        lines.append("Files modified in this step:\n- none")

    return "\n".join(lines).strip()


def _truncate_act_prompt_text(text: str, max_chars: int = ACT_TOOL_BUDGET.max_system_prompt_chars) -> str:
    normalized = str(text or "")
    if len(normalized) <= max_chars:
        return normalized
    # Keep the tail (output_contract, input_bindings) which is more critical
    # for correct execution than the head (user request, goals).
    prefix = "\n[act prompt truncated — head removed]\n\n"
    keep = max(max_chars - len(prefix), 0)
    return prefix + normalized[-keep:]


def _truncate_act_message_content(value: Any, max_chars: int = 2000) -> Any:
    if not isinstance(value, str):
        return value
    if len(value) <= max_chars:
        return value
    return value[:max_chars] + "...[truncated]"


def _assistant_tool_call_ids(message: dict[str, Any]) -> set[str]:
    if str(message.get("role") or "").strip().lower() != "assistant":
        return set()
    raw_tool_calls = message.get("tool_calls")
    if not isinstance(raw_tool_calls, list):
        return set()
    return {
        str(call.get("id") or "").strip()
        for call in raw_tool_calls
        if isinstance(call, dict) and str(call.get("id") or "").strip()
    }


def _parallel_step_group_is_safe(group: list[PlanStep]) -> bool:
    if len(group) <= 1:
        return False
    safe_tools = {"search", "web_fetch", "http_client"}
    group_ids = {str(item.id or "").strip() for item in group if str(item.id or "").strip()}
    if not group_ids:
        return False
    for step in group:
        tool_name = str(step.tool or "").strip().lower()
        if tool_name not in safe_tools:
            return False
        for input_ref in getattr(step, "input_refs", []) or []:
            source_step_id = str(getattr(input_ref, "source_step_id", "") or "").strip()
            if source_step_id and source_step_id in group_ids:
                return False
    return True


def _chunk_act_transcript(messages: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    chunks: list[list[dict[str, Any]]] = []
    index = 0
    while index < len(messages):
        message = messages[index]
        if not isinstance(message, dict):
            index += 1
            continue
        tool_call_ids = _assistant_tool_call_ids(message)
        if not tool_call_ids:
            chunks.append([message])
            index += 1
            continue

        chunk = [message]
        index += 1
        while index < len(messages):
            next_message = messages[index]
            if not isinstance(next_message, dict):
                index += 1
                continue
            if str(next_message.get("role") or "").strip().lower() != "tool":
                break
            tool_call_id = str(next_message.get("tool_call_id") or "").strip()
            if tool_call_id not in tool_call_ids:
                break
            chunk.append(next_message)
            index += 1
        chunks.append(chunk)
    return chunks


def _compact_act_transcript(messages: list[dict[str, Any]], *, max_messages: int = ACT_TOOL_BUDGET.max_history_messages) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    remaining = max_messages
    for chunk in reversed(_chunk_act_transcript(messages)):
        chunk_len = len(chunk)
        if chunk_len > remaining:
            if chunk_len > 1:
                continue
            if remaining <= 0:
                continue
        selected = chunk + selected
        remaining -= chunk_len
        if remaining <= 0:
            break

    compact: list[dict[str, Any]] = []
    for message in selected:
        if not isinstance(message, dict):
            continue
        item = dict(message)
        if "content" in item:
            # Skip per-message truncation — _compact_prompt_payload already
            # handles structural compaction inside _serialize_tool_backfeed_content.
            # The old 3000-char hard cut destroyed batch search results.
            pass
        if "reasoning_content" in item:
            item["reasoning_content"] = _truncate_act_message_content(item.get("reasoning_content"), 600)
        compact.append(item)
    return compact


def _compact_act_artifact_context(artifacts: list[dict[str, Any]], *, max_items: int = ACT_TOOL_BUDGET.max_artifact_items) -> list[dict[str, Any]]:
    compact: list[dict[str, Any]] = []
    for item in artifacts[:max_items]:
        if not isinstance(item, dict):
            continue
        normalized = dict(item)
        if "artifact_result_text" in normalized:
            normalized["artifact_result_text"] = _truncate_act_message_content(
                normalized.get("artifact_result_text"),
                ACT_TOOL_BUDGET.max_artifact_text_chars,
            )
        compact.append(normalized)
    return compact


def _filter_historical_tool_results_for_artifact_context(
    tool_results: list[ToolCallResult],
) -> list[ToolCallResult]:
    """Return only terminal step results from historical tool_results.

    Intermediate tool calls (search, file_io, etc.) from previous steps don't
    contribute meaningful artifact info to artifact_context — their artifacts are
    already summarised in the terminal result's metadata. Filtering them out
    reduces the list size significantly in multi-step tasks.
    """
    filtered: list[ToolCallResult] = []
    for r in tool_results:
        # Results with non-dict metadata (e.g. None) are treated as intermediate
        # and dropped — the Pydantic default is dict, so this only affects
        # externally constructed or deserialized results.
        meta = r.metadata if isinstance(r.metadata, dict) else {}
        if meta.get("act_result_type") == "execution_result":
            filtered.append(r)
        elif meta.get("generated_files"):
            # Keep file-generating tool results (e.g. file_io) even if not terminal
            filtered.append(r)
    dropped = len(tool_results) - len(filtered)
    if dropped > 0:
        logger.debug(
            "artifact_context_filter_dropped_intermediate",
            extra={"total": len(tool_results), "kept": len(filtered), "dropped": dropped},
        )
    return filtered


def _get_step_transcripts(metadata: dict[str, Any] | None) -> dict[str, list[dict[str, Any]]]:
    if not isinstance(metadata, dict):
        return {}
    raw = metadata.get("step_transcripts")
    if not isinstance(raw, dict):
        return {}
    normalized: dict[str, list[dict[str, Any]]] = {}
    for key, value in raw.items():
        if not isinstance(key, str) or not isinstance(value, list):
            continue
        normalized[key] = [item for item in value if isinstance(item, dict)]
    return normalized


def _set_step_transcript(
    metadata: dict[str, Any] | None,
    step_id: str,
    messages: list[dict[str, Any]],
) -> dict[str, Any]:
    next_metadata = dict(metadata or {})
    transcripts = _get_step_transcripts(next_metadata)
    transcripts[step_id] = [item for item in messages if isinstance(item, dict)]
    next_metadata["step_transcripts"] = transcripts
    return next_metadata


def _persist_step_transcript_to_state(
    state: AgentState,
    step_id: str,
    messages: list[dict[str, Any]],
) -> dict[str, Any]:
    live_metadata = dict(state.get("metadata") or {})
    next_metadata = _set_step_transcript(live_metadata, step_id, messages)
    state["metadata"] = next_metadata
    return next_metadata


def _persist_act_loop_trace_to_state(
    state: AgentState,
    step_id: str,
    trace: list[dict[str, Any]],
) -> dict[str, Any]:
    live_metadata = dict(state.get("metadata") or {})
    trace_map = dict(live_metadata.get("act_loop_trace_by_step") or {})
    trace_map[str(step_id or "").strip()] = [item for item in trace if isinstance(item, dict)]
    live_metadata["act_loop_trace_by_step"] = trace_map
    state["metadata"] = live_metadata
    return live_metadata


def _infer_text_artifact_type(action: PlanStep) -> str:
    phase = str(action.phase or "").strip().lower()
    title = str(action.title or "").strip().lower()
    intent = str(action.intent or "").strip().lower()
    expected = " ".join(str(item) for item in (action.expected_outputs or []))
    haystack = " ".join([phase, title, intent, expected]).lower()
    if "scope" in haystack or "范围" in haystack or "outline" in haystack or "大纲" in haystack:
        return "scope_definition"
    if "validate" in haystack or "验证" in haystack:
        return "validation_result"
    if "report" in haystack or "报告" in haystack:
        return "research_report"
    if "search" in haystack or "retrieve" in haystack or "检索" in haystack:
        return "search_results_summary"
    if "synth" in haystack or "analysis" in haystack or "综合" in haystack or "分析" in haystack:
        return "analysis_synthesis"
    return "text_output"


def _resolved_step_output_contract(action: PlanStep) -> dict[str, Any]:
    if action.output_contract is not None:
        return {
            "primary_output_kind": str(action.output_contract.primary_output_kind or "").strip() or "text_output",
            "handoff_mode": str(action.output_contract.handoff_mode or "").strip() or "reasoning_text",
            "artifact_role": str(action.output_contract.artifact_role or "").strip() or "text",
            "must_produce_text": bool(action.output_contract.must_produce_text),
            "must_materialize_file": bool(action.output_contract.must_materialize_file),
            "file_format": str(action.output_contract.file_format or "").strip() or None,
            "handoff_purpose": str(action.output_contract.handoff_purpose or "").strip() or "reasoning_continuation",
        }
    artifact_type = _infer_text_artifact_type(action)
    if artifact_type == "research_report":
        return {
            "primary_output_kind": "report_markdown",
            "handoff_mode": "text_and_file",
            "artifact_role": "report_md",
            "must_produce_text": True,
            "must_materialize_file": True,
            "file_format": "md",
            "handoff_purpose": "user_delivery",
        }
    if artifact_type == "search_results_summary":
        return {
            "primary_output_kind": "evidence_bundle",
            "handoff_mode": "reasoning_text",
            "artifact_role": "evidence_bundle",
            "must_produce_text": True,
            "must_materialize_file": False,
            "file_format": None,
            "handoff_purpose": "reasoning_continuation",
        }
    if artifact_type in {"scope_definition", "analysis_synthesis", "validation_result"}:
        return {
            "primary_output_kind": artifact_type,
            "handoff_mode": "reasoning_text",
            "artifact_role": "text",
            "must_produce_text": True,
            "must_materialize_file": False,
            "file_format": None,
            "handoff_purpose": "reasoning_continuation",
        }
    return {
        "primary_output_kind": "text_output",
        "handoff_mode": "reasoning_text",
        "artifact_role": "text",
        "must_produce_text": True,
        "must_materialize_file": False,
        "file_format": None,
        "handoff_purpose": "reasoning_continuation",
    }
