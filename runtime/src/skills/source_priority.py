"""Source priority helpers for skill registry merging."""

from __future__ import annotations

from typing import Any

SOURCE_PRIORITY_ORDER: tuple[str, ...] = (
    "managed",
    "project",
    "user",
    "bundled",
    "manual",
    "remote",
    "mcp",
)

_SOURCE_PRIORITY_MAP = {name: index for index, name in enumerate(SOURCE_PRIORITY_ORDER)}


def normalize_skill_source(value: Any) -> str:
    text = str(value or "").strip().lower()
    return text or "manual"


def source_priority(value: Any) -> int:
    normalized = normalize_skill_source(value)
    return _SOURCE_PRIORITY_MAP.get(normalized, len(SOURCE_PRIORITY_ORDER))


def compare_skill_sources(left: Any, right: Any) -> int:
    left_priority = source_priority(left)
    right_priority = source_priority(right)
    if left_priority < right_priority:
        return -1
    if left_priority > right_priority:
        return 1
    return 0
