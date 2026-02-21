from __future__ import annotations

from pathlib import Path
from typing import Any

from src.memory.local_memory import LocalShortTermMemory
from src.utils.logging import get_logger
from src.ws.client import ControlPlaneClient

logger = get_logger(__name__)


class WSMemoryProxy:
    """Memory adapter for execution-plane mode.

    - short-term memory: local markdown files
    - long-term search: request control plane over WS
    - long-term save: currently best-effort no-op (design can be extended later)
    """

    def __init__(self, client: ControlPlaneClient, base_dir: str) -> None:
        self.client = client
        self.short_term = LocalShortTermMemory(base_dir)

    async def get_short_term(self, session_id: str) -> str:
        return await self.short_term.read(session_id)

    async def save_short_term(self, session_id: str, content: str, agent_id: str = "") -> None:
        del agent_id
        await self.short_term.append(session_id, content)

    async def search_long_term(self, agent_id: str, query: str, limit: int = 5, org_id: str | None = None) -> str:
        del agent_id, org_id
        try:
            result = await self.client.request(
                session_id="__memory__",
                method="memory_search",
                query=query,
                top_k=limit,
            )
        except Exception as exc:
            logger.warning("ws_memory_search_failed", extra={"error": str(exc)})
            return ""

        items = []
        if isinstance(result, dict):
            items = result.get("results", [])
        if not isinstance(items, list):
            return ""

        contents: list[str] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if isinstance(content, str) and content.strip():
                contents.append(content.strip())

        return "\n\n".join(contents)

    async def save_long_term(
        self,
        agent_id: str,
        content: str,
        importance: float = 0.5,
        org_id: str | None = None,
    ) -> None:
        # Placeholder: protocol currently has memory_search but no memory_write.
        # Keep non-blocking behavior to avoid breaking main flow.
        del agent_id, content, importance, org_id
        return
