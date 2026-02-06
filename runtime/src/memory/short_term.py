"""Short-term memory implementation using Redis.

Provides fast, session-scoped memory storage with automatic TTL expiration.
Used for:
- Current conversation context
- Tool execution results
- Temporary state during agent execution
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

import redis.asyncio as redis
from tenacity import retry, stop_after_attempt, wait_exponential

from src.constants import (
    DEFAULT_TTL_SECONDS,
    MAX_SESSION_ENTRIES,
    REDIS_KEY_PREFIX,
    REDIS_MAX_RETRIES,
    REDIS_RETRY_DELAY_BASE,
    REDIS_RETRY_DELAY_MAX,
)
from src.memory.base import MemoryEntry, ShortTermMemoryInterface
from src.utils.logging import get_logger
from src.utils.validation import (
    InvalidInputError,
    MemoryConnectionError,
    validate_content,
    validate_positive_int,
)


logger = get_logger(__name__)

# Lua script for atomic add and trim operation
# This ensures no race condition when checking and trimming entries
TRIM_AND_ADD_SCRIPT = """
local key = KEYS[1]
local max_entries = tonumber(ARGV[1])
local entry_json = ARGV[2]
local timestamp = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

-- Add new entry
redis.call('ZADD', key, timestamp, entry_json)

-- Check and trim if needed
local count = redis.call('ZCARD', key)
local trimmed = 0
if count > max_entries then
    trimmed = count - max_entries
    redis.call('ZREMRANGEBYRANK', key, 0, trimmed - 1)
end

-- Set TTL
redis.call('EXPIRE', key, ttl)

return trimmed
"""


class ShortTermMemory(ShortTermMemoryInterface):
    """
    Redis-based short-term memory implementation.

    Stores session-scoped memory entries with automatic TTL expiration.
    Uses Redis sorted sets for ordered retrieval by timestamp.

    Architecture:
        - Key pattern: semibot:memory:short_term:{session_id}
        - Value: JSON-encoded MemoryEntry
        - Score: Unix timestamp for ordering

    Example:
        ```python
        memory = ShortTermMemory(redis_url="redis://localhost:6379")

        # Save memory entry
        entry_id = await memory.save(
            session_id="sess_123",
            content="User asked about weather",
            agent_id="agent_456",
            ttl_seconds=3600,
        )

        # Get session context
        entries = await memory.get_session_context("sess_123")

        # Clear session
        await memory.clear_session("sess_123")
        ```
    """

    def __init__(
        self,
        redis_url: str = "redis://localhost:6379",
        key_prefix: str = REDIS_KEY_PREFIX,
        default_ttl: int = DEFAULT_TTL_SECONDS,
    ):
        """
        Initialize short-term memory.

        Args:
            redis_url: Redis connection URL
            key_prefix: Prefix for Redis keys
            default_ttl: Default TTL in seconds
        """
        self.redis_url = redis_url
        self.key_prefix = key_prefix
        self.default_ttl = default_ttl
        self._client: redis.Redis | None = None

    async def __aenter__(self) -> "ShortTermMemory":
        """Async context manager entry."""
        await self._get_client()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        """Async context manager exit."""
        await self.close()

    @retry(
        stop=stop_after_attempt(REDIS_MAX_RETRIES),
        wait=wait_exponential(
            multiplier=1, min=REDIS_RETRY_DELAY_BASE, max=REDIS_RETRY_DELAY_MAX
        ),
        reraise=True,
    )
    async def _get_client(self) -> redis.Redis:
        """Get or create Redis client with retry logic."""
        if self._client is None:
            try:
                self._client = redis.from_url(
                    self.redis_url,
                    encoding="utf-8",
                    decode_responses=True,
                )
                # Test connection
                await self._client.ping()
            except Exception as e:
                logger.error(
                    "redis_connection_failed",
                    redis_url=self.redis_url,
                    error=str(e),
                )
                self._client = None
                raise MemoryConnectionError(
                    f"Failed to connect to Redis: {e}"
                ) from e
        return self._client

    async def close(self) -> None:
        """Close the Redis connection."""
        if self._client:
            await self._client.aclose()
            self._client = None

    def _session_key(self, session_id: str) -> str:
        """Generate Redis key for a session."""
        return f"{self.key_prefix}:{session_id}"

    def _entry_key(self, session_id: str, entry_id: str) -> str:
        """Generate Redis key for an entry."""
        return f"{self.key_prefix}:{session_id}:entry:{entry_id}"

    async def save(
        self,
        session_id: str,
        content: str,
        agent_id: str = "",
        metadata: dict[str, Any] | None = None,
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
    ) -> str:
        """
        Save a memory entry.

        Args:
            session_id: Session identifier
            content: Content to store
            agent_id: Agent identifier
            metadata: Optional metadata
            ttl_seconds: Time-to-live in seconds

        Returns:
            Generated entry ID

        Raises:
            InvalidInputError: If session_id is empty or content is empty
        """
        # Input validation
        if not session_id or not session_id.strip():
            raise InvalidInputError("session_id cannot be empty")
        content = validate_content(content, min_length=1)
        ttl_seconds = validate_positive_int(
            ttl_seconds, "ttl_seconds", DEFAULT_TTL_SECONDS
        )

        client = await self._get_client()
        entry_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc)

        entry = MemoryEntry(
            id=entry_id,
            content=content,
            agent_id=agent_id,
            session_id=session_id,
            metadata=metadata or {},
            created_at=now,
        )

        session_key = self._session_key(session_id)
        entry_json = json.dumps(entry.to_dict())
        timestamp = now.timestamp()

        # Use Lua script for atomic add and trim operation
        # This prevents race conditions when multiple concurrent writes happen
        trimmed = await client.eval(
            TRIM_AND_ADD_SCRIPT,
            1,  # Number of keys
            session_key,
            MAX_SESSION_ENTRIES,
            entry_json,
            timestamp,
            ttl_seconds,
        )

        if trimmed > 0:
            logger.warning(
                "session_entries_trimmed",
                session_id=session_id,
                trimmed_count=trimmed,
                limit=MAX_SESSION_ENTRIES,
            )

        logger.debug(
            "short_term_memory_saved",
            session_id=session_id,
            entry_id=entry_id,
            content_length=len(content),
            ttl_seconds=ttl_seconds,
        )

        return entry_id

    async def get_session_context(
        self,
        session_id: str,
        limit: int = 50,
    ) -> list[MemoryEntry]:
        """
        Get all memory entries for a session.

        Args:
            session_id: Session identifier
            limit: Maximum number of entries to return

        Returns:
            List of MemoryEntry objects, ordered by creation time
        """
        client = await self._get_client()
        session_key = self._session_key(session_id)

        # Get entries ordered by timestamp (most recent last)
        entries_json = await client.zrange(session_key, -limit, -1)

        entries = []
        for entry_json in entries_json:
            try:
                data = json.loads(entry_json)
                entries.append(MemoryEntry.from_dict(data))
            except (json.JSONDecodeError, KeyError) as e:
                logger.warning(
                    "short_term_memory_parse_error",
                    session_id=session_id,
                    error=str(e),
                )
                continue

        return entries

    async def clear_session(self, session_id: str) -> None:
        """
        Clear all entries for a session.

        Args:
            session_id: Session identifier
        """
        client = await self._get_client()
        session_key = self._session_key(session_id)

        deleted = await client.delete(session_key)

        logger.info(
            "short_term_memory_cleared",
            session_id=session_id,
            keys_deleted=deleted,
        )

    async def get_entry(
        self,
        session_id: str,
        entry_id: str,
    ) -> MemoryEntry | None:
        """
        Get a specific entry by ID.

        Args:
            session_id: Session identifier
            entry_id: Entry identifier

        Returns:
            MemoryEntry if found, None otherwise
        """
        # Search through session entries
        entries = await self.get_session_context(session_id, limit=MAX_SESSION_ENTRIES)
        for entry in entries:
            if entry.id == entry_id:
                return entry
        return None

    async def update_ttl(
        self,
        session_id: str,
        ttl_seconds: int,
    ) -> bool:
        """
        Update TTL for a session.

        Args:
            session_id: Session identifier
            ttl_seconds: New TTL in seconds

        Returns:
            True if successful
        """
        client = await self._get_client()
        session_key = self._session_key(session_id)

        result = await client.expire(session_key, ttl_seconds)
        return bool(result)

    async def get_session_count(self, session_id: str) -> int:
        """
        Get the number of entries in a session.

        Args:
            session_id: Session identifier

        Returns:
            Number of entries
        """
        client = await self._get_client()
        session_key = self._session_key(session_id)

        return await client.zcard(session_key)

    async def health_check(self) -> bool:
        """
        Check if Redis connection is healthy.

        Returns:
            True if Redis is reachable
        """
        try:
            client = await self._get_client()
            await client.ping()
            return True
        except Exception as e:
            logger.error("redis_health_check_failed", error=str(e))
            return False
