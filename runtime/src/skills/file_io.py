"""Builtin file IO tool.

Provides controlled local file read/write/list operations.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from src.server.config_store import RuntimeConfigStore
from src.skills.base import BaseTool, ToolResult


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
        return "Read/write/list local files under configured root directory."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["read", "write", "list"],
                    "description": "File operation action",
                },
                "operation": {
                    "type": "string",
                    "enum": ["read", "write", "list"],
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
        **_: Any,
    ) -> ToolResult:
        resolved_action = (action or operation or "").strip().lower()
        if resolved_action == "ls":
            resolved_action = "list"
        if not resolved_action:
            return ToolResult.error_result("action is required (read/write/list)")

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
