"""Minimal installed skill index query helpers."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from src.skills.index_manager import SkillsIndexManager


@dataclass(frozen=True)
class SkillRegistryEntry:
    skill_id: str
    skill_name: str
    description: str
    installed_path: str
    source: str
    bundled_tools: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "skillId": self.skill_id,
            "skillName": self.skill_name,
            "description": self.description,
            "installedPath": self.installed_path,
            "source": self.source,
            "bundledTools": list(self.bundled_tools),
            "metadata": dict(self.metadata or {}),
        }


def list_installed_skill_registry(skills_root: str | Path) -> list[SkillRegistryEntry]:
    root = Path(skills_root).expanduser()
    manager = SkillsIndexManager(root)
    entries: list[SkillRegistryEntry] = []
    for row in manager.list_records():
        if not isinstance(row, dict):
            continue
        skill_id = str(row.get("skill_id") or "").strip()
        if not skill_id:
            continue
        entries.append(
            SkillRegistryEntry(
                skill_id=skill_id,
                skill_name=str(row.get("name") or skill_id),
                description=str(row.get("description") or "").strip(),
                installed_path=str(row.get("installed_path") or ""),
                source=str(row.get("source") or "manual"),
                bundled_tools=[],
                metadata={
                    "tags": list(row.get("tags") or []) if isinstance(row.get("tags"), list) else [],
                    "hasSkillMd": bool(row.get("has_skill_md")),
                    "scriptFiles": list(row.get("script_files") or []) if isinstance(row.get("script_files"), list) else [],
                },
            )
        )
    return entries
