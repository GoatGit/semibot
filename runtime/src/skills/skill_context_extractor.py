"""Structured extraction helpers for loaded SKILL.md content."""

from __future__ import annotations

import re
from typing import Any

_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+(?P<title>.+?)\s*$", re.MULTILINE)


def extract_skill_scaffold(skill_id: str, skill_md: str) -> dict[str, Any]:
    text = str(skill_md or "")
    headings = [match.group("title").strip() for match in _HEADING_RE.finditer(text) if match.group("title").strip()]
    sections = headings[:12]
    return {
        "skill_id": str(skill_id or "").strip(),
        "source_sections": sections,
        "phase_outline": sections[:8],
        "content_excerpt": text[:2000],
    }


def normalize_skill_context_for_act(skill_context: Any) -> dict[str, Any] | None:
    if not isinstance(skill_context, dict):
        return None
    normalized = dict(skill_context)
    for key in ("execution_rules", "quality_checks", "artifact_rules", "replan_triggers", "source_sections"):
        value = normalized.get(key)
        if isinstance(value, list):
            normalized[key] = [item for item in value if isinstance(item, (dict, str))]
    skill_id = str(normalized.get("skill_id") or "").strip()
    if skill_id:
        normalized["skill_id"] = skill_id
    return normalized
