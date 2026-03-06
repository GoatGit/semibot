"""Builtin file IO tool.

Provides controlled local file read/write/list operations.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from src.bootstrap import default_skills_path
from src.server.config_store import RuntimeConfigStore
from src.skills.base import BaseTool, ToolResult
from src.skills.skill_injection_tracker import SkillInjectionTracker


_ALLOWED_SKILL_RESOURCE_DIRS = {"reference", "references", "templates", "assets"}


class FileIOTool(BaseTool):
    def __init__(self) -> None:
        self.root = Path(os.getenv("SEMIBOT_FILE_IO_ROOT", str(Path.home()))).resolve()
        self.max_read_bytes = int(os.getenv("SEMIBOT_FILE_IO_MAX_READ_BYTES", "200000"))
        self._load_runtime_config()

    @property
    def name(self) -> str:
        return "file_io"

    @property
    def description(self) -> str:
        return (
            "Read/write/list local files under configured root directory. "
            "Also supports action=read_skill_file to read a file from an installed skill package safely."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["read", "write", "list", "read_skill_file"],
                    "description": (
                        "File operation action. "
                        "Use read_skill_file with skill_name + file_path to read installed skill docs safely."
                    ),
                },
                "operation": {
                    "type": "string",
                    "enum": ["read", "write", "list", "read_skill_file"],
                    "description": "Alias of action (compatibility)",
                },
                "path": {
                    "type": "string",
                    "description": "Path under allowed root",
                    "default": ".",
                },
                "content": {
                    "type": "string",
                    "description": "Content to write (required for action=write)",
                },
                "recursive": {
                    "type": "boolean",
                    "description": "Whether list should recurse into subdirectories",
                    "default": False,
                },
                "skill_name": {
                    "type": "string",
                    "description": "Installed skill name for action=read_skill_file, e.g. deep-research",
                },
                "file_path": {
                    "type": "string",
                    "description": "Relative file path under the skill directory for action=read_skill_file, e.g. SKILL.md",
                },
            },
            "required": [],
        }

    def _load_runtime_config(self) -> None:
        """Load file_io config from sqlite tool config if available."""
        try:
            store = RuntimeConfigStore(db_path=os.getenv("SEMIBOT_EVENTS_DB_PATH"))
            item = store.get_tool_by_name("file_io")
            config = item.get("config") if isinstance(item, dict) else {}
            if not isinstance(config, dict):
                return

            root_from_cfg = config.get("rootPath") or config.get("root")
            if isinstance(root_from_cfg, str) and root_from_cfg.strip():
                self.root = Path(root_from_cfg).expanduser().resolve()

            max_read = config.get("maxReadBytes")
            if isinstance(max_read, int) and max_read > 0:
                self.max_read_bytes = max_read
        except Exception:
            # Keep env/default config when sqlite config is unavailable.
            return

    def _resolve_path(self, raw_path: str | None) -> Path:
        rel = (raw_path or ".").strip() or "."
        target = (self.root / rel).resolve()
        if target != self.root and self.root not in target.parents:
            raise ValueError(f"path escapes configured root: {self.root}")
        return target

    async def execute(
        self,
        action: str | None = None,
        operation: str | None = None,
        path: str = ".",
        content: str | None = None,
        recursive: bool = False,
        skill_name: str | None = None,
        file_path: str | None = None,
        **kwargs: Any,
    ) -> ToolResult:
        resolved_action = (action or operation or "").strip().lower()
        if resolved_action == "ls":
            resolved_action = "list"
        if not resolved_action:
            return ToolResult.error_result("action is required (read/write/list/read_skill_file)")

        if resolved_action == "read_skill_file":
            runtime_context = kwargs.get("_runtime_context")
            return self._execute_read_skill_file(
                skill_name=skill_name,
                file_path=file_path,
                runtime_context=runtime_context,
            )

        try:
            target = self._resolve_path(path)
        except Exception as exc:
            return ToolResult.error_result(str(exc))

        if resolved_action == "read":
            if not target.exists() or not target.is_file():
                return ToolResult.error_result(f"File not found: {path}")
            data = target.read_bytes()
            if len(data) > self.max_read_bytes:
                data = data[: self.max_read_bytes]
            return ToolResult.success_result(
                {
                    "path": str(target.relative_to(self.root)),
                    "content": data.decode("utf-8", errors="replace"),
                    "truncated": target.stat().st_size > len(data),
                }
            )

        if resolved_action == "write":
            if content is None:
                return ToolResult.error_result("content is required for write action")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            return ToolResult.success_result(
                {
                    "path": str(target.relative_to(self.root)),
                    "bytes": target.stat().st_size,
                }
            )

        if resolved_action == "list":
            if not target.exists() or not target.is_dir():
                return ToolResult.error_result(f"Directory not found: {path}")
            iterator = target.rglob("*") if recursive else target.iterdir()
            items: list[dict[str, Any]] = []
            for item in iterator:
                rel = item.relative_to(self.root)
                items.append(
                    {
                        "path": str(rel),
                        "type": "dir" if item.is_dir() else "file",
                        "size": item.stat().st_size if item.is_file() else None,
                    }
                )
                if len(items) >= 500:
                    break
            return ToolResult.success_result({"root": str(self.root), "items": items})

        return ToolResult.error_result(f"Unsupported action: {resolved_action}")

    @staticmethod
    def _is_allowed_skill_resource(normalized_path: str) -> bool:
        rel = normalized_path.strip().replace("\\", "/").lstrip("./")
        if rel == "SKILL.md":
            return True
        first = rel.split("/", 1)[0]
        return first in _ALLOWED_SKILL_RESOURCE_DIRS

    @staticmethod
    def _resolve_tracker(runtime_context: Any | None) -> SkillInjectionTracker | None:
        tracker = getattr(runtime_context, "skill_injection_tracker", None)
        if isinstance(tracker, SkillInjectionTracker):
            return tracker
        return None

    def _execute_read_skill_file(
        self,
        skill_name: str | None,
        file_path: str | None,
        runtime_context: Any | None = None,
    ) -> ToolResult:
        skill = str(skill_name or "").strip()
        rel = str(file_path or "").strip()
        if not skill:
            return ToolResult.error_result("skill_name is required for action=read_skill_file")
        if not rel:
            return ToolResult.error_result("file_path is required for action=read_skill_file")
        if rel.startswith("/") or rel.startswith("~"):
            return ToolResult.error_result("file_path must be a relative path inside the skill directory")
        rel_posix = rel.replace("\\", "/")
        if any(segment == ".." for segment in rel_posix.split("/")):
            return ToolResult.error_result("file_path escapes skill directory")

        skills_root = Path(os.getenv("SEMIBOT_SKILLS_PATH", str(default_skills_path()))).expanduser().resolve()
        skill_root = (skills_root / skill).resolve()
        if skill_root != skills_root and skills_root not in skill_root.parents:
            return ToolResult.error_result("invalid skill_name")
        if not skill_root.exists() or not skill_root.is_dir():
            return ToolResult.error_result(f"skill not found: {skill}")

        normalized = rel_posix.lstrip("./")
        if not self._is_allowed_skill_resource(normalized):
            return ToolResult.error_result(
                "file_path is restricted to SKILL.md or files under reference/references/templates/assets"
            )
        target = (skill_root / normalized).resolve()
        if target != skill_root and skill_root not in target.parents:
            return ToolResult.error_result("file_path escapes skill directory")
        if not target.exists() or not target.is_file():
            return ToolResult.error_result(f"Skill file not found: {normalized}")

        tracker = self._resolve_tracker(runtime_context)
        current_mtime = None
        try:
            current_mtime = target.stat().st_mtime
        except OSError:
            current_mtime = None
        if tracker:
            cached = tracker.get_cached_resource(skill, normalized, current_mtime=current_mtime)
            if cached is not None:
                return ToolResult.success_result(
                    {
                        "skill_name": skill,
                        "file_path": normalized,
                        "content": cached,
                        "truncated": False,
                        "cached": True,
                    }
                )

        data = target.read_bytes()
        truncated = False
        if len(data) > self.max_read_bytes:
            data = data[: self.max_read_bytes]
            truncated = True
        content = data.decode("utf-8", errors="replace")
        if tracker:
            tracker.mark_resource_read(
                skill,
                normalized,
                content,
                content_mtime=current_mtime,
            )

        return ToolResult.success_result(
            {
                "skill_name": skill,
                "file_path": normalized,
                "content": content,
                "truncated": truncated,
                "cached": False,
            }
        )
