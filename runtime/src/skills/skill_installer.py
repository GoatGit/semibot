"""Builtin tool to install package skills from folder/zip and refresh registry."""

from __future__ import annotations

import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from urllib.request import urlopen

from src.bootstrap import default_skills_path
from src.skills.base import BaseTool, ToolResult
from src.skills.package_loader import register_installed_package_tools, resolve_skill_dir
from src.skills.registry import SkillRegistry


class SkillInstallerTool(BaseTool):
    def __init__(self, registry: SkillRegistry) -> None:
        self._registry = registry

    @property
    def name(self) -> str:
        return "skill_installer"

    @property
    def description(self) -> str:
        return (
            "Install a package skill from local folder/zip (or remote zip URL) into ~/.semibot/skills "
            "and refresh runtime tool index dynamically."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "source_path": {"type": "string", "description": "Local folder path or .zip file path."},
                "source_url": {"type": "string", "description": "Optional remote .zip URL (http/https)."},
                "skill_name": {"type": "string", "description": "Optional target skill name. Defaults to source name."},
                "force": {"type": "boolean", "description": "Overwrite existing installed skill directory.", "default": False},
                "refresh_only": {"type": "boolean", "description": "Only refresh runtime index from installed skills.", "default": False},
            },
            "required": [],
            "additionalProperties": False,
        }

    async def execute(
        self,
        source_path: str | None = None,
        source_url: str | None = None,
        skill_name: str | None = None,
        force: bool = False,
        refresh_only: bool = False,
        **_: Any,
    ) -> ToolResult:
        skills_root = default_skills_path()
        skills_root.mkdir(parents=True, exist_ok=True)
        temp_dirs: list[tempfile.TemporaryDirectory[str]] = []

        if refresh_only:
            summary = register_installed_package_tools(self._registry, skills_root=skills_root)
            return ToolResult.success_result({"ok": True, "action": "refresh", **summary})

        raw = str(source_path or "").strip()
        remote = str(source_url or "").strip()
        if not raw and not remote:
            return ToolResult.error_result("source_path or source_url is required unless refresh_only=true")

        src: Path
        if remote:
            parsed = urlparse(remote)
            if parsed.scheme not in {"http", "https"}:
                return ToolResult.error_result("source_url must start with http:// or https://")
            download_temp = tempfile.TemporaryDirectory(prefix="semibot_skill_install_")
            temp_dirs.append(download_temp)
            downloaded_zip = Path(download_temp.name) / "skill.zip"
            with urlopen(remote, timeout=30) as response:  # nosec B310 - controlled by runtime policy/tool config
                downloaded_zip.write_bytes(response.read())
            src = downloaded_zip
        else:
            src = Path(raw).expanduser()
            if not src.exists():
                return ToolResult.error_result(f"source_path not found: {src}")

        try:
            if src.is_file():
                if src.suffix.lower() != ".zip":
                    return ToolResult.error_result("source_path file must be .zip")
                extracted_temp = tempfile.TemporaryDirectory(prefix="semibot_skill_extract_")
                temp_dirs.append(extracted_temp)
                extracted_root = Path(extracted_temp.name)
                with zipfile.ZipFile(src, "r") as zf:
                    zf.extractall(extracted_root)
                skill_dir = resolve_skill_dir(extracted_root)
                default_name = src.stem
            else:
                skill_dir = resolve_skill_dir(src)
                default_name = src.name

            if skill_dir is None:
                return ToolResult.error_result("skill package invalid: scripts/main.py not found")

            target_name = str(skill_name or default_name).strip()
            if not target_name:
                return ToolResult.error_result("skill_name cannot be empty")

            target_dir = skills_root / target_name
            if target_dir.exists():
                if not force:
                    return ToolResult.error_result(
                        f"target skill already exists: {target_name}; use force=true to overwrite"
                    )
                shutil.rmtree(target_dir)

            shutil.copytree(skill_dir, target_dir)
            refresh = register_installed_package_tools(self._registry, skills_root=skills_root)
            return ToolResult.success_result(
                {
                    "ok": True,
                    "action": "install",
                    "source_path": str(src),
                    "installed_path": str(target_dir),
                    "skill_name": target_name,
                    "refresh": refresh,
                }
            )
        finally:
            for item in temp_dirs:
                item.cleanup()
