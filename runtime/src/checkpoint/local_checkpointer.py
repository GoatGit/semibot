from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any


class LocalCheckpointer:
    def __init__(self, base_dir: str, keep_count: int = 10) -> None:
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.keep_count = keep_count

    def _session_dir(self, session_id: str) -> Path:
        path = self.base_dir / session_id / "checkpoints"
        path.mkdir(parents=True, exist_ok=True)
        return path

    async def save(self, session_id: str, checkpoint: dict[str, Any]) -> None:
        checkpoint_dir = self._session_dir(session_id)
        checkpoint_id = str(checkpoint.get("id") or int(time.time() * 1000))
        path = checkpoint_dir / f"{checkpoint_id}.json"
        path.write_text(
            json.dumps(checkpoint, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        self._cleanup_old_files(checkpoint_dir)

    async def load_latest(self, session_id: str) -> dict[str, Any] | None:
        checkpoint_dir = self._session_dir(session_id)
        files = sorted(checkpoint_dir.glob("*.json"), key=lambda f: f.stat().st_mtime, reverse=True)
        if not files:
            return None
        return json.loads(files[0].read_text(encoding="utf-8"))

    async def load(self, session_id: str) -> dict[str, Any] | None:
        return await self.load_latest(session_id)

    async def get_all_for_snapshot(self, session_id: str) -> dict[str, Any]:
        latest = await self.load_latest(session_id)
        return latest or {}

    async def clear(self, session_id: str) -> None:
        checkpoint_dir = self.base_dir / session_id / "checkpoints"
        if not checkpoint_dir.exists():
            return
        for f in checkpoint_dir.glob("*.json"):
            f.unlink()

    def _cleanup_old_files(self, checkpoint_dir: Path) -> None:
        files = sorted(checkpoint_dir.glob("*.json"), key=lambda f: f.stat().st_mtime, reverse=True)
        for old in files[self.keep_count :]:
            old.unlink(missing_ok=True)
