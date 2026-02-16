"""Long-term memory implementation using PostgreSQL with pgvector.

Provides persistent, semantic memory storage with vector similarity search.
Used for:
- Historical conversation summaries
- User preferences and patterns
- Knowledge base entries
- Agent learned experiences
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Any

import asyncpg
from pgvector.asyncpg import register_vector
from tenacity import retry, stop_after_attempt, wait_exponential

from src.constants import (
    DEFAULT_MIN_SIMILARITY,
    DEFAULT_SEARCH_LIMIT,
    EMBEDDING_DIMENSION,
    MAX_SEARCH_LIMIT,
    PG_MAX_RETRIES,
    PG_POOL_ACQUIRE_TIMEOUT,
    PG_POOL_MAX_SIZE,
    PG_POOL_MIN_SIZE,
    PG_RETRY_DELAY_BASE,
    PG_RETRY_DELAY_MAX,
)
from src.memory.base import LongTermMemoryInterface, MemoryEntry, MemorySearchResult
from src.memory.embedding import EmbeddingService
from src.utils.logging import get_logger
from src.utils.validation import (
    InvalidInputError,
    MemoryConnectionError,
    validate_content,
    validate_float_range,
    validate_positive_int,
    validate_uuid,
    validate_uuid_optional,
)


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

    async def __aenter__(self) -> "LongTermMemory":
        """Async context manager entry."""
        await self._get_pool()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        """Async context manager exit."""
        await self.close()

    @retry(
        stop=stop_after_attempt(PG_MAX_RETRIES),
        wait=wait_exponential(
            multiplier=1, min=PG_RETRY_DELAY_BASE, max=PG_RETRY_DELAY_MAX
        ),
        reraise=True,
    )
    async def _get_pool(self) -> asyncpg.Pool:
        """Get or create connection pool with retry logic."""
        if self._pool is None:
            try:
                async def _init_connection(conn):
                    await register_vector(conn)

                self._pool = await asyncpg.create_pool(
                    self.database_url,
                    min_size=PG_POOL_MIN_SIZE,
                    max_size=PG_POOL_MAX_SIZE,
                    command_timeout=PG_POOL_ACQUIRE_TIMEOUT,
                    init=_init_connection,
                )
                logger.info(
                    "database_pool_created",
                    min_size=PG_POOL_MIN_SIZE,
                    max_size=PG_POOL_MAX_SIZE,
                )
            except Exception as e:
                logger.error(
                    "database_pool_creation_failed",
                    error=str(e),
                )
                raise MemoryConnectionError(
                    f"Failed to create database connection pool: {e}"
                ) from e
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

        Raises:
            InvalidInputError: If agent_id is invalid or content is empty
        """
        # Input validation
        content = validate_content(content, min_length=1)
        agent_uuid = validate_uuid(agent_id, "agent_id")
        session_uuid = validate_uuid_optional(session_id, "session_id")
        user_uuid = validate_uuid_optional(user_id, "user_id")
        importance = validate_float_range(importance, "importance", 0.0, 1.0, 0.5)

        pool = await self._get_pool()

        # Generate embedding
        embedding_result = await self.embedding_service.embed(content)
        embedding = embedding_result.embedding

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
                    $10::jsonb, $11
                )
                """,
                uuid.UUID(entry_id),
                validate_uuid(effective_org_id, "org_id"),
                agent_uuid,
                session_uuid,
                user_uuid,
                content,
                embedding,
                memory_type,
                importance,
                json.dumps(metadata or {}),
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
        org_id: str | None = None,
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
            org_id: Organization identifier for tenant isolation

        Returns:
            List of MemorySearchResult ordered by similarity

        Raises:
            InvalidInputError: If agent_id is invalid or query is empty
        """
        # Input validation
        agent_uuid = validate_uuid(agent_id, "agent_id")
        query = validate_content(query, min_length=1)
        limit = validate_positive_int(limit, "limit", DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT)

        # Tenant isolation: use provided org_id or instance default
        effective_org_id = org_id or self.org_id
        if not effective_org_id:
            logger.warning(
                "search_without_org_id",
                agent_id=agent_id,
                message="Searching without org_id may expose cross-tenant data",
            )

        pool = await self._get_pool()

        # Generate query embedding
        embedding_result = await self.embedding_service.embed(query)
        query_embedding = embedding_result.embedding

        async with pool.acquire() as conn:
            # Build query with org_id filter for tenant isolation
            if effective_org_id:
                org_uuid = validate_uuid(effective_org_id, "org_id")
                if memory_type:
                    rows = await conn.fetch(
                        """
                        SELECT
                            id, content, memory_type, importance, metadata, created_at,
                            1 - (embedding <=> $1::vector) as similarity
                        FROM memories
                        WHERE org_id = $2
                            AND agent_id = $3
                            AND (expires_at IS NULL OR expires_at > NOW())
                            AND importance >= $4
                            AND 1 - (embedding <=> $1::vector) >= $5
                            AND memory_type = $7
                        ORDER BY embedding <=> $1::vector
                        LIMIT $6
                        """,
                        query_embedding,
                        org_uuid,
                        agent_uuid,
                        min_importance,
                        min_similarity,
                        limit,
                        memory_type,
                    )
                else:
                    rows = await conn.fetch(
                        """
                        SELECT
                            id, content, memory_type, importance, metadata, created_at,
                            1 - (embedding <=> $1::vector) as similarity
                        FROM memories
                        WHERE org_id = $2
                            AND agent_id = $3
                            AND (expires_at IS NULL OR expires_at > NOW())
                            AND importance >= $4
                            AND 1 - (embedding <=> $1::vector) >= $5
                        ORDER BY embedding <=> $1::vector
                        LIMIT $6
                        """,
                        query_embedding,
                        org_uuid,
                        agent_uuid,
                        min_importance,
                        min_similarity,
                        limit,
                    )
            else:
                # Fallback without org_id (security warning already logged)
                if memory_type:
                    rows = await conn.fetch(
                        """
                        SELECT
                            id, content, memory_type, importance, metadata, created_at,
                            1 - (embedding <=> $1::vector) as similarity
                        FROM memories
                        WHERE agent_id = $2
                            AND (expires_at IS NULL OR expires_at > NOW())
                            AND importance >= $3
                            AND 1 - (embedding <=> $1::vector) >= $4
                            AND memory_type = $6
                        ORDER BY embedding <=> $1::vector
                        LIMIT $5
                        """,
                        query_embedding,
                        agent_uuid,
                        min_importance,
                        min_similarity,
                        limit,
                        memory_type,
                    )
                else:
                    rows = await conn.fetch(
                        """
                        SELECT
                            id, content, memory_type, importance, metadata, created_at,
                            1 - (embedding <=> $1::vector) as similarity
                        FROM memories
                        WHERE agent_id = $2
                            AND (expires_at IS NULL OR expires_at > NOW())
                            AND importance >= $3
                            AND 1 - (embedding <=> $1::vector) >= $4
                        ORDER BY embedding <=> $1::vector
                        LIMIT $5
                        """,
                        query_embedding,
                        agent_uuid,
                        min_importance,
                        min_similarity,
                        limit,
                    )

        results = []
        update_tasks = []

        for row in rows:
            entry = MemoryEntry(
                id=str(row["id"]),
                content=row["content"],
                agent_id=agent_id,
                importance=row["importance"],
                metadata=row["metadata"] or {},
                created_at=row["created_at"],
            )

            # Collect update tasks for parallel execution
            update_tasks.append(self._update_access(str(row["id"])))

            results.append(
                MemorySearchResult(
                    entry=entry,
                    score=float(row["similarity"]),
                    distance=1 - float(row["similarity"]),
                )
            )

        # Update access counts in parallel
        if update_tasks:
            await asyncio.gather(*update_tasks, return_exceptions=True)

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
            entry_uuid = validate_uuid(entry_id, "entry_id")
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE memories
                    SET access_count = access_count + 1,
                        last_accessed_at = NOW()
                    WHERE id = $1
                    """,
                    entry_uuid,
                )
        except InvalidInputError as e:
            logger.warning(
                "memory_access_update_invalid_id",
                entry_id=entry_id,
                error=str(e),
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

        Raises:
            InvalidInputError: If entry_id is invalid
        """
        entry_uuid = validate_uuid(entry_id, "entry_id")
        pool = await self._get_pool()

        async with pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM memories WHERE id = $1",
                entry_uuid,
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

        Raises:
            InvalidInputError: If entry_id is invalid
        """
        entry_uuid = validate_uuid(entry_id, "entry_id")
        pool = await self._get_pool()

        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT id, agent_id, session_id, content, importance,
                       metadata, created_at, expires_at
                FROM memories
                WHERE id = $1
                """,
                entry_uuid,
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

        Raises:
            InvalidInputError: If entry_id is invalid
        """
        entry_uuid = validate_uuid(entry_id, "entry_id")
        importance = validate_float_range(importance, "importance", 0.0, 1.0, 0.5)

        pool = await self._get_pool()

        async with pool.acquire() as conn:
            result = await conn.execute(
                """
                UPDATE memories
                SET importance = $2
                WHERE id = $1
                """,
                entry_uuid,
                importance,
            )

        return result == "UPDATE 1"

    async def get_by_agent(
        self,
        agent_id: str,
        limit: int = DEFAULT_SEARCH_LIMIT,
        memory_type: str | None = None,
        org_id: str | None = None,
    ) -> list[MemoryEntry]:
        """
        Get memories for an agent without semantic search.

        Args:
            agent_id: Agent identifier
            limit: Maximum results
            memory_type: Optional filter by memory type
            org_id: Organization identifier for tenant isolation

        Returns:
            List of MemoryEntry ordered by importance and recency

        Raises:
            InvalidInputError: If agent_id is invalid
        """
        agent_uuid = validate_uuid(agent_id, "agent_id")
        limit = validate_positive_int(limit, "limit", DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT)

        # Tenant isolation: use provided org_id or instance default
        effective_org_id = org_id or self.org_id
        if not effective_org_id:
            logger.warning(
                "get_by_agent_without_org_id",
                agent_id=agent_id,
                message="Querying without org_id may expose cross-tenant data",
            )

        pool = await self._get_pool()

        async with pool.acquire() as conn:
            if effective_org_id:
                org_uuid = validate_uuid(effective_org_id, "org_id")
                if memory_type:
                    rows = await conn.fetch(
                        """
                        SELECT id, agent_id, session_id, content, importance,
                               metadata, created_at, expires_at
                        FROM memories
                        WHERE org_id = $1
                            AND agent_id = $2
                            AND memory_type = $4
                            AND (expires_at IS NULL OR expires_at > NOW())
                        ORDER BY importance DESC, created_at DESC
                        LIMIT $3
                        """,
                        org_uuid,
                        agent_uuid,
                        limit,
                        memory_type,
                    )
                else:
                    rows = await conn.fetch(
                        """
                        SELECT id, agent_id, session_id, content, importance,
                               metadata, created_at, expires_at
                        FROM memories
                        WHERE org_id = $1
                            AND agent_id = $2
                            AND (expires_at IS NULL OR expires_at > NOW())
                        ORDER BY importance DESC, created_at DESC
                        LIMIT $3
                        """,
                        org_uuid,
                        agent_uuid,
                        limit,
                    )
            else:
                # Fallback without org_id (security warning already logged)
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
                        agent_uuid,
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
                        agent_uuid,
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
