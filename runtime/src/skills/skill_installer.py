"""Builtin tool to install skills from folder/zip and refresh the local skill index."""

from __future__ import annotations

import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from urllib.request import urlopen

from src.bootstrap import default_skills_path
from src.skills.index_manager import SkillsIndexManager, resolve_skill_dir, resolve_skill_md_dir
from src.skills.base import BaseTool, ToolResult
from src.skills.package_loader import register_installed_package_tools
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
            "Install a skill from local folder/zip (or remote zip URL) into ~/.semibot/skills "
            "and refresh the local skill index."
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
        try:
            result = install_or_refresh_skill(
                registry=self._registry,
                source_path=source_path,
                source_url=source_url,
                skill_name=skill_name,
                force=force,
                refresh_only=refresh_only,
                skills_root=default_skills_path(),
            )
        except Exception as exc:
            return ToolResult.error_result(str(exc))
        return ToolResult.success_result(result)


def install_or_refresh_skill(
    *,
    registry: SkillRegistry,
    source_path: str | None = None,
    source_url: str | None = None,
    skill_name: str | None = None,
    force: bool = False,
    refresh_only: bool = False,
    skills_root: str | Path | None = None,
) -> dict[str, Any]:
    root = Path(skills_root).expanduser() if skills_root else default_skills_path()
    root.mkdir(parents=True, exist_ok=True)
    temp_dirs: list[tempfile.TemporaryDirectory[str]] = []
    index = SkillsIndexManager(root)

    if refresh_only:
        reindex_result = index.reindex(scope="incremental")
        summary = register_installed_package_tools(registry, skills_root=root)
        return {"ok": True, "action": "refresh", "reindex": reindex_result, **summary}

    raw = str(source_path or "").strip()
    remote = str(source_url or "").strip()
    if not raw and not remote:
        raise ValueError("source_path or source_url is required unless refresh_only=true")

    src: Path
    source_kind = "manual"
    if remote:
        parsed = urlparse(remote)
        if parsed.scheme not in {"http", "https"}:
            raise ValueError("source_url must start with http:// or https://")
        download_temp = tempfile.TemporaryDirectory(prefix="semibot_skill_install_")
        temp_dirs.append(download_temp)
        downloaded_zip = Path(download_temp.name) / "skill.zip"
        with urlopen(remote, timeout=30) as response:  # nosec B310 - controlled by runtime policy/tool config
            downloaded_zip.write_bytes(response.read())
        src = downloaded_zip
        source_kind = "url"
    else:
        src = Path(raw).expanduser()
        if not src.exists():
            raise FileNotFoundError(f"source_path not found: {src}")

    try:
        if src.is_file():
            if src.suffix.lower() != ".zip":
                raise ValueError("source_path file must be .zip")
            extracted_temp = tempfile.TemporaryDirectory(prefix="semibot_skill_extract_")
            temp_dirs.append(extracted_temp)
            extracted_root = Path(extracted_temp.name)
            with zipfile.ZipFile(src, "r") as zf:
                zf.extractall(extracted_root)
            skill_dir = resolve_skill_dir(extracted_root) or resolve_skill_md_dir(extracted_root)
            default_name = src.stem
            if source_kind == "manual":
                source_kind = "zip"
        else:
            skill_dir = resolve_skill_dir(src) or resolve_skill_md_dir(src)
            default_name = src.name
            if source_kind == "manual":
                source_kind = "local"

        if skill_dir is None:
            raise ValueError("invalid skill: missing SKILL.md and scripts/")

        target_name = str(skill_name or default_name).strip()
        if not target_name:
            raise ValueError("skill_name cannot be empty")

        target_dir = root / target_name
        if target_dir.exists():
            if not force:
                raise ValueError(f"target skill already exists: {target_name}; use force=true to overwrite")
            shutil.rmtree(target_dir)

        shutil.copytree(skill_dir, target_dir)
        index_record = index.upsert_after_install(target_name, source=source_kind)
        refresh = register_installed_package_tools(registry, skills_root=root)
        return {
            "ok": True,
            "action": "install",
            "source_path": str(src),
            "source_type": source_kind,
            "installed_path": str(target_dir),
            "skill_name": target_name,
            "index_updated": True,
            "index_record": index_record,
            "registered_in_runtime": False,
            "refresh": refresh,
        }
    finally:
        for item in temp_dirs:
            item.cleanup()
