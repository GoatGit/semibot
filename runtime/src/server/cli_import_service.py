"""CLI import request service for runtime and CLI entrypoints."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from src.server.config_store import RuntimeConfigStore
from src.skills.cli_importer import CliImportShape, extract_cli_spec, register_imported_cli_tools
from src.skills.registry import SkillRegistry


def _proposed_tool_id(provider_id: str, tool_name: str) -> str:
    return f"cli:{provider_id}:{tool_name}"


async def create_cli_import_request(
    *,
    config_store: RuntimeConfigStore,
    registry: SkillRegistry,
    command: list[str],
    shape: CliImportShape,
    source: str,
    requested_by: str | None = None,
    display_name: str | None = None,
    description: str | None = None,
    tool_name: str | None = None,
    reason: str | None = None,
) -> dict[str, Any]:
    spec = await extract_cli_spec(
        command=command,
        shape=shape,
        tool_name=tool_name,
        display_name=display_name,
        description=description,
    )
    existing = config_store.get_tool_by_name(spec.tool_name)
    if existing and (bool(existing.get("is_builtin")) or str(existing.get("type") or "") != "cli"):
        raise ValueError(f"tool name already exists and is not importable CLI: {spec.tool_name}")
    existing_tool = registry.get_tool(spec.tool_name)
    if existing_tool is not None and not existing:
        raise ValueError(f"tool name already exists in runtime registry: {spec.tool_name}")
    provider_id = str(spec.metadata.get("provider_id") or "cli").strip() or "cli"
    status = "awaiting_approval" if source == "channel_auto" else "registered"
    request = config_store.create_cli_import_request(
        {
            "source": source,
            "shape": shape,
            "command": command,
            "requested_by": requested_by,
            "tool_name": spec.tool_name,
            "proposed_tool_id": _proposed_tool_id(provider_id, spec.tool_name),
            "display_name": spec.display_name,
            "description": spec.description,
            "status": status,
            "risk_level": spec.risk_level,
            "reason": reason,
            "spec": spec.to_config(),
        }
    )
    if status == "registered":
        config_store.upsert_tool_by_name(
            spec.tool_name,
            {
                "description": spec.description,
                "type": "cli",
                "schema": spec.parameters,
                "config": {
                    **spec.to_config(),
                    "displayName": spec.display_name,
                },
                "is_builtin": False,
                "is_active": True,
                "created_by": requested_by,
            },
        )
        register_imported_cli_tools(registry, [config_store.get_tool_by_name(spec.tool_name) or {}])
        request = config_store.update_cli_import_request(
            request["id"],
            {
                "status": "registered",
                "resolved_at": datetime.now(UTC).isoformat(),
            },
        ) or request
    return request


def approve_cli_import_request(
    *,
    config_store: RuntimeConfigStore,
    registry: SkillRegistry,
    request_id: str,
    approved: bool,
    reason: str | None = None,
) -> dict[str, Any] | None:
    request = config_store.get_cli_import_request(request_id)
    if not request:
        return None
    if request.get("status") not in {"awaiting_approval", "registered"}:
        return request
    if not approved:
        return config_store.update_cli_import_request(
            request_id,
            {
                "status": "rejected",
                "reason": reason or request.get("reason"),
                "resolved_at": datetime.now(UTC).isoformat(),
            },
        )
    spec = request.get("spec") if isinstance(request.get("spec"), dict) else {}
    tool_name = str(request.get("tool_name") or "").strip()
    if not tool_name:
        return config_store.update_cli_import_request(
            request_id,
            {
                "status": "failed_registration",
                "error": "missing_tool_name",
                "resolved_at": datetime.now(UTC).isoformat(),
            },
        )
    config_store.upsert_tool_by_name(
        tool_name,
        {
            "description": request.get("description"),
            "type": "cli",
            "schema": spec.get("parameters") if isinstance(spec.get("parameters"), dict) else {},
            "config": {
                **spec,
                "displayName": request.get("display_name"),
            },
            "is_builtin": False,
            "is_active": True,
            "created_by": request.get("requested_by"),
        },
    )
    register_imported_cli_tools(registry, [config_store.get_tool_by_name(tool_name) or {}])
    return config_store.update_cli_import_request(
        request_id,
        {
            "status": "registered",
            "reason": reason or request.get("reason"),
            "resolved_at": datetime.now(UTC).isoformat(),
        },
    )
