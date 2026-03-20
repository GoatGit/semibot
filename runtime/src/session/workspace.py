from __future__ import annotations

import shutil
from pathlib import Path

from src.bootstrap import default_skills_path
from src.utils.validation import validate_session_id


def semibot_home_dir() -> Path:
    root = (Path.home() / ".semibot").resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def session_working_dir(session_id: str) -> Path:
    root = semibot_home_dir() / "workspaces" / validate_session_id(session_id)
    root.mkdir(parents=True, exist_ok=True)
    return root


def session_skills_dir(session_id: str) -> Path:
    root = session_working_dir(session_id) / "skills"
    root.mkdir(parents=True, exist_ok=True)
    return root


def materialize_skill_workspace(session_id: str, skill_name: str) -> Path | None:
    normalized = str(skill_name or "").strip()
    if not normalized:
        return None
    source_root = default_skills_path() / normalized
    try:
        source_root = source_root.expanduser().resolve()
    except Exception:
        return None
    if not source_root.exists() or not source_root.is_dir():
        return None

    destination = (session_skills_dir(session_id) / normalized).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        return destination

    shutil.copytree(
        source_root,
        destination,
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store", ".git"),
    )
    return destination


def materialize_skill_index(session_id: str, skill_index: list[dict[str, object]] | None) -> list[str]:
    if not isinstance(skill_index, list):
        return []
    materialized: list[str] = []
    for item in skill_index:
        if not isinstance(item, dict):
            continue
        skill_name = str(item.get("id") or item.get("name") or "").strip()
        if not skill_name:
            continue
        dest = materialize_skill_workspace(session_id, skill_name)
        if dest is not None:
            materialized.append(skill_name)
    return materialized
