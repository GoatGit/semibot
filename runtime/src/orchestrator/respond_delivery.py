"""Delivery payload construction and rendering for the RESPOND node."""

from __future__ import annotations

import json
import re as _re
from typing import Any

from src.orchestrator.nodes_shared import (
    _artifact_result_payloads,
    _iter_generated_files_from_result,
)
from src.orchestrator.state import AgentState, ToolCallResult
from src.utils.logging import get_logger

logger = get_logger(__name__)


def _extract_search_results(tool_results: list[ToolCallResult]) -> list[dict[str, Any]]:
    """Extract structured search results from prior tool call results."""
    search_results: list[dict[str, Any]] = []
    for tr in tool_results:
        if tr.tool_name == "code_executor" or not tr.success:
            continue
        result_data = tr.result

        extra_content = ""
        metadata = getattr(tr, "metadata", None)
        if isinstance(metadata, dict):
            text_artifact = metadata.get("text_artifact")
            if isinstance(text_artifact, dict) and text_artifact.get("artifact_result_text"):
                extra_content = "\n" + str(text_artifact.get("artifact_result_text"))

        if isinstance(result_data, str):
            try:
                result_data = json.loads(result_data)
            except (json.JSONDecodeError, TypeError):
                if "Title:" in result_data and "URL:" in result_data:
                    blocks = _re.split(r"\n\s*Title:\s*", result_data)
                    for block in blocks:
                        block = block.strip()
                        if not block:
                            continue
                        title_match = _re.match(r"^(.+?)(?:\n|$)", block)
                        url_match = _re.search(r"URL:\s*(\S+)", block)
                        content_match = _re.search(r"Content:\s*(.+)", block, _re.DOTALL)
                        if title_match:
                            search_results.append(
                                {
                                    "title": title_match.group(1).strip(),
                                    "url": url_match.group(1).strip() if url_match else "",
                                    "content": (content_match.group(1).strip() + extra_content)[:3000]
                                    if content_match
                                    else extra_content[:3000],
                                }
                            )
                else:
                    search_results.append(
                        {
                            "tool": tr.tool_name,
                            "content": (result_data + extra_content)[:3000],
                        }
                    )
                continue
        if isinstance(result_data, dict):
            items = result_data.get("results") or result_data.get("data") or result_data.get("items")
            if isinstance(items, list):
                for item in items:
                    if isinstance(item, dict):
                        search_results.append(item)
                answer = result_data.get("answer")
                if isinstance(answer, str) and answer.strip():
                    search_results.append(
                        {
                            "title": "search_answer_summary",
                            "url": "",
                            "content": answer.strip()[:3000],
                        }
                    )
            else:
                search_results.append(result_data)
        elif isinstance(result_data, list):
            for item in result_data:
                if isinstance(item, dict):
                    search_results.append(item)
    filtered: list[dict[str, Any]] = []
    for item in search_results:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        url = str(item.get("url") or "").strip()
        content = str(item.get("content") or item.get("snippet") or "").strip()
        if title.lower() in {"detailed results:", "detailed results"} and not url and not content:
            continue
        if not title and not url and not content:
            continue
        filtered.append(item)
    return filtered


def _build_inline_delivery_fallback(
    *,
    title: str,
    source_items: list[dict[str, str]],
    language: str,
) -> str:
    lang = str(language or "").strip().lower() or "zh"
    normalized_title = str(title or "").strip() or ("当前请求" if lang == "zh" else "Current request")
    heading = "关键结果" if lang == "zh" else "Key results"
    lines = [f"# {normalized_title}", "", f"## {heading}"]
    for idx, item in enumerate(source_items, start=1):
        row_title = str(item.get("title") or item.get("label") or f"{idx}").strip()
        row_url = str(item.get("url") or "").strip()
        row_summary = str(item.get("summary") or item.get("content") or "").strip().replace("\n", " ")
        title_line = f"{idx}. [{row_title}]({row_url})" if row_url else f"{idx}. {row_title}"
        lines.append(title_line)
        if row_summary:
            prefix = "摘要" if lang == "zh" else "Summary"
            lines.append(f"   - {prefix}：{row_summary}")
    return "\n".join(lines).strip()


def _collect_delivery_payloads(
    artifacts: list[dict[str, Any]],
    latest_structured_act_result: ToolCallResult | None = None,
    source_step_id: str | None = None,
) -> dict[str, list[str]]:
    payloads: dict[str, list[str]] = {}
    normalized_source_step_id = str(source_step_id or "").strip()

    # Prioritization logic: If we have artifacts marked as likely final,
    # we should only deliver those to avoid leaking intermediate process data
    # (like almanac research logs) in the final user response.
    delivery_candidates = artifacts
    final_candidates = [a for a in artifacts if bool(a.get("is_likely_final"))]
    if final_candidates:
        delivery_candidates = final_candidates

    def _append_payloads(entry: dict[str, Any] | None) -> None:
        if normalized_source_step_id:
            entry_source_step_id = str(entry.get("source_step_id") or entry.get("act_step_id") or "").strip()
            if entry_source_step_id and entry_source_step_id != normalized_source_step_id:
                return
        for key, values in _artifact_result_payloads(entry).items():
            normalized_values = payloads.setdefault(key, [])
            for value in values:
                if isinstance(value, str):
                    text = value.strip()
                else:
                    # If it's not a string, it's likely internal technical metadata.
                    # We only allow non-string values for non-text keys.
                    if key == "artifact_result_text":
                        continue
                    text = json.dumps(value, ensure_ascii=False, indent=2).strip()
                if text and text not in normalized_values:
                    normalized_values.append(text)

    if latest_structured_act_result is not None and isinstance(getattr(latest_structured_act_result, "metadata", None), dict):
        _append_payloads(latest_structured_act_result.metadata)
        if payloads:
            return payloads
    for artifact in delivery_candidates:
        _append_payloads(artifact)
    return payloads


def _resolve_delivery_step_id(
    *,
    state: AgentState,
    latest_structured_act_result: ToolCallResult | None,
) -> str:
    if latest_structured_act_result is not None and isinstance(getattr(latest_structured_act_result, "metadata", None), dict):
        metadata = latest_structured_act_result.metadata or {}
        act_step_id = str(metadata.get("act_step_id") or "").strip()
        if act_step_id:
            return act_step_id
    metadata = state.get("metadata") if isinstance(state.get("metadata"), dict) else {}
    last_act_step_id = str(metadata.get("last_act_step_id") or "").strip()
    if last_act_step_id:
        return last_act_step_id
    return ""


def _filter_artifacts_for_delivery_step(
    artifacts: list[dict[str, Any]],
    *,
    source_step_id: str | None,
) -> list[dict[str, Any]]:
    normalized_source_step_id = str(source_step_id or "").strip()
    if not normalized_source_step_id:
        return artifacts
    filtered = [
        item
        for item in artifacts
        if str(item.get("source_step_id") or "").strip() == normalized_source_step_id
    ]
    return filtered


def _render_delivery_payloads(payloads: dict[str, list[str]]) -> str:
    if not payloads:
        return ""
    if payloads.get("artifact_result_text"):
        # Ensure we only join string values for the primary text response.
        text_values = [
            str(value).strip()
            for value in payloads["artifact_result_text"]
            if isinstance(value, str) and value.strip()
        ]
        if text_values:
            return "\n\n".join(text_values)
    # Never render artifact_result_path to user — it contains local filesystem
    # paths (e.g. /var/folders/...) that should not be exposed.
    user_facing_keys = {k for k in payloads if k != "artifact_result_path"}
    if not user_facing_keys:
        return ""
    ordered_keys = sorted(
        user_facing_keys,
        key=lambda key: (
            0 if key == "artifact_result_text" else 2,
            key,
        ),
    )
    if ordered_keys == ["artifact_result_text"] and len(payloads["artifact_result_text"]) == 1:
        return payloads["artifact_result_text"][0]

    sections: list[str] = []
    for key in ordered_keys:
        values = payloads.get(key) or []
        if not values:
            continue
        if len(values) == 1 and "\n" not in values[0]:
            sections.append(f"{key}: {values[0]}")
            continue
        lines = [f"{key}:"]
        for value in values:
            if "\n" in value:
                lines.append("```")
                lines.append(value)
                lines.append("```")
            else:
                lines.append(f"- {value}")
        sections.append("\n".join(lines))
    return "\n\n".join(section for section in sections if section).strip()


async def _emit_delivery_file_messages(
    *,
    event_emitter: Any,
    tool_results: list[ToolCallResult],
    delivery_artifacts: list[dict[str, Any]],
) -> None:
    if event_emitter is None:
        return
    delivery_paths = {
        str(item.get("artifact_result_path") or "").strip()
        for item in delivery_artifacts
        if str(item.get("artifact_result_path") or "").strip()
    }
    delivery_names = {
        str(item.get("filename") or item.get("artifact_name") or "").strip()
        for item in delivery_artifacts
        if str(item.get("filename") or item.get("artifact_name") or "").strip()
    }
    if not delivery_paths and not delivery_names:
        return
    seen_file_ids: set[str] = set()
    seen_labels: set[str] = set()
    for row in tool_results:
        for file_meta in _iter_generated_files_from_result(row):
            if not isinstance(file_meta, dict) or file_meta.get("user_visible", True) is False:
                continue
            file_id = str(file_meta.get("file_id") or "").strip()
            filename = str(file_meta.get("filename") or "").strip()
            path_value = str(file_meta.get("path") or file_meta.get("artifact_result_path") or "").strip()
            if delivery_paths and path_value not in delivery_paths and filename not in delivery_names:
                continue
            dedupe_key = file_id or filename or path_value
            if not dedupe_key or dedupe_key in seen_labels:
                continue
            seen_labels.add(dedupe_key)
            if file_id:
                if file_id in seen_file_ids:
                    continue
                seen_file_ids.add(file_id)
            if not file_id and (not path_value or path_value.startswith("/")):
                # No file_id and path is a local filesystem path — skip to avoid
                # exposing internal paths like /var/folders/... to the frontend.
                logger.debug(
                    "skip_file_emission_no_file_id",
                    extra={"filename": filename, "path": path_value[:120]},
                )
                continue
            await event_emitter.emit_file_created(
                file_id=file_id,
                filename=filename or "file",
                mime_type=str(file_meta.get("mime_type") or "application/octet-stream"),
                size=int(file_meta.get("size") or 0),
                url=f"/api/v1/files/{file_id}" if file_id else path_value,
            )


async def _render_inline_delivery_markdown(
    *,
    llm_provider: Any,
    title: str,
    source_items: list[dict[str, str]],
    language: str,
    model: str | None = None,
    temperature: float = 0.2,
) -> str | None:
    if llm_provider is None or not source_items:
        return None
    lang = str(language or "").strip().lower() or "zh"
    user_language = "中文" if lang == "zh" else "English"
    format_hint = (
        "Use Chinese for all section headings, summaries, connective text, and bullet items. Translate source snippets and summaries into Chinese unless preserving a proper noun or article title is necessary."
        if lang == "zh"
        else "Use English for all section headings, summaries, connective text, and bullet items. Translate source snippets and summaries into English unless preserving a proper noun or article title is necessary."
    )
    messages = [
        {
            "role": "system",
            "content": (
                "You are formatting final user delivery content.\n"
                "Return only markdown.\n"
                "Do not mention internal execution, tools, or planning.\n"
                "Use a concise structure with a title, a short summary section, and a bullet list of results.\n"
                f"{format_hint}"
            ),
        },
        {
            "role": "user",
            "content": json.dumps(
                {
                    "title": title,
                    "language": user_language,
                    "items": source_items,
                },
                ensure_ascii=False,
            ),
        },
    ]
    try:
        response = await llm_provider.chat(messages=messages, temperature=temperature, model=model or None)
    except Exception:
        return None
    content = str(getattr(response, "content", "") or "").strip()
    return content or None
