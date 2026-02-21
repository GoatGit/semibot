from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class LocalShortTermMemory:
    def __init__(self, base_dir: str) -> None:
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def _session_file(self, session_id: str) -> Path:
        return self.base_dir / f"{session_id}.md"

    async def append(self, session_id: str, content: str) -> None:
        file_path = self._session_file(session_id)
        file_path.parent.mkdir(parents=True, exist_ok=True)
        with file_path.open("a", encoding="utf-8") as f:
            f.write(content)
            f.write("\n\n")

    async def read(self, session_id: str) -> str:
        file_path = self._session_file(session_id)
        if not file_path.exists():
            return ""
        return file_path.read_text(encoding="utf-8")

    async def snapshot(self, session_id: str) -> dict[str, Any]:
        return {
            "session_id": session_id,
            "content": await self.read(session_id),
        }

    async def restore(self, session_id: str, snapshot: dict[str, Any]) -> None:
        content = snapshot.get("content", "")
        self._session_file(session_id).write_text(content, encoding="utf-8")


class LocalMemoryIndex:
    def __init__(self, base_dir: str) -> None:
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def save(self, session_id: str, data: dict[str, Any]) -> None:
        path = self.base_dir / f"{session_id}.json"
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def load(self, session_id: str) -> dict[str, Any]:
        path = self.base_dir / f"{session_id}.json"
        if not path.exists():
            return {}
        return json.loads(path.read_text(encoding="utf-8"))
