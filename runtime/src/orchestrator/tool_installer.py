"""Installer for independently installable tools, primarily CLI-backed tools."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from src.bootstrap import default_skills_path
from src.skills.package_loader import register_installed_package_tools
from src.skills.registry import SkillRegistry
from src.skills.skill_installer import _install_from_registry


def install_tool_from_registry(
    *,
    registry: SkillRegistry,
    registry_name: str,
    skills_root: str | Path | None = None,
) -> dict[str, Any]:
    """Install a tool-capability from a registry entry.

    Current CLI tool delivery is skill-package backed, so the installer delegates
    to the existing registry skill installer, then refreshes runtime tools.
    This keeps tool-level installation semantics separate even while the
    underlying package transport is shared.
    """

    root = Path(skills_root or os.getenv("SEMIBOT_SKILLS_PATH", str(default_skills_path()))).expanduser()
    install_result = _install_from_registry(
        registry=registry,
        registry_name=str(registry_name or "").strip(),
        skills_root=root,
    )
    refresh = register_installed_package_tools(registry, skills_root=root)
    return {
        "ok": True,
        "action": "install_tool",
        "registry_name": str(registry_name or "").strip(),
        "install_result": install_result,
        "refresh": refresh,
    }
