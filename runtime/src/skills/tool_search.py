"""Builtin tool discovery over the registry catalog."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from src.orchestrator.tool_catalog import build_registry_tool_catalog, build_runtime_tool_catalog
from src.skills.base import BaseTool, ToolResult

if TYPE_CHECKING:
    from src.skills.registry import SkillRegistry


def _normalize_text(value: Any) -> str:
    return str(value or "").strip().lower()


def _matches_filters(entry: dict[str, Any], source_type: str | None) -> bool:
    if source_type and _normalize_text(entry.get("source_type")) != _normalize_text(source_type):
        return False
    return True


def _resolve_select_matches(entries: list[dict[str, Any]], query: str) -> list[dict[str, Any]] | None:
    match = str(query or "").strip()
    if not match.lower().startswith("select:"):
        return None
    requested_names = [
        str(item).strip().lower()
        for item in match.split(":", 1)[1].split(",")
        if str(item).strip()
    ]
    if not requested_names:
        return []
    found: list[dict[str, Any]] = []
    seen: set[str] = set()
    for requested in requested_names:
        for entry in entries:
            tool_name = _normalize_text(entry.get("tool_name"))
            actual_name = _normalize_text(entry.get("actual_tool_name"))
            if requested not in {tool_name, actual_name}:
                continue
            dedupe_key = str(entry.get("tool_name") or entry.get("actual_tool_name") or "").strip()
            if dedupe_key and dedupe_key not in seen:
                found.append(entry)
                seen.add(dedupe_key)
            break
    return found


def _score_entry(entry: dict[str, Any], query: str) -> int:
    if not query:
        return 0
    needle = _normalize_text(query)
    name = _normalize_text(entry.get("tool_name"))
    display_name = _normalize_text(entry.get("display_name"))
    description = _normalize_text(entry.get("description"))
    actual_name = _normalize_text(entry.get("actual_tool_name"))
    search_hint = _normalize_text(entry.get("search_hint"))

    score = 0
    if needle == name:
        score += 120
    if needle == actual_name:
        score += 120
    if needle and needle in name:
        score += 80
    if needle and needle in display_name:
        score += 50
    if needle and needle in description:
        score += 25
    if needle and needle in search_hint:
        score += 60

    for token in needle.split():
        if token and token in name:
            score += 20
        if token and token in search_hint:
            score += 14
        if token and token in description:
            score += 8
    return score


class ToolSearchTool(BaseTool):
    def __init__(self, registry: "SkillRegistry") -> None:
        self._registry = registry

    @property
    def name(self) -> str:
        return "tool_search"

    @property
    def description(self) -> str:
        return (
            "Search the current runtime tool catalog and return the best matching tools. "
            "Use this when you are unsure which tool to call."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Tool search query. Match against tool name and description.",
                },
                "source_type": {
                    "type": "string",
                    "enum": ["builtin", "cli", "mcp"],
                    "description": "Optional source filter.",
                },
                "limit": {
                    "type": "integer",
                    "default": 8,
                    "description": "Maximum number of tools to return.",
                },
                "include_parameters": {
                    "type": "boolean",
                    "default": False,
                    "description": "Whether to include each tool parameter schema in the results.",
                },
                "include_self": {
                    "type": "boolean",
                    "default": False,
                    "description": "Whether to include tool_search itself in the results.",
                },
            },
        }

    async def execute(
        self,
        query: str | None = None,
        source_type: str | None = None,
        limit: int = 8,
        include_parameters: bool = False,
        include_self: bool = False,
        **_: Any,
    ) -> ToolResult:
        normalized_query = str(query or "").strip()
        normalized_limit = max(1, min(int(limit or 8), 50))
        runtime_context = _.get("_runtime_context")

        entries = []
        if runtime_context is not None:
            catalog_entries = build_runtime_tool_catalog(runtime_context)
        else:
            catalog_entries = build_registry_tool_catalog(self._registry)
        for entry in catalog_entries:
            card = {
                "tool_name": entry.tool_name,
                "actual_tool_name": entry.actual_tool_name,
                "display_name": entry.display_name,
                "description": entry.description,
                "source_type": entry.source_type,
                "provider_id": entry.provider_id,
                "search_hint": str((entry.metadata or {}).get("search_hint") or "").strip() or None,
            }
            if include_parameters:
                card["parameters"] = dict(entry.parameters or {})
            if not include_self and entry.actual_tool_name == self.name:
                continue
            if not _matches_filters(card, source_type):
                continue
            entries.append(card)

        selected_entries = _resolve_select_matches(entries, normalized_query)
        if selected_entries is not None:
            limited_selected = selected_entries[:normalized_limit]
            for item in limited_selected:
                item["score"] = 1000
            return ToolResult.success_result(
                {
                    "query": normalized_query,
                    "total_matches": len(selected_entries),
                    "items": limited_selected,
                }
            )

        scored_entries = []
        for card in entries:
            score = _score_entry(card, normalized_query)
            if normalized_query and score <= 0:
                continue
            card["score"] = score
            scored_entries.append(card)

        scored_entries.sort(
            key=lambda item: (
                -int(item.get("score") or 0),
                _normalize_text(item.get("tool_name")),
            )
        )
        limited = scored_entries[:normalized_limit]

        return ToolResult.success_result(
            {
                "query": normalized_query,
                "total_matches": len(scored_entries),
                "items": limited,
            }
        )
