"""Builtin file IO tool."""

from __future__ import annotations

import mimetypes
import os
import re
from pathlib import Path
from typing import Any

from src.constants.config import GENERATED_FILES_DIR
from src.server.config_store import RuntimeConfigStore
from src.skills.base import BaseTool, ToolResult
from src.storage.file_manager import FileManager

_file_manager: FileManager | None = FileManager(GENERATED_FILES_DIR)

# Directories inside a skill package that are readable via scope="skill"
_SKILL_READABLE_DIRS = {"reference", "resources", "docs", "examples"}
_DOC_CHUNK_PATH_RE = re.compile(r"(?:^|/)docs/([^/]+)/v(\d+)/chunks/([^/]+)\.txt$", re.IGNORECASE)


class FileIOTool(BaseTool):
    @staticmethod
    def _chunk_missing_metadata(raw_path: str | None) -> dict[str, Any]:
        path_value = str(raw_path or "").replace("\\", "/").strip().lstrip("./")
        matched = _DOC_CHUNK_PATH_RE.search(path_value)
        if not matched:
            return {}
        return {
            "missing_chunk_ids": [matched.group(3)],
            "doc_id": matched.group(1),
            "doc_version": f"v{matched.group(2)}",
        }

    def __init__(self) -> None:
        self._env_root_set = "SEMIBOT_FILE_IO_ROOT" in os.environ
        self.root = Path(os.getenv("SEMIBOT_FILE_IO_ROOT", str(Path.home()))).resolve()
        self.max_read_bytes = int(os.getenv("SEMIBOT_FILE_IO_MAX_READ_BYTES") or "200000")
        self._load_runtime_config()

    @property
    def name(self) -> str:
        return "file_io"

    @property
    def description(self) -> str:
        return (
            "Read, write, list, or edit UTF-8 text files within the current working directory. "
            "Paths may be relative, or absolute only when they stay inside the session workspace. "
            "Returns structured results for read ({path, content, truncated}), list ({items:[{path,type,size}]}), "
            "and write/edit ({ok, path, bytes, updated}). The runtime enforces the workspace boundary."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["read", "write", "list", "edit"],
                    "description": "File operation action.",
                },
                "path": {
                    "type": "string",
                    "description": (
                        "Path relative to the current working directory, "
                        "for example 'report.md' or 'notes/todo.txt'. Required for read/write/edit. "
                        "Defaults to '.' for list."
                    ),
                },
                "content": {
                    "type": "string",
                    "description": "UTF-8 text content written by action=write. Existing files are overwritten.",
                },
                "old_text": {
                    "type": "string",
                    "description": "Exact text to replace for action=edit. Only the first match is replaced; missing text returns an error.",
                },
                "new_text": {
                    "type": "string",
                    "description": "Replacement text for action=edit.",
                },
                "recursive": {
                    "type": "boolean",
                    "description": "Whether action=list should recurse into subdirectories.",
                    "default": False,
                },
            },
            "required": [],
        }

    def _load_runtime_config(self) -> None:
        try:
            store = RuntimeConfigStore(db_path=os.getenv("SEMIBOT_EVENTS_DB_PATH"))
            item = store.get_tool_by_name("file_io")
            config = item.get("config") if isinstance(item, dict) else {}
            if not isinstance(config, dict):
                return
            if not self._env_root_set:
                root_from_cfg = config.get("rootPath") or config.get("root")
                if isinstance(root_from_cfg, str) and root_from_cfg.strip():
                    self.root = Path(root_from_cfg).expanduser().resolve()
            max_read = config.get("maxReadBytes")
            if isinstance(max_read, int) and max_read > 0:
                self.max_read_bytes = max_read
        except Exception:
            return

    @staticmethod
    def _resolve_runtime_root(runtime_context: Any | None, default_root: Path) -> Path:
        if runtime_context is None:
            return default_root
        metadata = getattr(runtime_context, "metadata", None)
        if not isinstance(metadata, dict):
            return default_root
        session_working_dir = metadata.get("session_working_dir")
        if not isinstance(session_working_dir, str) or not session_working_dir.strip():
            return default_root
        root = Path(session_working_dir).expanduser().resolve()
        root.mkdir(parents=True, exist_ok=True)
        return root

    @staticmethod
    def _resolve_path(raw_path: str | None, *, root: Path) -> Path:
        rel = str(raw_path or ".").strip() or "."
        candidate = Path(rel).expanduser()
        if candidate.is_absolute():
            target = candidate.resolve()
            if target == root or root in target.parents:
                return target
            raise ValueError(f"path escapes session working directory: {root}")
        target = (root / rel).resolve()
        if target != root and root not in target.parents:
            raise ValueError(f"path escapes session working directory: {root}")
        return target

    @staticmethod
    def _display_path(target: Path, *, root: Path) -> str:
        try:
            return str(target.relative_to(root))
        except Exception:
            return str(target)

    @staticmethod
    def _infer_artifact_role(target: Path) -> str:
        suffix = target.suffix.lower()
        if suffix in {".md", ".markdown", ".txt"}:
            return "report_md"
        if suffix in {".html", ".htm"}:
            return "report_html"
        if suffix == ".pdf":
            return "report_pdf"
        if suffix == ".json":
            return "data_json"
        return "file"

    def _persist_generated_file(self, target: Path, *, root: Path) -> list[dict[str, Any]]:
        if _file_manager is None or not target.exists() or not target.is_file():
            return []
        meta = _file_manager.persist_file(target)
        if meta is None:
            return []
        artifact_role = self._infer_artifact_role(target)
        meta["source_path"] = str(target.resolve())
        meta["artifact_role"] = artifact_role
        meta["artifact_result_path"] = self._display_path(target, root=root)
        meta["artifact_medium"] = "file"
        meta["artifact_format"] = target.suffix.lower().lstrip(".") or "binary"
        meta["mime_type"] = meta.get("mime_type") or mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        meta["user_visible"] = artifact_role != "data_json"
        return [meta]

    async def _execute_skill_scope(
        self,
        action: str,
        path: str,
        skill_name: str | None,
        runtime_context: Any,
    ) -> ToolResult:
        """Handle file operations scoped to a skill's resource directory."""
        if not skill_name or not skill_name.strip():
            return ToolResult.error_result("skill_name is required for scope=skill")
        skill_name = skill_name.strip()

        skills_root = Path(os.getenv("SEMIBOT_SKILLS_PATH", str(Path.home() / ".semibot" / "skills"))).resolve()
        skill_dir = (skills_root / skill_name).resolve()

        if action == "write":
            return ToolResult.error_result("skill scope is read-only; write is not allowed")

        rel = str(path or ".").strip() or "."

        if action == "list":
            # Resolve target directory within skill dir
            target = (skill_dir / rel).resolve()
            if skill_dir not in target.parents and target != skill_dir:
                return ToolResult.error_result(f"path escapes skill directory: {skill_name}")
            # Only list whitelisted top-level dirs
            top = target.relative_to(skill_dir).parts[0] if target != skill_dir else None
            if top and top not in _SKILL_READABLE_DIRS:
                return ToolResult.error_result(f"directory '{top}' is restricted in skill scope")
            if not target.exists() or not target.is_dir():
                return ToolResult.error_result(f"Directory not found: {path}")
            items: list[dict[str, Any]] = []
            for item in target.rglob("*"):
                item_top = item.relative_to(skill_dir).parts[0]
                if item_top not in _SKILL_READABLE_DIRS:
                    continue
                rel_path = str(item.relative_to(skill_dir))
                items.append({"path": rel_path, "type": "dir" if item.is_dir() else "file",
                               "size": item.stat().st_size if item.is_file() else None})
                if len(items) >= 200:
                    break
            return ToolResult.success_result({"skill_name": skill_name, "scope": "skill", "items": items})

        # action == "read"
        target = (skill_dir / rel).resolve()
        if skill_dir not in target.parents and target != skill_dir:
            return ToolResult.error_result(f"path escapes skill directory: {skill_name}")

        # Allow SKILL.md at root; otherwise require whitelisted subdir
        rel_parts = target.relative_to(skill_dir).parts
        if len(rel_parts) == 1 and rel_parts[0].upper() == "SKILL.MD":
            pass  # always allowed
        elif rel_parts and rel_parts[0] not in _SKILL_READABLE_DIRS:
            return ToolResult.error_result(
                f"directory '{rel_parts[0]}' is restricted in skill scope; "
                f"allowed: SKILL.md, {', '.join(sorted(_SKILL_READABLE_DIRS))}"
            )

        # Check tracker cache
        tracker = None
        if runtime_context is not None:
            tracker = getattr(runtime_context, "skill_injection_tracker", None)

        file_path_key = str(target.relative_to(skill_dir))
        current_mtime: float | None = target.stat().st_mtime if target.exists() else None

        if tracker is not None:
            cached = tracker.get_cached_resource(skill_name, file_path_key, current_mtime=current_mtime)
            if cached is not None:
                return ToolResult.success_result({
                    "skill_name": skill_name,
                    "path": file_path_key,
                    "content": cached,
                    "truncated": False,
                    "cached": True,
                    "scope": "skill",
                })

        if not target.exists() or not target.is_file():
            return ToolResult.error_result(f"File not found: {path}", **self._chunk_missing_metadata(path))

        data = target.read_bytes()
        truncated = len(data) > self.max_read_bytes
        if truncated:
            data = data[: self.max_read_bytes]
        text = data.decode("utf-8", errors="replace")

        if tracker is not None:
            tracker.mark_resource_read(skill_name, file_path_key, text, content_mtime=current_mtime)

        return ToolResult.success_result({
            "skill_name": skill_name,
            "path": file_path_key,
            "content": text,
            "truncated": truncated,
            "cached": False,
            "scope": "skill",
        })

    async def execute(
        self,
        action: str | None = None,
        operation: str | None = None,
        path: str = ".",
        content: str | None = None,
        old_text: str | None = None,
        new_text: str | None = None,
        recursive: bool = False,
        scope: str | None = None,
        skill_name: str | None = None,
        **kwargs: Any,
    ) -> ToolResult:
        resolved_action = (action or operation or "").strip().lower()
        if resolved_action == "ls":
            resolved_action = "list"
        if not resolved_action:
            return ToolResult.error_result("action is required (read/write/list/edit)")

        runtime_context = kwargs.get("_runtime_context")

        if (scope or "").strip().lower() == "skill":
            return await self._execute_skill_scope(
                resolved_action, path, skill_name, runtime_context
            )
        runtime_root = self._resolve_runtime_root(runtime_context, self.root)
        try:
            target = self._resolve_path(path, root=runtime_root)
        except Exception as exc:
            return ToolResult.error_result(str(exc))

        if resolved_action == "read":
            if not target.exists() or not target.is_file():
                return ToolResult.error_result(f"File not found: {path}", **self._chunk_missing_metadata(path))
            data = target.read_bytes()
            if len(data) > self.max_read_bytes:
                data = data[: self.max_read_bytes]
            return ToolResult.success_result(
                {
                    "path": self._display_path(target, root=runtime_root),
                    "content": data.decode("utf-8", errors="replace"),
                    "truncated": target.stat().st_size > len(data),
                    "root": str(runtime_root),
                }
            )

        if resolved_action == "write":
            if content is None:
                return ToolResult.error_result("content is required for write action")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            generated_files = self._persist_generated_file(target, root=runtime_root)
            return ToolResult.success_result(
                {
                    "ok": True,
                    "path": self._display_path(target, root=runtime_root),
                    "bytes": target.stat().st_size,
                    "updated": True,
                },
                generated_files=generated_files,
            )

        if resolved_action == "edit":
            if old_text is None:
                return ToolResult.error_result("old_text is required for edit action")
            if new_text is None:
                return ToolResult.error_result("new_text is required for edit action")
            if not target.exists() or not target.is_file():
                return ToolResult.error_result(f"File not found: {path}")
            original = target.read_text(encoding="utf-8")
            if old_text not in original:
                return ToolResult.error_result("old_text not found in file")
            updated = original.replace(old_text, new_text, 1)
            target.write_text(updated, encoding="utf-8")
            generated_files = self._persist_generated_file(target, root=runtime_root)
            return ToolResult.success_result(
                {
                    "ok": True,
                    "path": self._display_path(target, root=runtime_root),
                    "bytes": target.stat().st_size,
                    "updated": True,
                },
                generated_files=generated_files,
            )

        if resolved_action == "list":
            if not target.exists() or not target.is_dir():
                return ToolResult.error_result(f"Directory not found: {path}")
            iterator = target.rglob("*") if recursive else target.iterdir()
            items: list[dict[str, Any]] = []
            for item in iterator:
                rel = item.relative_to(runtime_root)
                items.append(
                    {
                        "path": str(rel),
                        "type": "dir" if item.is_dir() else "file",
                        "size": item.stat().st_size if item.is_file() else None,
                    }
                )
                if len(items) >= 500:
                    break
            return ToolResult.success_result({"root": str(runtime_root), "items": items})

        return ToolResult.error_result(f"Unsupported action: {resolved_action}")
