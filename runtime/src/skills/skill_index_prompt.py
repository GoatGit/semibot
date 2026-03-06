"""Helpers to build compact skill index prompt payloads."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class SkillIndexEntry:
    skill_id: str
    name: str
    description: str
    script_files: list[str]
    has_skill_md: bool
    has_references: bool
    has_templates: bool
    enabled: bool = True


def build_skill_index_entries(index_records: list[dict[str, Any]]) -> list[SkillIndexEntry]:
    entries: list[SkillIndexEntry] = []
    for record in index_records:
        if not isinstance(record, dict):
            continue
        if not record.get("enabled", True):
            continue
        skill_id = str(record.get("skill_id") or record.get("id") or record.get("name") or "").strip()
        if not skill_id:
            continue
        raw_scripts = record.get("script_files")
        script_files = [
            str(item).strip()
            for item in (raw_scripts if isinstance(raw_scripts, list) else [])
            if str(item).strip()
        ]
        entries.append(
            SkillIndexEntry(
                skill_id=skill_id,
                name=str(record.get("name") or skill_id).strip(),
                description=str(record.get("description") or "").strip(),
                script_files=script_files,
                has_skill_md=bool(record.get("has_skill_md")),
                has_references=bool(record.get("has_references")),
                has_templates=bool(record.get("has_templates")),
                enabled=bool(record.get("enabled", True)),
            )
        )
    return entries


def format_skills_for_prompt(
    entries: list[SkillIndexEntry],
    *,
    max_skills: int,
    max_chars: int,
    max_desc_chars: int,
) -> str:
    lines = ["<available_skills>"]
    used = len(lines[0]) + len("</available_skills>")
    count = 0
    for entry in entries:
        if count >= max_skills:
            break
        description = entry.description[:max_desc_chars].strip()
        scripts = ", ".join(path.replace("scripts/", "") for path in entry.script_files[:8])
        resources: list[str] = []
        if entry.has_skill_md:
            resources.append("has_skill_md")
        if entry.has_references:
            resources.append("has_references")
        if entry.has_templates:
            resources.append("has_templates")
        block = [
            f'  <skill id="{entry.skill_id}">',
            f"    <description>{description}</description>",
        ]
        if scripts:
            block.append(f"    <scripts>{scripts}</scripts>")
        if resources:
            block.append(f"    <resources>{', '.join(resources)}</resources>")
        block.append("  </skill>")
        chunk = "\n".join(block)
        projected = used + len(chunk) + 1
        if projected > max_chars:
            break
        lines.append(chunk)
        used = projected
        count += 1
    lines.append("</available_skills>")
    return "\n".join(lines)
