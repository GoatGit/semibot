"""FileManager — persist, retrieve, and clean up generated files."""

from __future__ import annotations

import asyncio
import mimetypes
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

from src.constants.config import (
    GENERATED_FILES_ALLOWED_EXTENSIONS,
    GENERATED_FILES_CLEANUP_INTERVAL_SECONDS,
    GENERATED_FILES_DIR,
    GENERATED_FILES_MAX_SIZE_BYTES,
    GENERATED_FILES_TTL_SECONDS,
)
from src.utils.logging import get_logger

logger = get_logger(__name__)


class FileManager:
    """Manage generated files with TTL-based expiration."""

    def __init__(self, base_dir: str = GENERATED_FILES_DIR) -> None:
        self._base_dir = Path(base_dir)
        self._base_dir.mkdir(parents=True, exist_ok=True)
        self._cleanup_task: asyncio.Task[None] | None = None

    def persist_file(self, src_path: str | Path) -> dict[str, Any] | None:
        src = Path(src_path)
        if not src.is_file():
            return None

        ext = src.suffix.lower()
        if ext not in GENERATED_FILES_ALLOWED_EXTENSIONS:
            logger.debug("Skipping file with disallowed extension: %s", ext)
            return None

        size = src.stat().st_size
        if size > GENERATED_FILES_MAX_SIZE_BYTES:
            logger.warning(
                "File exceeds size limit, skipping (size: %d, limit: %d)",
                size,
                GENERATED_FILES_MAX_SIZE_BYTES,
            )
            return None

        file_id = uuid.uuid4().hex
        dest_dir = self._base_dir / file_id
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / src.name
        shutil.copy2(str(src), str(dest))

        mime_type = mimetypes.guess_type(src.name)[0] or "application/octet-stream"
        logger.info("File persisted: %s -> %s (size: %d, mime: %s)", src.name, file_id, size, mime_type)
        return {
            "file_id": file_id,
            "filename": src.name,
            "path": str(dest),
            "size": size,
            "mime_type": mime_type,
        }

    def get_file_path(self, file_id: str) -> Path | None:
        file_dir = self._base_dir / file_id
        if not file_dir.is_dir():
            return None
        files = list(file_dir.iterdir())
        if not files:
            return None
        return files[0]

    def cleanup_expired(self) -> int:
        if not self._base_dir.exists():
            return 0
        now = time.time()
        removed = 0
        for entry in self._base_dir.iterdir():
            if not entry.is_dir():
                continue
            try:
                mtime = entry.stat().st_mtime
                if now - mtime > GENERATED_FILES_TTL_SECONDS:
                    shutil.rmtree(str(entry))
                    removed += 1
            except Exception as exc:
                logger.warning("Failed to clean up %s: %s", entry.name, exc)
        if removed > 0:
            logger.info("Cleaned up %d expired file(s)", removed)
        return removed

    def start_cleanup_loop(self) -> None:
        if self._cleanup_task is not None:
            return

        async def _loop() -> None:
            while True:
                await asyncio.sleep(GENERATED_FILES_CLEANUP_INTERVAL_SECONDS)
                try:
                    self.cleanup_expired()
                except Exception as exc:
                    logger.error("Cleanup loop error: %s", exc)

        self._cleanup_task = asyncio.create_task(_loop())
        logger.info("File cleanup loop started (interval: %ds)", GENERATED_FILES_CLEANUP_INTERVAL_SECONDS)

    def stop_cleanup_loop(self) -> None:
        if self._cleanup_task is not None:
            self._cleanup_task.cancel()
            self._cleanup_task = None
            logger.info("File cleanup loop stopped")
