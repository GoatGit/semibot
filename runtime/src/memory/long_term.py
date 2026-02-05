"""Long-term memory implementation using PostgreSQL with pgvector.

Provides persistent, semantic memory storage with vector similarity search.
Used for:
- Historical conversation summaries
- User preferences and patterns
- Knowledge base entries
- Agent learned experiences
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

import asyncpg

from src.memory.base import LongTermMemoryInterface, MemoryEntry, MemorySearchResult
from src.memory.embedding import EmbeddingService
from src.utils.logging import get_logger

# Constants
DEFAULT_SEARCH_LIMIT = 10
DEFAULT_MIN_SIMILARITY = 0.7
MAX_SEARCH_LIMIT = 100
EMBEDDING_DIMENSION = 1536


logger = get_logger(__name__)


class LongTermMemory(LongTermMemoryInterface):
    """
    PostgreSQL + pgvector based long-term memory implementation.

    Stores semantic memories with vector embeddings for similarity search.
    Supports memory importance scoring and access tracking for memory
    consolidation patterns similar to human memory.

    Architecture (from ARCHITECTURE.md 4.3):
        ```
        ┌──────────────────────────────────────┐
        │          Long-term Memory            │
        │          (PostgreSQL + pgvector)     │
        ├──────────────────────────────────────┤
        │  - 历史总结 (Historical summaries)    │
        │  - 用户偏好 (User preferences)        │
        │  - 知识库 (Knowledge base)            │
        └──────────────────────────────────────┘
        ```

    Example:
        ```python
        from src.memory.embedding import EmbeddingService, OpenAIEmbeddingProvider

        embedding_service = EmbeddingService(
            provider=OpenAIEmbeddingProvider(api_key="sk-...")
        )

        memory = LongTermMemory(
            database_url="postgresql://user:pass@localhost/semibot",
            embedding_service=embedding_service,
        )

        # Save memory
        entry_id = await memory.save(
            agent_id="agent_123",
            content="User prefers Celsius for temperature",
            importance=0.8,
            metadata={"type": "preference"},
        )

        # Search by semantic similarity
        results = await memory.search(
            agent_id="agent_123",
            query="temperature units preference",
            limit=5,
        )

        for result in results:
            print(f"Score: {result.score}, Content: {result.content}")
        ```
    """

    def __init__(
        self,
        database_url: str,
        embedding_service: EmbeddingService,
        org_id: str | None = None,
    ):
        """
        Initialize long-term memory.

        Args:
            database_url: PostgreSQL connection URL
            embedding_service: Service for generating embeddings
            org_id: Default organization ID (optional)
        """
        self.database_url = database_url
        self.embedding_service = embedding_service
        self.org_id = org_id
        self._pool: asyncpg.Pool | None = None

    async def _get_pool(self) -> asyncpg.Pool:
        """Get or create connection pool."""
        if self._pool is None:
            self._pool = await asyncpg.create_pool(
                self.database_url,
                min_size=2,
                max_size=10,
            )
        return self._pool

    async def close(self) -> None:
        """Close the database connection pool."""
        if self._pool:
            await self._pool.close()
            self._pool = None

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
        """
        Save a memory entry with vector embedding.

        Args:
            agent_id: Agent identifier
            content: Content to store
            importance: Importance score (0-1)
            metadata: Optional metadata
            memory_type: Type of memory (episodic/semantic/procedural)
            user_id: Optional user identifier
            session_id: Optional session identifier
            org_id: Optional organization identifier

        Returns:
            Generated entry ID
        """
        pool = await self._get_pool()

        # Generate embedding
        embedding_result = await self.embedding_service.embed(content)
        embedding = embedding_result.embedding

        # Validate importance is within bounds
        importance = max(0.0, min(1.0, importance))

        entry_id = str(uuid.uuid4())
        effective_org_id = org_id or self.org_id or str(uuid.uuid4())

        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO memories (
                    id, org_id, agent_id, session_id, user_id,
                    content, embedding, memory_type, importance,
                    metadata, created_at
                ) VALUES (
                    $1, $2, $3, $4, $5,
                    $6, $7, $8, $9,
                    $10, $11
                )
                """,
                uuid.UUID(entry_id),
                uuid.UUID(effective_org_id),
                uuid.UUID(agent_id),
                uuid.UUID(session_id) if session_id else None,
                uuid.UUID(user_id) if user_id else None,
                content,
                embedding,
                memory_type,
                importance,
                metadata or {},
                datetime.now(timezone.utc),
            )

        logger.info(
            "long_term_memory_saved",
            entry_id=entry_id,
            agent_id=agent_id,
            memory_type=memory_type,
            importance=importance,
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
    ) -> list[MemorySearchResult]:
        """
        Search memory by semantic similarity.

        Args:
            agent_id: Agent identifier
            query: Search query
            limit: Maximum results
            min_importance: Minimum importance threshold
            min_similarity: Minimum similarity threshold
            memory_type: Optional filter by memory type

        Returns:
            List of MemorySearchResult ordered by similarity
        """
        # Enforce limit bounds
        if limit > MAX_SEARCH_LIMIT:
            logger.warning(
                "search_limit_exceeded",
                requested_limit=limit,
                max_limit=MAX_SEARCH_LIMIT,
            )
            limit = MAX_SEARCH_LIMIT

        pool = await self._get_pool()

        # Generate query embedding
        embedding_result = await self.embedding_service.embed(query)
        query_embedding = embedding_result.embedding

        async with pool.acquire() as conn:
            # Build query with optional memory_type filter
            base_query = """
                SELECT
                    id, content, memory_type, importance, metadata, created_at,
                    1 - (embedding <=> $1::vector) as similarity
                FROM memories
                WHERE agent_id = $2
                    AND (expires_at IS NULL OR expires_at > NOW())
                    AND importance >= $3
                    AND 1 - (embedding <=> $1::vector) >= $4
            """

            if memory_type:
                base_query += " AND memory_type = $6"
                base_query += " ORDER BY embedding <=> $1::vector LIMIT $5"
                rows = await conn.fetch(
                    base_query,
                    query_embedding,
                    uuid.UUID(agent_id),
                    min_importance,
                    min_similarity,
                    limit,
                    memory_type,
                )
            else:
                base_query += " ORDER BY embedding <=> $1::vector LIMIT $5"
                rows = await conn.fetch(
                    base_query,
                    query_embedding,
                    uuid.UUID(agent_id),
                    min_importance,
                    min_similarity,
                    limit,
                )

        results = []
        for row in rows:
            entry = MemoryEntry(
                id=str(row["id"]),
                content=row["content"],
                agent_id=agent_id,
                importance=row["importance"],
                metadata=row["metadata"] or {},
                created_at=row["created_at"],
            )

            # Update access count asynchronously
            await self._update_access(str(row["id"]))

            results.append(
                MemorySearchResult(
                    entry=entry,
                    score=float(row["similarity"]),
                    distance=1 - float(row["similarity"]),
                )
            )

        logger.debug(
            "long_term_memory_search",
            agent_id=agent_id,
            query_length=len(query),
            results_count=len(results),
            limit=limit,
        )

        return results

    async def _update_access(self, entry_id: str) -> None:
        """Update access count and last accessed time."""
        pool = await self._get_pool()

        try:
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE memories
                    SET access_count = access_count + 1,
                        last_accessed_at = NOW()
                    WHERE id = $1
                    """,
                    uuid.UUID(entry_id),
                )
        except Exception as e:
            # Non-critical operation, just log warning
            logger.warning(
                "memory_access_update_failed",
                entry_id=entry_id,
                error=str(e),
            )

    async def delete(self, entry_id: str) -> bool:
        """
        Delete a memory entry.

        Args:
            entry_id: Entry identifier

        Returns:
            True if deleted successfully
        """
        pool = await self._get_pool()

        async with pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM memories WHERE id = $1",
                uuid.UUID(entry_id),
            )

        deleted = result == "DELETE 1"

        if deleted:
            logger.info("long_term_memory_deleted", entry_id=entry_id)
        else:
            logger.warning("long_term_memory_delete_not_found", entry_id=entry_id)

        return deleted

    async def get(self, entry_id: str) -> MemoryEntry | None:
        """
        Get a specific memory entry.

        Args:
            entry_id: Entry identifier

        Returns:
            MemoryEntry if found, None otherwise
        """
        pool = await self._get_pool()

        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT id, agent_id, session_id, content, importance,
                       metadata, created_at, expires_at
                FROM memories
                WHERE id = $1
                """,
                uuid.UUID(entry_id),
            )

        if not row:
            return None

        return MemoryEntry(
            id=str(row["id"]),
            content=row["content"],
            agent_id=str(row["agent_id"]),
            session_id=str(row["session_id"]) if row["session_id"] else None,
            importance=row["importance"],
            metadata=row["metadata"] or {},
            created_at=row["created_at"],
            expires_at=row["expires_at"],
        )

    async def update_importance(
        self,
        entry_id: str,
        importance: float,
    ) -> bool:
        """
        Update the importance score of a memory entry.

        Args:
            entry_id: Entry identifier
            importance: New importance score (0-1)

        Returns:
            True if updated successfully
        """
        importance = max(0.0, min(1.0, importance))

        pool = await self._get_pool()

        async with pool.acquire() as conn:
            result = await conn.execute(
                """
                UPDATE memories
                SET importance = $2
                WHERE id = $1
                """,
                uuid.UUID(entry_id),
                importance,
            )

        return result == "UPDATE 1"

    async def get_by_agent(
        self,
        agent_id: str,
        limit: int = DEFAULT_SEARCH_LIMIT,
        memory_type: str | None = None,
    ) -> list[MemoryEntry]:
        """
        Get memories for an agent without semantic search.

        Args:
            agent_id: Agent identifier
            limit: Maximum results
            memory_type: Optional filter by memory type

        Returns:
            List of MemoryEntry ordered by importance and recency
        """
        if limit > MAX_SEARCH_LIMIT:
            logger.warning(
                "get_by_agent_limit_exceeded",
                requested_limit=limit,
                max_limit=MAX_SEARCH_LIMIT,
            )
            limit = MAX_SEARCH_LIMIT

        pool = await self._get_pool()

        async with pool.acquire() as conn:
            if memory_type:
                rows = await conn.fetch(
                    """
                    SELECT id, agent_id, session_id, content, importance,
                           metadata, created_at, expires_at
                    FROM memories
                    WHERE agent_id = $1
                        AND memory_type = $3
                        AND (expires_at IS NULL OR expires_at > NOW())
                    ORDER BY importance DESC, created_at DESC
                    LIMIT $2
                    """,
                    uuid.UUID(agent_id),
                    limit,
                    memory_type,
                )
            else:
                rows = await conn.fetch(
                    """
                    SELECT id, agent_id, session_id, content, importance,
                           metadata, created_at, expires_at
                    FROM memories
                    WHERE agent_id = $1
                        AND (expires_at IS NULL OR expires_at > NOW())
                    ORDER BY importance DESC, created_at DESC
                    LIMIT $2
                    """,
                    uuid.UUID(agent_id),
                    limit,
                )

        return [
            MemoryEntry(
                id=str(row["id"]),
                content=row["content"],
                agent_id=str(row["agent_id"]),
                session_id=str(row["session_id"]) if row["session_id"] else None,
                importance=row["importance"],
                metadata=row["metadata"] or {},
                created_at=row["created_at"],
                expires_at=row["expires_at"],
            )
            for row in rows
        ]

    async def health_check(self) -> bool:
        """
        Check if database connection is healthy.

        Returns:
            True if database is reachable
        """
        try:
            pool = await self._get_pool()
            async with pool.acquire() as conn:
                await conn.execute("SELECT 1")
            return True
        except Exception as e:
            logger.error("database_health_check_failed", error=str(e))
            return False
