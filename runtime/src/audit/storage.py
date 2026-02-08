"""Audit storage interfaces and implementations."""

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any

from src.audit.models import AuditEvent, AuditQuery
from src.utils.logging import get_logger

logger = get_logger(__name__)


class AuditStorage(ABC):
    """
    Abstract base class for audit storage.

    Implementations can store audit events in different backends:
    - In-memory (for testing)
    - Database (PostgreSQL, etc.)
    - File system
    - External audit service
    """

    @abstractmethod
    async def store(self, event: AuditEvent) -> None:
        """
        Store a single audit event.

        Args:
            event: Audit event to store
        """
        pass

    @abstractmethod
    async def store_batch(self, events: list[AuditEvent]) -> None:
        """
        Store multiple audit events in a batch.

        Args:
            events: List of audit events to store
        """
        pass

    @abstractmethod
    async def query(self, query: AuditQuery) -> list[AuditEvent]:
        """
        Query audit events.

        Args:
            query: Query parameters

        Returns:
            List of matching audit events
        """
        pass

    @abstractmethod
    async def count(self, query: AuditQuery) -> int:
        """
        Count audit events matching query.

        Args:
            query: Query parameters

        Returns:
            Number of matching events
        """
        pass

    @abstractmethod
    async def delete_old_events(self, before: datetime) -> int:
        """
        Delete audit events older than specified date.

        Args:
            before: Delete events before this timestamp

        Returns:
            Number of deleted events
        """
        pass


class InMemoryAuditStorage(AuditStorage):
    """
    In-memory audit storage implementation.

    This is primarily for testing and development.
    Events are stored in memory and lost when the process exits.
    """

    def __init__(self):
        """Initialize in-memory storage."""
        self._events: list[AuditEvent] = []

    async def store(self, event: AuditEvent) -> None:
        """Store a single audit event."""
        self._events.append(event)
        logger.debug(
            f"Stored audit event: {event.event_type.value}",
            extra={
                "event_id": event.event_id,
                "session_id": event.session_id,
            },
        )

    async def store_batch(self, events: list[AuditEvent]) -> None:
        """Store multiple audit events in a batch."""
        self._events.extend(events)
        logger.debug(
            f"Stored {len(events)} audit events in batch",
            extra={"event_count": len(events)},
        )

    async def query(self, query: AuditQuery) -> list[AuditEvent]:
        """Query audit events."""
        # 强制要求 org_id 以确保多租户隔离
        if not query.org_id:
            logger.error("[Security] 审计查询缺少 org_id，拒绝执行")
            raise ValueError("org_id is required for audit queries")

        results = self._events

        # Filter by org_id
        results = [e for e in results if e.org_id == query.org_id]

        # Filter by user_id
        if query.user_id:
            results = [e for e in results if e.user_id == query.user_id]

        # Filter by agent_id
        if query.agent_id:
            results = [e for e in results if e.agent_id == query.agent_id]

        # Filter by session_id
        if query.session_id:
            results = [e for e in results if e.session_id == query.session_id]

        # Filter by event_types
        if query.event_types:
            results = [e for e in results if e.event_type in query.event_types]

        # Filter by severity
        if query.severity:
            results = [e for e in results if e.severity == query.severity]

        # Filter by start_time
        if query.start_time:
            results = [e for e in results if e.timestamp >= query.start_time]

        # Filter by end_time
        if query.end_time:
            results = [e for e in results if e.timestamp <= query.end_time]

        # Filter by action_name
        if query.action_name:
            results = [e for e in results if e.action_name == query.action_name]

        # Filter by success
        if query.success is not None:
            results = [e for e in results if e.success == query.success]

        # Sort by timestamp (newest first)
        results = sorted(results, key=lambda e: e.timestamp, reverse=True)

        # Apply pagination
        start = query.offset
        end = start + query.limit
        results = results[start:end]

        return results

    async def count(self, query: AuditQuery) -> int:
        """Count audit events matching query."""
        # 强制要求 org_id 以确保多租户隔离
        if not query.org_id:
            logger.error("[Security] 审计查询缺少 org_id，拒绝执行")
            raise ValueError("org_id is required for audit queries")

        # Use query method but without pagination
        query_copy = AuditQuery(
            org_id=query.org_id,
            user_id=query.user_id,
            agent_id=query.agent_id,
            session_id=query.session_id,
            event_types=query.event_types,
            severity=query.severity,
            start_time=query.start_time,
            end_time=query.end_time,
            action_name=query.action_name,
            success=query.success,
            limit=999999,  # No limit for counting
            offset=0,
        )
        results = await self.query(query_copy)
        return len(results)

    async def delete_old_events(self, before: datetime) -> int:
        """Delete audit events older than specified date."""
        original_count = len(self._events)
        self._events = [e for e in self._events if e.timestamp >= before]
        deleted_count = original_count - len(self._events)

        logger.info(
            f"Deleted {deleted_count} old audit events",
            extra={"deleted_count": deleted_count, "before": before.isoformat()},
        )

        return deleted_count

    def clear(self) -> None:
        """Clear all events (for testing)."""
        self._events.clear()

    def get_all_events(self) -> list[AuditEvent]:
        """Get all events (for testing)."""
        return self._events.copy()
