"""Helpers for deduping and compacting skill index rows."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from src.skills.source_priority import compare_skill_sources, normalize_skill_source
from src.utils.logging import get_logger

logger = get_logger(__name__)


def _skill_identity(record: dict[str, Any]) -> str:
    return str(record.get("skill_id") or record.get("id") or record.get("name") or "").strip()


def _skill_realpath(record: dict[str, Any]) -> str:
    explicit = str(record.get("installed_realpath") or "").strip()
    if explicit:
        return explicit
    installed_path = str(record.get("installed_path") or "").strip()
    if not installed_path:
        return ""
    try:
        return str(Path(installed_path).expanduser().resolve())
    except Exception:
        return installed_path


def dedupe_skill_index(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_realpath: dict[str, dict[str, Any]] = {}
    pathless: list[dict[str, Any]] = []
    for item in records:
        if not isinstance(item, dict):
            continue
        realpath = _skill_realpath(item)
        if not realpath:
            pathless.append(item)
            continue
        if realpath in by_realpath:
            logger.info(
                "skill_index_duplicate_realpath",
                extra={
                    "skill_id": _skill_identity(item),
                    "realpath": realpath,
                    "existing_skill_id": _skill_identity(by_realpath[realpath]),
                },
            )
            continue
        by_realpath[realpath] = item

    candidates = [*by_realpath.values(), *pathless]
    winners: dict[str, dict[str, Any]] = {}
    for item in candidates:
        if not isinstance(item, dict):
            continue
        skill_id = _skill_identity(item)
        if not skill_id:
            continue
        current = winners.get(skill_id)
        if current is None:
            winners[skill_id] = item
            continue
        cmp = compare_skill_sources(item.get("source"), current.get("source"))
        if cmp < 0:
            logger.info(
                "skill_index_source_override",
                extra={
                    "skill_id": skill_id,
                    "winner_source": normalize_skill_source(item.get("source")),
                    "loser_source": normalize_skill_source(current.get("source")),
                },
            )
            winners[skill_id] = item
        else:
            logger.info(
                "skill_index_source_override",
                extra={
                    "skill_id": skill_id,
                    "winner_source": normalize_skill_source(current.get("source")),
                    "loser_source": normalize_skill_source(item.get("source")),
                },
            )

    return list(winners.values())


def apply_skill_visibility(
    records: list[dict[str, Any]],
    *,
    user_invoked: bool = False,
    explicitly_invoked_skill_ids: list[str] | None = None,
) -> list[dict[str, Any]]:
    normalized_invoked_ids = {
        str(item or "").strip().lower()
        for item in (explicitly_invoked_skill_ids or [])
        if str(item or "").strip()
    }
    visible: list[dict[str, Any]] = []
    for item in records:
        if not isinstance(item, dict):
            continue
        copied = dict(item)
        disable_model_invocation = bool(copied.get("disable_model_invocation", False))
        skill_id = _skill_identity(copied).lower()
        explicit_match = bool(skill_id) and skill_id in normalized_invoked_ids
        copied["visible_to_model"] = (not disable_model_invocation) or bool(user_invoked) or explicit_match
        copied["user_invoked"] = bool(user_invoked or explicit_match)
        visible.append(copied)
    return visible


def compact_skill_summary(record: dict[str, Any]) -> dict[str, Any]:
    resources = record.get("resources") if isinstance(record.get("resources"), dict) else {}
    return {
        "id": _skill_identity(record),
        "skill_id": _skill_identity(record),
        "name": str(record.get("name") or _skill_identity(record)).strip(),
        "aliases": list(record.get("aliases") or []) if isinstance(record.get("aliases"), list) else [],
        "description": str(record.get("description") or "").strip(),
        "when_to_use": str(record.get("when_to_use") or "").strip(),
        "argument_hint": str(record.get("argument_hint") or "").strip(),
        "version": str(record.get("version") or "").strip(),
        "source": str(record.get("source") or "").strip(),
        "enabled": bool(record.get("enabled", True)),
        "user_invocable": bool(record.get("user_invocable", True)),
        "disable_model_invocation": bool(record.get("disable_model_invocation", False)),
        "paths": list(record.get("paths") or []) if isinstance(record.get("paths"), list) else [],
        "allowed_tools": list(record.get("allowed_tools") or []) if isinstance(record.get("allowed_tools"), list) else [],
        "execution_context": str(record.get("execution_context") or "").strip() or None,
        "effort": str(record.get("effort") or "").strip() or None,
        "requires": dict(record.get("requires") or {}) if isinstance(record.get("requires"), dict) else {},
        "resources": {
            "has_skill_md": bool(resources.get("has_skill_md", record.get("has_skill_md"))),
            "has_references": bool(resources.get("has_references", record.get("has_references"))),
            "has_templates": bool(resources.get("has_templates", record.get("has_templates"))),
            "script_files": list(resources.get("script_files") or record.get("script_files") or []),
        },
    }
