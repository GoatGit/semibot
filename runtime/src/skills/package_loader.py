"""Local package-skill loader helpers."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from src.skills.index_manager import SkillsIndexManager, resolve_skill_dir
from src.skills.package_tool import PackagePythonTool
from src.skills.registry import SkillMetadata, SkillRegistry
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
    registered: list[str] = []
    skipped: list[dict[str, str]] = []

    for item in sorted(root.iterdir(), key=lambda p: p.name):
        if not item.is_dir():
            continue
        skill_name = item.name
        if skill_name in disabled:
            skipped.append({"name": skill_name, "reason": "disabled"})
            continue
        if registry.get_tool(skill_name) is not None:
            skipped.append({"name": skill_name, "reason": "already_registered"})
            continue
        skill_dir = resolve_skill_dir(item)
        if skill_dir is None:
            skipped.append({"name": skill_name, "reason": "scripts/main.py missing"})
            continue
        script_file = skill_dir / "scripts" / "main.py"
        script_content = script_file.read_text(encoding="utf-8")
        metadata_row = indexed_map.get(skill_name, {})
        description = str(metadata_row.get("description") or f"Execute installed package skill: {skill_name}")
        tags = metadata_row.get("tags") if isinstance(metadata_row.get("tags"), list) else []
        registry.register_tool(
            PackagePythonTool(skill_name=skill_name, description=description, script_content=script_content),
            metadata=SkillMetadata(
                version=str(metadata_row.get("version") or "0.0.0-local"),
                source=str(metadata_row.get("source") or "local"),
                tags=[str(tag) for tag in tags if isinstance(tag, str)],
                additional={
                    "installed_path": str(item),
                    "index_status": str(metadata_row.get("status") or "active"),
                    "requires": metadata_row.get("requires") if isinstance(metadata_row.get("requires"), dict) else {},
                },
            ),
        )
        registered.append(skill_name)

    if registered:
        logger.info("package_tools_registered", extra={"count": len(registered), "skills": registered})
    return {
        "skills_root": str(root),
        "registered": registered,
        "skipped": skipped,
        "index_total": len(indexed_rows),
    }
