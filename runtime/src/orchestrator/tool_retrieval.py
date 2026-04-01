"""Minimal tool shortlist retrieval for ACT execution."""

from __future__ import annotations

import re

from src.orchestrator.context import RuntimeSessionContext, ToolCatalogEntry

_CORE_TOOL_NAMES = {
    "file_io",
    "search",
    "web_fetch",
    "code_executor",
    "memory",
    "semi_browser",
}


def _collect_text_fragments(value: object) -> list[str]:
    fragments: list[str] = []
    if isinstance(value, str):
        text = value.strip()
        if text:
            fragments.append(text)
        return fragments
    if isinstance(value, dict):
        for item in value.values():
            fragments.extend(_collect_text_fragments(item))
        return fragments
    if isinstance(value, list):
        for item in value:
            fragments.extend(_collect_text_fragments(item))
        return fragments
    return fragments


def _tokenize(text: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-zA-Z0-9_]{2,}", str(text or "").lower())
        if token
    }


def _entry_search_blob(entry: ToolCatalogEntry) -> str:
    metadata_text = " ".join(_collect_text_fragments(entry.metadata or {}))
    return " ".join(
        part
        for part in [
            entry.tool_name,
            entry.actual_tool_name,
            entry.display_name,
            entry.description or "",
            metadata_text,
        ]
        if part
    )


def _recent_tool_usage(runtime_context: RuntimeSessionContext) -> dict[str, int]:
    raw = runtime_context.metadata.get("recent_tool_usage") if isinstance(runtime_context.metadata, dict) else None
    if not isinstance(raw, dict):
        return {}
    normalized: dict[str, int] = {}
    for key, value in raw.items():
        tool_id = str(key or "").strip()
        if not tool_id:
            continue
        normalized[tool_id] = int(value) if isinstance(value, (int, float)) else 0
    return normalized


def _usage_candidates(entry: ToolCatalogEntry) -> tuple[str, ...]:
    candidates: list[str] = [entry.tool_id, entry.tool_name, entry.actual_tool_name]
    if entry.source_type == "mcp":
        provider = str(entry.provider_id or "").strip()
        if provider:
            candidates.append(f"mcp:{provider}:{entry.actual_tool_name}")
            candidates.append(f"{provider}:{entry.actual_tool_name}")
    return tuple(candidate for candidate in candidates if candidate)


def _usage_score(entry: ToolCatalogEntry, recent_usage: dict[str, int]) -> int:
    best = 0
    for candidate in _usage_candidates(entry):
        best = max(best, max(0, int(recent_usage.get(candidate, 0))))
    return best


def _failure_repeat_count(runtime_context: RuntimeSessionContext) -> int:
    raw = runtime_context.metadata.get("_current_act_failure_repeat_count") if isinstance(runtime_context.metadata, dict) else None
    return int(raw) if isinstance(raw, (int, float)) else 0


def select_tool_shortlist(
    runtime_context: RuntimeSessionContext,
    *,
    query: str,
    limit: int = 12,
) -> list[ToolCatalogEntry]:
    """Return a small shortlist of candidate tools for the current ACT step."""
    entries = runtime_context.get_tool_catalog()
    if not entries:
        return []

    query_tokens = _tokenize(query)
    recent_usage = _recent_tool_usage(runtime_context)
    failure_repeat_count = _failure_repeat_count(runtime_context)
    scored: list[tuple[int, ToolCatalogEntry]] = []
    expanded_limit = limit
    expanded = False
    if failure_repeat_count > 0:
        expanded_limit = min(len(entries), limit + 4 + max(0, failure_repeat_count - 1) * 2)
        expanded = expanded_limit > limit
    for entry in entries:
        score = 0
        if entry.actual_tool_name in _CORE_TOOL_NAMES and entry.source_type == "builtin":
            score += 40
        blob = _entry_search_blob(entry)
        blob_tokens = _tokenize(blob)
        overlap = len(query_tokens & blob_tokens)
        score += overlap * 10
        lowered_query = str(query or "").lower()
        if entry.actual_tool_name.lower() in lowered_query:
            score += 25
        if entry.tool_name.lower() in lowered_query:
            score += 20
        if entry.source_type == "builtin":
            score += 5
        usage_count = _usage_score(entry, recent_usage)
        if usage_count:
            score += min(usage_count, 5) * 6
        scored.append((score, entry))

    scored.sort(
        key=lambda item: (
            -item[0],
            0 if item[1].source_type == "builtin" else 1,
            item[1].tool_name,
        )
    )

    selected: list[ToolCatalogEntry] = []
    seen_tool_ids: set[str] = set()

    # Always include core builtin tools when available.
    for _, entry in scored:
        if entry.tool_id in seen_tool_ids:
            continue
        if entry.source_type == "builtin" and entry.actual_tool_name in _CORE_TOOL_NAMES:
            selected.append(entry)
            seen_tool_ids.add(entry.tool_id)

    for _, entry in scored:
        if entry.tool_id in seen_tool_ids:
            continue
        selected.append(entry)
        seen_tool_ids.add(entry.tool_id)
        if len(selected) >= expanded_limit:
            break

    if not expanded and not any(
        entry.actual_tool_name not in _CORE_TOOL_NAMES and entry.source_type != "builtin"
        for entry in selected
    ):
        extra_budget = min(4, max(0, len(entries) - len(selected)))
        for _, entry in scored:
            if extra_budget <= 0:
                break
            if entry.tool_id in seen_tool_ids:
                continue
            selected.append(entry)
            seen_tool_ids.add(entry.tool_id)
            extra_budget -= 1
            expanded = True

    if isinstance(runtime_context.metadata, dict):
        runtime_context.metadata["_current_act_tool_shortlist_expanded"] = expanded
        runtime_context.metadata["_current_act_tool_recent_usage"] = dict(recent_usage)

    return selected[:expanded_limit] if expanded else selected[:limit]


def build_shortlist_tool_schemas(
    runtime_context: RuntimeSessionContext,
    *,
    query: str,
    limit: int = 12,
) -> list[dict[str, object]]:
    return [entry.to_tool_schema() for entry in select_tool_shortlist(runtime_context, query=query, limit=limit)]


def build_shortlist_catalog_cards(
    runtime_context: RuntimeSessionContext,
    *,
    query: str,
    limit: int = 12,
) -> list[dict[str, object]]:
    return [entry.to_catalog_card() for entry in select_tool_shortlist(runtime_context, query=query, limit=limit)]
