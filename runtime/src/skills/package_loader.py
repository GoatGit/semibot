"""Installed skill loader helpers.

Installed skills are indexed for discovery and orchestration context only.
They are no longer auto-registered as executable tools.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from src.skills.index_manager import SkillsIndexManager
from src.skills.registry import SkillRegistry
from src.utils.logging import get_logger

logger = get_logger(__name__)


def _read_disabled_skill_names(skills_root: Path) -> set[str]:
    state_file = skills_root / ".state.json"
    if not state_file.exists():
        return set()
    try:
        import json

        payload = json.loads(state_file.read_text(encoding="utf-8"))
    except Exception:
        return set()
    rows = payload.get("disabled")
    if not isinstance(rows, list):
        return set()
    return {str(item).strip() for item in rows if isinstance(item, str) and str(item).strip()}


def register_installed_package_tools(
    registry: SkillRegistry,
    *,
    skills_root: str | Path,
) -> dict[str, Any]:
    root = Path(skills_root).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    index = SkillsIndexManager(root)
    # Keep metadata index in sync before registry registration.
    index.reindex(scope="incremental")
    indexed_rows = index.list_records()
    indexed_map = {
        str(row.get("skill_id") or "").strip(): row
        for row in indexed_rows
        if isinstance(row, dict) and str(row.get("skill_id") or "").strip()
    }
    disabled = _read_disabled_skill_names(root)
    indexed: list[str] = []
    skipped: list[dict[str, str]] = []
    for skill_name, metadata_row in indexed_map.items():
        if skill_name in disabled:
            skipped.append({"name": skill_name, "reason": "disabled"})
            continue
        indexed.append(skill_name)

    if indexed:
        logger.info("installed_skills_indexed", extra={"count": len(indexed), "skills": indexed})
    return {
        "skills_root": str(root),
        "registered": [],
        "indexed": indexed,
        "skipped": skipped,
        "index_total": len(indexed_rows),
    }
