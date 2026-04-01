"""Helpers for locating skill resources from index/package metadata."""

from __future__ import annotations

from pathlib import Path
from typing import Any


def locate_skill_md(skill_item: dict[str, Any]) -> tuple[str, str | None]:
    package = skill_item.get("package") if isinstance(skill_item.get("package"), dict) else None
    files = package.get("files") if isinstance(package, dict) else None
    if isinstance(files, list):
        for file_item in files:
            if not isinstance(file_item, dict):
                continue
            if str(file_item.get("path") or "").strip() != "SKILL.md":
                continue
            content = str(file_item.get("content") or "")
            if content:
                return content, "package"
    installed_path = str(skill_item.get("installed_path") or "").strip()
    if installed_path:
        try:
            target = (Path(installed_path).expanduser().resolve() / "SKILL.md").resolve()
            if target.exists() and target.is_file():
                return target.read_text(encoding="utf-8", errors="replace"), "filesystem"
        except Exception:
            return "", None
    return "", None


def locate_skill_resources(skill_item: dict[str, Any]) -> dict[str, Any]:
    resources = skill_item.get("resources") if isinstance(skill_item.get("resources"), dict) else {}
    return {
        "has_skill_md": bool(resources.get("has_skill_md", skill_item.get("has_skill_md"))),
        "has_references": bool(resources.get("has_references", skill_item.get("has_references"))),
        "has_templates": bool(resources.get("has_templates", skill_item.get("has_templates"))),
        "script_files": list(resources.get("script_files") or skill_item.get("script_files") or []),
    }
