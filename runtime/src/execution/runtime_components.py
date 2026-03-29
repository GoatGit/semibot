from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

from src.execution.runtime_approval import (
    APPROVAL_SCOPE_ALLOWED,
    normalize_dedupe_keys,
    to_bool,
)
from src.orchestrator.context import RuntimePolicy, SkillDefinition, ToolDefinition
from src.server.config_store import RuntimeConfigStore
from src.skills.registry import SkillRegistry
_DEFAULT_HIGH_RISK_TOOL_NAMES = {
    "code_executor",
    "file_io",
    "semi_browser",
    "http_client",
    "skill_installer",
}

def resolve_runtime_db_path(db_path: str | None = None) -> str:
    resolved = str(
        db_path
        or os.getenv("SEMIBOT_EVENTS_DB_PATH")
        or os.getenv("SEMIBOT_RUNTIME_DB_PATH")
        or "~/.semibot/semibot.db"
    ).strip()
    return resolved


def load_runtime_tool_rows(db_path: str | None = None) -> dict[str, dict[str, Any]]:
    try:
        store = RuntimeConfigStore(db_path=resolve_runtime_db_path(db_path))
        rows = store.list_tools(include_builtin=True, page=1, limit=500).get("data", [])
    except Exception:
        return {}
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        name = str(row.get("name") or "").strip()
        if not name:
            continue
        cfg = row.get("config")
        result[name] = {
            "config": cfg if isinstance(cfg, dict) else {},
            "is_active": bool(row.get("is_active", True)),
            "type": str(row.get("type") or "").strip().lower(),
        }
    return result


def build_runtime_tool_definitions(
    registry: SkillRegistry,
    db_path: str | None = None,
    *,
    metadata_resolver: Callable[[str], dict[str, Any]] | None = None,
) -> list[ToolDefinition]:
    tool_rows = load_runtime_tool_rows(db_path)
    tools: list[ToolDefinition] = []
    for tool_name in registry.list_tools():
        tool = registry.get_tool(tool_name)
        if not tool:
            continue
        tool_row = tool_rows.get(tool.name, {})
        if tool_row and not bool(tool_row.get("is_active", True)):
            continue
        cfg = tool_row.get("config") if isinstance(tool_row.get("config"), dict) else {}
        raw_risk_level = cfg.get("riskLevel")
        if isinstance(raw_risk_level, str) and raw_risk_level.strip():
            risk_level = raw_risk_level.strip().lower()
        elif tool.name in _DEFAULT_HIGH_RISK_TOOL_NAMES:
            risk_level = "high"
        else:
            risk_level = "low"
        requires_approval = to_bool(
            cfg.get("requiresApproval"),
            default=tool.name in _DEFAULT_HIGH_RISK_TOOL_NAMES,
        )
        raw_approval_scope = str(cfg.get("approvalScope") or "").strip().lower()
        approval_scope = raw_approval_scope if raw_approval_scope in APPROVAL_SCOPE_ALLOWED else "session"
        approval_dedupe_keys = normalize_dedupe_keys(cfg.get("approvalDedupeKeys"))
        extra_metadata = metadata_resolver(tool.name) if metadata_resolver is not None else {}
        if not isinstance(extra_metadata, dict):
            extra_metadata = {}
        source = str(extra_metadata.get("source") or "builtin").strip() or "builtin"
        tools.append(
            ToolDefinition(
                name=tool.name,
                description=tool.description,
                parameters=tool.parameters,
                metadata={
                    **extra_metadata,
                    "source": source,
                    "requires_approval": requires_approval,
                    "risk_level": risk_level,
                    "approval_scope": approval_scope,
                    "approval_dedupe_keys": approval_dedupe_keys,
                },
            )
        )
    return tools


def build_runtime_skill_definitions(
    registry: SkillRegistry,
    skill_index: list[dict[str, Any]] | None = None,
    *,
    include_registry_skills: bool = True,
) -> list[SkillDefinition]:
    skills: list[SkillDefinition] = []
    seen: set[str] = set()
    if include_registry_skills:
        for skill_name in registry.list_skills():
            skill = registry.get_skill(skill_name)
            if not skill:
                continue
            skills.append(
                SkillDefinition(
                    id=skill_name,
                    name=skill_name,
                    description=skill.description,
                    source="local",
                    schema={},
                    metadata={},
                )
            )
            seen.add(skill_name)

    if not isinstance(skill_index, list):
        return skills

    for item in skill_index:
        if not isinstance(item, dict):
            continue
        skill_id = str(item.get("id") or item.get("name") or "").strip()
        if not skill_id or skill_id in seen:
            continue
        package = item.get("package")
        package_files: list[str] = []
        if isinstance(package, dict):
            files = package.get("files")
            if isinstance(files, list):
                package_files = [
                    str(f.get("path") or "")
                    for f in files
                    if isinstance(f, dict) and str(f.get("path") or "").strip()
                ]
        inventory = item.get("file_inventory") if isinstance(item.get("file_inventory"), dict) else {}
        inventory_scripts = inventory.get("script_files")
        normalized_inventory_scripts = {
            str(path).strip()
            for path in (inventory_scripts if isinstance(inventory_scripts, list) else [])
            if str(path).strip()
        }
        if not normalized_inventory_scripts:
            normalized_inventory_scripts = {
                path for path in package_files if path.startswith("scripts/") and path.strip()
            }
        skills.append(
            SkillDefinition(
                id=skill_id,
                name=skill_id,
                description=str(item.get("description") or "").strip() or None,
                version=str(item.get("version") or "").strip() or None,
                source=str(item.get("source") or "local"),
                schema={},
                metadata={
                    "has_skill_md": "SKILL.md" in package_files,
                    "package_files": package_files[:50],
                    "script_files": sorted(normalized_inventory_scripts)[:50],
                },
            )
        )
        seen.add(skill_id)
    return skills


def build_runtime_policy(
    tools: list[ToolDefinition],
    *,
    enable_delegation: bool = False,
) -> RuntimePolicy:
    return RuntimePolicy(
        enable_delegation=enable_delegation,
        require_approval_for_high_risk=True,
        high_risk_tools=[
            tool.name
            for tool in tools
            if bool(tool.metadata.get("requires_approval"))
            or str(tool.metadata.get("risk_level", "")).lower() in {"high", "critical"}
        ],
    )
