"""Unified tool catalog helpers for runtime planning and execution."""

from __future__ import annotations

import re
from collections import Counter
from typing import TYPE_CHECKING

from src.orchestrator.context import RuntimeSessionContext, ToolCatalogEntry

if TYPE_CHECKING:
    from src.skills.registry import SkillRegistry


def _slug_token(value: str) -> str:
    text = re.sub(r"[^a-zA-Z0-9_]+", "_", str(value or "").strip())
    text = re.sub(r"_+", "_", text).strip("_")
    return text or "tool"


def _group_actions_from_metadata(metadata: dict[str, object] | None) -> list[dict[str, object]]:
    if not isinstance(metadata, dict):
        return []
    raw_actions = metadata.get("actions")
    if not isinstance(raw_actions, list):
        return []
    actions: list[dict[str, object]] = []
    for item in raw_actions:
        if not isinstance(item, dict):
            continue
        command = str(item.get("command") or "").strip()
        if not command:
            continue
        parameters = item.get("parameters") if isinstance(item.get("parameters"), dict) else {}
        actions.append(
            {
                "command": command,
                "description": str(item.get("description") or "").strip(),
                "parameters": dict(parameters),
            }
        )
    return actions


def expand_catalog_entry_for_llm(entry: ToolCatalogEntry) -> list[ToolCatalogEntry]:
    metadata = dict(entry.metadata or {})
    if entry.source_type != "cli" or str(metadata.get("shape") or "").strip().lower() != "group":
        return [entry]

    actions = _group_actions_from_metadata(metadata)
    if not actions:
        return [entry]

    expanded: list[ToolCatalogEntry] = []
    for action in actions:
        action_name = str(action.get("command") or "").strip()
        if not action_name:
            continue
        projection_name = f"{entry.tool_name}_{_slug_token(action_name)}"
        action_description = str(action.get("description") or "").strip()
        expanded.append(
            ToolCatalogEntry(
                tool_id=f"{entry.tool_id}#{action_name}",
                tool_name=projection_name,
                actual_tool_name=entry.actual_tool_name,
                display_name=f"{entry.display_name} / {action_name}",
                description=action_description or entry.description,
                source_type=entry.source_type,
                provider_id=entry.provider_id,
                parameters=dict(action.get("parameters") or {}),
                metadata={
                    **metadata,
                    "projection_type": "group_action",
                    "projection_action": action_name,
                    "projection_parent_tool_name": entry.tool_name,
                    "projection_parent_tool_id": entry.tool_id,
                },
            )
        )
    return expanded or [entry]


def _build_builtin_entries(runtime_context: RuntimeSessionContext) -> list[ToolCatalogEntry]:
    entries: list[ToolCatalogEntry] = []
    for tool in runtime_context.available_tools:
        actual_name = str(tool.name or "").strip()
        if not actual_name:
            continue
        raw_metadata = dict(tool.metadata or {})
        source = str(raw_metadata.get("source_type") or raw_metadata.get("source") or "builtin").strip() or "builtin"
        package_id = str(raw_metadata.get("package_id") or "").strip()
        if source in {"builtin", "core"}:
            source_type = "builtin"
            provider_id = "builtin"
            tool_id = f"builtin:{actual_name}"
        else:
            source_type = "cli"
            provider_id = package_id or source
            tool_id = f"cli:{provider_id}:{actual_name}"
        entries.append(
            ToolCatalogEntry(
                tool_id=tool_id,
                tool_name=actual_name,
                actual_tool_name=actual_name,
                display_name=actual_name,
                description=tool.description,
                source_type=source_type,
                provider_id=provider_id,
                parameters=dict(tool.parameters or {}),
                metadata={
                    "source": source_type,
                    **raw_metadata,
                },
            )
        )
    return entries


def _build_mcp_entries(runtime_context: RuntimeSessionContext) -> list[ToolCatalogEntry]:
    entries: list[ToolCatalogEntry] = []
    for server in runtime_context.available_mcp_servers:
        if not server.is_connected:
            continue
        server_id = str(server.id or "").strip()
        server_name = str(server.name or server_id or "mcp").strip()
        for tool in server.available_tools or []:
            if not isinstance(tool, dict):
                continue
            actual_name = str(tool.get("name") or "").strip()
            if not actual_name:
                continue
            params = tool.get("inputSchema") if isinstance(tool.get("inputSchema"), dict) else tool.get("parameters")
            entries.append(
                ToolCatalogEntry(
                    tool_id=f"mcp:{server_id}:{actual_name}",
                    tool_name=actual_name,
                    actual_tool_name=actual_name,
                    display_name=f"{server_name} / {actual_name}",
                    description=str(tool.get("description") or "").strip() or None,
                    source_type="mcp",
                    provider_id=server_id,
                    parameters=dict(params or {}) if isinstance(params, dict) else {},
                    metadata={
                        "source": "mcp",
                        "mcp_server_id": server_id,
                        "mcp_server_name": server_name,
                    },
                )
            )
    return entries


def _assign_unique_tool_names(entries: list[ToolCatalogEntry]) -> list[ToolCatalogEntry]:
    counts = Counter(entry.tool_name for entry in entries if entry.tool_name)
    for entry in entries:
        if counts.get(entry.tool_name, 0) <= 1:
            continue
        if entry.source_type == "mcp":
            provider = _slug_token(str(entry.provider_id or "mcp"))
            entry.tool_name = f"mcp__{provider}__{_slug_token(entry.actual_tool_name)}"
        elif entry.source_type == "builtin":
            entry.tool_name = f"builtin__{_slug_token(entry.actual_tool_name)}"
        else:
            provider = _slug_token(str(entry.provider_id or entry.source_type))
            entry.tool_name = f"{_slug_token(entry.source_type)}__{provider}__{_slug_token(entry.actual_tool_name)}"
    return entries


def build_runtime_tool_catalog(runtime_context: RuntimeSessionContext) -> list[ToolCatalogEntry]:
    """Build a unified catalog for builtin, CLI, and connected MCP tools."""
    entries = _build_builtin_entries(runtime_context)
    entries.extend(_build_mcp_entries(runtime_context))

    deduped_by_id: dict[str, ToolCatalogEntry] = {}
    for entry in entries:
        deduped_by_id[entry.tool_id] = entry

    return _assign_unique_tool_names(list(deduped_by_id.values()))


def build_registry_tool_catalog(registry: "SkillRegistry") -> list[ToolCatalogEntry]:
    """Build a global tool catalog from the runtime skill registry only."""
    entries: list[ToolCatalogEntry] = []
    for actual_name in registry.list_tools():
        tool = registry.get_tool(actual_name)
        if tool is None:
            continue
        raw_metadata = registry.get_tool_metadata(actual_name)
        if isinstance(raw_metadata, dict):
            source = str(raw_metadata.get("source_type") or raw_metadata.get("source") or "builtin").strip() or "builtin"
            additional = dict(raw_metadata)
        else:
            metadata = raw_metadata
            source = str(metadata.source if metadata else "builtin").strip() or "builtin"
            additional = dict(metadata.additional) if metadata else {}
        package_id = str(additional.get("package_id") or "").strip()
        if source in {"builtin", "core", "local"} and not package_id:
            source_type = "builtin"
            provider_id = "builtin"
            tool_id = f"builtin:{actual_name}"
        else:
            source_type = "cli"
            provider_id = package_id or source
            tool_id = f"cli:{provider_id}:{actual_name}"
        entries.append(
            ToolCatalogEntry(
                tool_id=tool_id,
                tool_name=actual_name,
                actual_tool_name=actual_name,
                display_name=actual_name,
                description=getattr(tool, "description", None),
                source_type=source_type,
                provider_id=provider_id,
                parameters=dict(getattr(tool, "parameters", {}) or {}),
                metadata={
                    "source": source_type,
                    **(
                        {"search_hint": str(getattr(tool, "search_hint", "") or "").strip()}
                        if str(getattr(tool, "search_hint", "") or "").strip()
                        else {}
                    ),
                    **additional,
                },
            )
        )
    deduped_by_id: dict[str, ToolCatalogEntry] = {}
    for entry in entries:
        deduped_by_id[entry.tool_id] = entry
    return _assign_unique_tool_names(list(deduped_by_id.values()))


def build_catalog_cards(runtime_context: RuntimeSessionContext) -> list[dict[str, object]]:
    """Return lightweight cards for planner-side discovery."""
    get_tool_catalog = getattr(runtime_context, "get_tool_catalog", None)
    if callable(get_tool_catalog):
        return [entry.to_catalog_card() for entry in get_tool_catalog()]
    available_tools = getattr(runtime_context, "available_tools", None)
    available_mcp_servers = getattr(runtime_context, "available_mcp_servers", None)
    if isinstance(available_tools, list) or isinstance(available_mcp_servers, list):
        entries = build_runtime_tool_catalog(runtime_context)
        return [entry.to_catalog_card() for entry in entries]
    return []
