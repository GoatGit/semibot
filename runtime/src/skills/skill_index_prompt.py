"""Helpers to build compact skill index prompt payloads."""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any


@dataclass
class SkillIndexEntry:
    skill_id: str
    name: str
    description: str
    when_to_use: str
    script_files: list[str]
    has_skill_md: bool
    has_references: bool
    has_templates: bool
    execution_context: str | None = None
    effort: str | None = None
    paths: list[str] | None = None
    enabled: bool = True


def build_skill_index_entries(index_records: list[dict[str, Any]]) -> list[SkillIndexEntry]:
    entries: list[SkillIndexEntry] = []
    for record in index_records:
        if not isinstance(record, dict):
            continue
        if not record.get("enabled", True):
            continue
        if record.get("visible_to_model") is False:
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
                when_to_use=str(record.get("when_to_use") or record.get("whenToUse") or "").strip(),
                script_files=script_files,
                has_skill_md=bool((record.get("resources") or {}).get("has_skill_md", record.get("has_skill_md"))),
                has_references=bool((record.get("resources") or {}).get("has_references", record.get("has_references"))),
                has_templates=bool((record.get("resources") or {}).get("has_templates", record.get("has_templates"))),
                execution_context=str(record.get("execution_context") or "").strip() or None,
                effort=str(record.get("effort") or "").strip() or None,
                paths=[
                    str(item).strip()
                    for item in (record.get("paths") if isinstance(record.get("paths"), list) else [])
                    if str(item).strip()
                ] or None,
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
        when_to_use = entry.when_to_use[:max_desc_chars].strip()
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
        if when_to_use:
            block.append(f"    <when_to_use>{when_to_use}</when_to_use>")
        if scripts:
            block.append(f"    <scripts>{scripts}</scripts>")
        if resources:
            block.append(f"    <resources>{', '.join(resources)}</resources>")
        if entry.execution_context:
            block.append(f"    <execution_context>{entry.execution_context}</execution_context>")
        if entry.effort:
            block.append(f"    <effort>{entry.effort}</effort>")
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


_PATH_TOKEN_RE = re.compile(r"(?:\./|/)?[\w.\-]+(?:/[\w.\-]+)+")


def extract_path_context_tokens(*texts: str, explicit_paths: list[str] | None = None) -> list[str]:
    values: list[str] = []
    for text in texts:
        for match in _PATH_TOKEN_RE.findall(str(text or "")):
            normalized = match.strip().lstrip("./")
            if normalized:
                values.append(normalized)
    for item in explicit_paths or []:
        normalized = str(item or "").strip().lstrip("./")
        if normalized:
            values.append(normalized)
    deduped: list[str] = []
    seen: set[str] = set()
    for item in values:
        if item in seen:
            continue
        seen.add(item)
        deduped.append(item)
    return deduped


def _paths_match_score(entry: SkillIndexEntry, path_tokens: list[str]) -> int:
    if not entry.paths:
        return 0
    if not path_tokens:
        return -1
    score = 0
    normalized_patterns = [pattern.rstrip("/**").lstrip("./") for pattern in entry.paths if pattern]
    for token in path_tokens:
        for pattern in normalized_patterns:
            if token.startswith(pattern) or pattern in token:
                score = max(score, 3)
    return score if score > 0 else -1


def sort_skill_index_entries(
    entries: list[SkillIndexEntry],
    *,
    user_text: str,
    active_paths: list[str] | None = None,
    prior_selected_skill: str | None = None,
) -> list[SkillIndexEntry]:
    query = str(user_text or "").strip().lower()
    prior_skill = str(prior_selected_skill or "").strip().lower()
    path_tokens = extract_path_context_tokens(user_text, explicit_paths=active_paths)

    def _score(entry: SkillIndexEntry) -> tuple[int, int, int, str]:
        explicit = 0
        if query:
            names = {entry.skill_id.lower(), entry.name.lower()}
            if any(name and name in query for name in names):
                explicit = 100
        path_score = _paths_match_score(entry, path_tokens)
        prior = 10 if prior_skill and entry.skill_id.lower() == prior_skill else 0
        return (explicit, path_score, prior, entry.skill_id)

    return sorted(entries, key=_score, reverse=True)
