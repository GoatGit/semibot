"""Base classes and interfaces for the Memory System."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


def _utc_now() -> datetime:
    """Get current UTC time (timezone-aware)."""
    return datetime.now(timezone.utc)


@dataclass
class MemoryEntry:
    """A single memory entry."""

    id: str
    content: str
    agent_id: str
    session_id: str | None = None
    importance: float = 0.5
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: datetime = field(default_factory=_utc_now)
    expires_at: datetime | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "id": self.id,
            "content": self.content,
            "agent_id": self.agent_id,
            "session_id": self.session_id,
            "importance": self.importance,
            "metadata": self.metadata,
            "created_at": self.created_at.isoformat(),
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MemoryEntry":
        """Create from dictionary."""
        return cls(
            id=data["id"],
            content=data["content"],
            agent_id=data["agent_id"],
            session_id=data.get("session_id"),
            importance=data.get("importance", 0.5),
            metadata=data.get("metadata", {}),
            created_at=datetime.fromisoformat(data["created_at"])
            if data.get("created_at")
            else datetime.now(timezone.utc),
            expires_at=datetime.fromisoformat(data["expires_at"])
            if data.get("expires_at")
            else None,
        )


@dataclass
class MemorySearchResult:
    """Result from a memory search."""

    entry: MemoryEntry
    score: float = 0.0
    distance: float = 0.0

    @property
    def content(self) -> str:
        """Get the content."""
        return self.entry.content


class MemorySystem:
    """
    Unified memory system combining short-term and long-term memory.

    Architecture (from ARCHITECTURE.md 4.3):
    ```
    ┌─────────────────────────────────────┐
    │           Memory System             │
    ├─────────────────────────────────────┤
    │  ┌─────────────┐  ┌──────────────┐  │
    │  │ Short-term  │  │  Long-term   │  │
    │  │  (Redis)    │  │  (pgvector)  │  │
    │  │             │  │              │  │
    │  │ - 当前对话   │  │ - 历史总结   │  │
    │  │ - 工具结果   │  │ - 用户偏好   │  │
    │  │ - 临时状态   │  │ - 知识库     │  │
    │  └─────────────┘  └──────────────┘  │
    └─────────────────────────────────────┘
    ```

    Example:
        ```python
        from src.memory import MemorySystem
        from src.memory.short_term import ShortTermMemory
        from src.memory.long_term import LongTermMemory

        memory = MemorySystem(
            short_term=ShortTermMemory(redis_url="redis://localhost:6379"),
            long_term=LongTermMemory(database_url="postgresql://..."),
        )

        # Store short-term memory
        await memory.save_short_term(
            session_id="sess_123",
            content="User asked about weather",
        )

        # Retrieve short-term context
        context = await memory.get_short_term("sess_123")

        # Search long-term memory
        results = await memory.search_long_term(
            agent_id="agent_456",
            query="weather preferences",
            limit=5,
        )

        # Save to long-term memory
        await memory.save_long_term(
            agent_id="agent_456",
            content="User prefers Celsius for temperature",
            importance=0.8,
        )
        ```
    """

    def __init__(
        self,
        short_term: "ShortTermMemoryInterface | None" = None,
        long_term: "LongTermMemoryInterface | None" = None,
    ):
        """
        Initialize the memory system.

        Args:
            short_term: Short-term memory implementation
            long_term: Long-term memory implementation
        """
        self.short_term = short_term
        self.long_term = long_term

    async def get_short_term(self, session_id: str) -> str:
        """
        Get short-term memory for a session.

        Args:
            session_id: Session identifier

        Returns:
            Concatenated memory context string
        """
        if not self.short_term:
            return ""

        entries = await self.short_term.get_session_context(session_id)
        if not entries:
            return ""

        return "\n".join(e.content for e in entries)

    async def save_short_term(
        self,
        session_id: str,
        content: str,
        agent_id: str = "",
        metadata: dict[str, Any] | None = None,
        ttl_seconds: int = 3600,
    ) -> None:
        """
        Save to short-term memory.

        Args:
            session_id: Session identifier
            content: Content to store
            agent_id: Agent identifier
            metadata: Optional metadata
            ttl_seconds: Time-to-live in seconds
        """
        if not self.short_term:
            return

        await self.short_term.save(
            session_id=session_id,
            content=content,
            agent_id=agent_id,
            metadata=metadata,
            ttl_seconds=ttl_seconds,
        )

    async def search_long_term(
        self,
        agent_id: str,
        query: str,
        limit: int = 5,
        min_importance: float = 0.0,
        org_id: str | None = None,
    ) -> str:
        """
        Search long-term memory.

        Args:
            agent_id: Agent identifier
            query: Search query
            limit: Maximum results
            min_importance: Minimum importance threshold
            org_id: Organization identifier for tenant isolation

        Returns:
            Concatenated relevant memory context
        """
        if not self.long_term:
            return ""

        results = await self.long_term.search(
            agent_id=agent_id,
            query=query,
            limit=limit,
            min_importance=min_importance,
            org_id=org_id,
        )

        if not results:
            return ""

        return "\n".join(r.content for r in results)

    async def save_long_term(
        self,
        agent_id: str,
        content: str,
        importance: float = 0.5,
        metadata: dict[str, Any] | None = None,
        org_id: str | None = None,
    ) -> str:
        """
        Save to long-term memory.

        Args:
            agent_id: Agent identifier
            content: Content to store
            importance: Importance score (0-1)
            metadata: Optional metadata
            org_id: Organization identifier for tenant isolation

        Returns:
            Memory entry ID
        """
        if not self.long_term:
            return ""

        return await self.long_term.save(
            agent_id=agent_id,
            content=content,
            importance=importance,
            metadata=metadata,
            org_id=org_id,
        )

    async def clear_session(self, session_id: str) -> None:
        """
        Clear all short-term memory for a session.

        Args:
            session_id: Session identifier
        """
        if self.short_term:
            await self.short_term.clear_session(session_id)

    async def delete_long_term(self, entry_id: str) -> bool:
        """
        Delete a long-term memory entry.

        Args:
            entry_id: Entry identifier

        Returns:
            True if deleted successfully
        """
        if not self.long_term:
            return False

        return await self.long_term.delete(entry_id)


class ShortTermMemoryInterface(ABC):
    """Interface for short-term memory implementations."""

    @abstractmethod
    async def save(
        self,
        session_id: str,
        content: str,
        agent_id: str = "",
        metadata: dict[str, Any] | None = None,
        ttl_seconds: int = 3600,
    ) -> str:
        """Save a memory entry."""
        pass

    @abstractmethod
    async def get_session_context(
        self,
        session_id: str,
        limit: int = 50,
    ) -> list[MemoryEntry]:
        """Get all memory entries for a session."""
        pass

    @abstractmethod
    async def clear_session(self, session_id: str) -> None:
        """Clear all entries for a session."""
        pass


class LongTermMemoryInterface(ABC):
    """Interface for long-term memory implementations."""

    @abstractmethod
    async def save(
        self,
        agent_id: str,
        content: str,
        importance: float = 0.5,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """Save a memory entry."""
        pass

    @abstractmethod
    async def search(
        self,
        agent_id: str,
        query: str,
        limit: int = 5,
        min_importance: float = 0.0,
        org_id: str | None = None,
    ) -> list[MemorySearchResult]:
        """Search memory by semantic similarity with tenant isolation."""
        pass

    @abstractmethod
    async def delete(self, entry_id: str) -> bool:
        """Delete a memory entry."""
        pass

    @abstractmethod
    async def get(self, entry_id: str) -> MemoryEntry | None:
        """Get a specific memory entry."""
        pass
