"""Local package-skill loader helpers."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from src.skills.package_tool import PackagePythonTool
from src.skills.registry import SkillMetadata, SkillRegistry
from src.utils.logging import get_logger

logger = get_logger(__name__)


def _read_disabled_skill_names(skills_root: Path) -> set[str]:
    state_file = skills_root / ".state.json"
    if not state_file.exists():
        return set()
    try:
        payload = json.loads(state_file.read_text(encoding="utf-8"))
    except Exception:
        return set()
    rows = payload.get("disabled")
    if not isinstance(rows, list):
        return set()
    return {str(item).strip() for item in rows if isinstance(item, str) and str(item).strip()}


def _read_description(skill_dir: Path, fallback_name: str) -> str:
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        return f"Execute installed package skill: {fallback_name}"
    for line in skill_md.read_text(encoding="utf-8", errors="ignore").splitlines():
        text = line.strip()
        if not text:
            continue
        if text.startswith("#"):
            text = text.lstrip("#").strip()
        if text:
            return text
    return f"Execute installed package skill: {fallback_name}"


def resolve_skill_dir(candidate: Path) -> Path | None:
    """Resolve to a directory that contains scripts/main.py."""
    if not candidate.exists():
        return None
    if candidate.is_file():
        return None
    direct = candidate / "scripts" / "main.py"
    if direct.exists():
        return candidate
    for child in candidate.iterdir():
        if not child.is_dir():
            continue
        nested = child / "scripts" / "main.py"
        if nested.exists():
            return child
    return None


def register_installed_package_tools(
    registry: SkillRegistry,
    *,
    skills_root: str | Path,
) -> dict[str, Any]:
    root = Path(skills_root).expanduser()
    root.mkdir(parents=True, exist_ok=True)
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
        description = _read_description(skill_dir, skill_name)
        registry.register_tool(
            PackagePythonTool(skill_name=skill_name, description=description, script_content=script_content),
            metadata=SkillMetadata(source="local", additional={"installed_path": str(item)}),
        )
        registered.append(skill_name)

    if registered:
        logger.info("package_tools_registered", extra={"count": len(registered), "skills": registered})
    return {
        "skills_root": str(root),
        "registered": registered,
        "skipped": skipped,
    }

