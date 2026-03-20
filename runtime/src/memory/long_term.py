"""Long-term memory implementation using SQLite with numpy cosine similarity.

Provides persistent, semantic memory storage with vector similarity search.
Used for:
- Historical conversation summaries
- User preferences and patterns
- Knowledge base entries
- Agent learned experiences
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import numpy as np

from src.constants import (
    DEFAULT_MIN_SIMILARITY,
    DEFAULT_SEARCH_LIMIT,
    MAX_SEARCH_LIMIT,
)
from src.memory.base import LongTermMemoryInterface, MemoryEntry, MemorySearchResult
from src.memory.embedding import EmbeddingService
from src.utils.logging import get_logger
from src.utils.validation import (
    validate_content,
    validate_float_range,
    validate_positive_int,
)


logger = get_logger(__name__)


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    """Compute cosine similarity between two vectors."""
    va = np.array(a)
    vb = np.array(b)
    norm_a = np.linalg.norm(va)
    norm_b = np.linalg.norm(vb)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(va, vb) / (norm_a * norm_b))
class LongTermMemory(LongTermMemoryInterface):
    """
    SQLite-based long-term memory with numpy cosine similarity search.

    Stores semantic memories with vector embeddings for similarity search.
    Embeddings are stored as JSON text in SQLite; similarity is computed
    in Python using numpy.
    """

    def __init__(
        self,
        embedding_service: EmbeddingService,
        db_path: str | None = None,
        **_kwargs: Any,
    ):
        """
        Initialize long-term memory.

        Args:
            embedding_service: Service for generating embeddings
            db_path: Optional SQLite database path (default: ~/.semibot/semibot.db)
        """
        self.embedding_service = embedding_service
        resolved = Path(db_path).expanduser() if db_path else Path("~/.semibot/semibot.db").expanduser()
        resolved.parent.mkdir(parents=True, exist_ok=True)
        self.db_path = resolved
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout = 30000")
        return conn

    def _init_schema(self) -> None:
        conn = self._connect()
        try:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS memories (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    session_id TEXT,
                    user_id TEXT,
                    content TEXT NOT NULL,
                    embedding_json TEXT,
                    memory_type TEXT NOT NULL DEFAULT 'episodic',
                    importance REAL NOT NULL DEFAULT 0.5,
                    metadata TEXT NOT NULL DEFAULT '{}',
                    access_count INTEGER NOT NULL DEFAULT 0,
                    last_accessed_at TEXT,
                    created_at TEXT NOT NULL,
                    expires_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id);
                CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
                CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
                """
            )
            conn.commit()
        finally:
            conn.close()
    async def __aenter__(self) -> "LongTermMemory":
        return self

    async def __aexit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        await self.close()

    async def close(self) -> None:
        """Close the embedding service."""
        await self.embedding_service.close()

    async def save(
        self,
        agent_id: str,
        content: str,
        importance: float = 0.5,
        metadata: dict[str, Any] | None = None,
        memory_type: str = "episodic",
        user_id: str | None = None,
        session_id: str | None = None,
        org_id: str | None = None,
    ) -> str:
        content = validate_content(content, min_length=1)
        importance = validate_float_range(importance, "importance", 0.0, 1.0, 0.5)

        embedding_result = await self.embedding_service.embed(content)
        embedding = embedding_result.embedding

        entry_id = str(uuid4())
        now_iso = datetime.now(timezone.utc).isoformat()

        conn = self._connect()
        try:
            conn.execute(
                """
                INSERT INTO memories (id, agent_id, session_id, user_id, content,
                    embedding_json, memory_type, importance, metadata, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    entry_id, agent_id, session_id, user_id, content,
                    json.dumps(embedding), memory_type, importance,
                    json.dumps(metadata or {}), now_iso,
                ),
            )
            conn.commit()
        finally:
            conn.close()

        logger.info(
            "long_term_memory_saved",
            entry_id=entry_id, agent_id=agent_id,
            memory_type=memory_type, importance=importance,
            content_length=len(content),
        )
        return entry_id
    async def search(
        self,
        agent_id: str,
        query: str,
        limit: int = DEFAULT_SEARCH_LIMIT,
        min_importance: float = 0.0,
        min_similarity: float = DEFAULT_MIN_SIMILARITY,
        memory_type: str | None = None,
        org_id: str | None = None,
    ) -> list[MemorySearchResult]:
        query = validate_content(query, min_length=1)
        limit = validate_positive_int(limit, "limit", DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT)

        embedding_result = await self.embedding_service.embed(query)
        query_embedding = embedding_result.embedding

        # Load candidates from DB
        conn = self._connect()
        try:
            sql = """
                SELECT id, content, memory_type, importance, metadata, created_at, embedding_json
                FROM memories
                WHERE agent_id = ?
                  AND (expires_at IS NULL OR expires_at > ?)
                  AND importance >= ?
            """
            params: list[Any] = [agent_id, datetime.now(timezone.utc).isoformat(), min_importance]
            if memory_type:
                sql += " AND memory_type = ?"
                params.append(memory_type)

            rows = conn.execute(sql, params).fetchall()
        finally:
            conn.close()

        # Compute similarity in Python
        scored: list[tuple[sqlite3.Row, float]] = []
        for row in rows:
            emb_json = row["embedding_json"]
            if not emb_json:
                continue
            emb = json.loads(emb_json)
            sim = _cosine_similarity(query_embedding, emb)
            if sim >= min_similarity:
                scored.append((row, sim))

        scored.sort(key=lambda x: x[1], reverse=True)
        scored = scored[:limit]

        results: list[MemorySearchResult] = []
        for row, sim in scored:
            raw_meta = row["metadata"]
            meta = json.loads(raw_meta) if isinstance(raw_meta, str) else (raw_meta or {})
            entry = MemoryEntry(
                id=row["id"],
                content=row["content"],
                agent_id=agent_id,
                importance=row["importance"],
                metadata=meta,
                created_at=datetime.fromisoformat(row["created_at"]) if row["created_at"] else datetime.now(timezone.utc),
            )
            results.append(MemorySearchResult(entry=entry, score=sim, distance=1 - sim))

        # Update access counts
        if results:
            self._batch_update_access([r.entry.id for r in results])

        logger.debug(
            "long_term_memory_search",
            agent_id=agent_id, query_length=len(query),
            results_count=len(results), limit=limit,
        )
        return results

    def _batch_update_access(self, entry_ids: list[str]) -> None:
        now_iso = datetime.now(timezone.utc).isoformat()
        conn = self._connect()
        try:
            for eid in entry_ids:
                conn.execute(
                    "UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?",
                    (now_iso, eid),
                )
            conn.commit()
        except Exception as e:
            logger.warning("memory_access_update_failed", error=str(e))
        finally:
            conn.close()
    async def delete(self, entry_id: str) -> bool:
        conn = self._connect()
        try:
            cursor = conn.execute("DELETE FROM memories WHERE id = ?", (entry_id,))
            conn.commit()
            deleted = cursor.rowcount > 0
        finally:
            conn.close()

        if deleted:
            logger.info("long_term_memory_deleted", entry_id=entry_id)
        else:
            logger.warning("long_term_memory_delete_not_found", entry_id=entry_id)
        return deleted

    async def get(self, entry_id: str) -> MemoryEntry | None:
        conn = self._connect()
        try:
            row = conn.execute(
                """
                SELECT id, agent_id, session_id, content, importance,
                       metadata, created_at, expires_at
                FROM memories WHERE id = ?
                """,
                (entry_id,),
            ).fetchone()
        finally:
            conn.close()

        if not row:
            return None

        raw_meta = row["metadata"]
        meta = json.loads(raw_meta) if isinstance(raw_meta, str) else (raw_meta or {})
        return MemoryEntry(
            id=row["id"],
            content=row["content"],
            agent_id=row["agent_id"],
            session_id=row["session_id"],
            importance=row["importance"],
            metadata=meta,
            created_at=datetime.fromisoformat(row["created_at"]) if row["created_at"] else datetime.now(timezone.utc),
            expires_at=datetime.fromisoformat(row["expires_at"]) if row["expires_at"] else None,
        )

    async def update_importance(self, entry_id: str, importance: float) -> bool:
        importance = validate_float_range(importance, "importance", 0.0, 1.0, 0.5)
        conn = self._connect()
        try:
            cursor = conn.execute(
                "UPDATE memories SET importance = ? WHERE id = ?",
                (importance, entry_id),
            )
            conn.commit()
            return cursor.rowcount > 0
        finally:
            conn.close()

    async def get_by_agent(
        self,
        agent_id: str,
        limit: int = DEFAULT_SEARCH_LIMIT,
        memory_type: str | None = None,
        org_id: str | None = None,
    ) -> list[MemoryEntry]:
        limit = validate_positive_int(limit, "limit", DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT)

        sql = """
            SELECT id, agent_id, session_id, content, importance,
                   metadata, created_at, expires_at
            FROM memories
            WHERE agent_id = ?
              AND (expires_at IS NULL OR expires_at > ?)
        """
        params: list[Any] = [agent_id, datetime.now(timezone.utc).isoformat()]
        if memory_type:
            sql += " AND memory_type = ?"
            params.append(memory_type)
        sql += " ORDER BY importance DESC, created_at DESC LIMIT ?"
        params.append(limit)

        conn = self._connect()
        try:
            rows = conn.execute(sql, params).fetchall()
        finally:
            conn.close()

        results: list[MemoryEntry] = []
        for row in rows:
            raw_meta = row["metadata"]
            meta = json.loads(raw_meta) if isinstance(raw_meta, str) else (raw_meta or {})
            results.append(MemoryEntry(
                id=row["id"],
                content=row["content"],
                agent_id=row["agent_id"],
                session_id=row["session_id"],
                importance=row["importance"],
                metadata=meta,
                created_at=datetime.fromisoformat(row["created_at"]) if row["created_at"] else datetime.now(timezone.utc),
                expires_at=datetime.fromisoformat(row["expires_at"]) if row["expires_at"] else None,
            ))
        return results

    async def health_check(self) -> bool:
        try:
            conn = self._connect()
            try:
                conn.execute("SELECT 1")
                return True
            finally:
                conn.close()
        except Exception as e:
            logger.error("database_health_check_failed", error=str(e))
            return False



