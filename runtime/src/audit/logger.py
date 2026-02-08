"""Audit logger implementation."""

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any

from src.audit.models import AuditEvent, AuditEventType, AuditSeverity, AuditQuery
from src.audit.storage import AuditStorage
from src.orchestrator.context import RuntimeSessionContext
from src.orchestrator.unified_executor import ExecutionMetadata
from src.utils.logging import get_logger
from src.constants.config import (
    AUDIT_EVENT_BATCH_SIZE,
    AUDIT_EVENT_FLUSH_INTERVAL,
)

logger = get_logger(__name__)


class AuditLogger:
    """
    Audit logger for runtime events.

    This logger records all auditable events in the runtime system,
    including action executions, approvals, MCP calls, etc.

    Features:
    - Asynchronous event recording
    - Batch writing for performance
    - Automatic flushing
    - Query support
    """

    def __init__(
        self,
        storage: AuditStorage,
        batch_size: int = AUDIT_EVENT_BATCH_SIZE,
        flush_interval: float = AUDIT_EVENT_FLUSH_INTERVAL,
    ):
        """
        Initialize audit logger.

        Args:
            storage: Audit storage backend
            batch_size: Number of events to batch before writing
            flush_interval: Interval in seconds to flush pending events
        """
        self.storage = storage
        self.batch_size = batch_size
        self.flush_interval = flush_interval

        self._pending_events: list[AuditEvent] = []
        self._flush_task: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        """Start the audit logger (starts background flush task)."""
        if self._flush_task is None:
            self._flush_task = asyncio.create_task(self._flush_loop())
            logger.info("Audit logger started")

    async def stop(self) -> None:
        """Stop the audit logger (flushes pending events)."""
        if self._flush_task:
            self._flush_task.cancel()
            try:
                await self._flush_task
            except asyncio.CancelledError:
                pass
            self._flush_task = None

        # Flush any remaining events
        await self.flush()
        logger.info("Audit logger stopped")

    async def _flush_loop(self) -> None:
        """Background task to periodically flush pending events."""
        while True:
            try:
                await asyncio.sleep(self.flush_interval)
                await self.flush()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in audit flush loop: {e}")

    async def flush(self) -> None:
        """Flush pending events to storage."""
        async with self._lock:
            if not self._pending_events:
                return

            events_to_flush = self._pending_events.copy()
            self._pending_events.clear()

        try:
            await self.storage.store_batch(events_to_flush)
            logger.debug(
                f"Flushed {len(events_to_flush)} audit events",
                extra={"event_count": len(events_to_flush)},
            )
        except Exception as e:
            logger.error(f"Failed to flush audit events: {e}")
            # Re-add events to pending queue
            async with self._lock:
                self._pending_events.extend(events_to_flush)

    async def log_event(self, event: AuditEvent) -> None:
        """
        Log an audit event.

        Args:
            event: Audit event to log
        """
        async with self._lock:
            self._pending_events.append(event)

            # Flush if batch size reached
            if len(self._pending_events) >= self.batch_size:
                # Trigger flush without waiting
                asyncio.create_task(self.flush())

    async def log_action_started(
        self,
        context: RuntimeSessionContext,
        action_id: str,
        action_name: str,
        action_params: dict[str, Any],
        metadata: ExecutionMetadata,
    ) -> None:
        """Log action execution started."""
        event = AuditEvent(
            event_id=str(uuid.uuid4()),
            event_type=AuditEventType.ACTION_STARTED,
            timestamp=datetime.now(timezone.utc),
            org_id=context.org_id,
            user_id=context.user_id,
            agent_id=context.agent_id,
            session_id=context.session_id,
            severity=AuditSeverity.INFO,
            message=f"Action '{action_name}' started",
            action_id=action_id,
            action_name=action_name,
            action_params=action_params,
            capability_type=metadata.capability_type,
            capability_source=metadata.source,
            capability_version=metadata.version,
            mcp_server_id=metadata.mcp_server_id,
            mcp_server_name=metadata.mcp_server_name,
            requires_approval=metadata.requires_approval,
        )
        await self.log_event(event)

    async def log_action_completed(
        self,
        context: RuntimeSessionContext,
        action_id: str,
        action_name: str,
        action_params: dict[str, Any],
        metadata: ExecutionMetadata,
        duration_ms: int,
        result: Any = None,
    ) -> None:
        """Log action execution completed successfully."""
        event = AuditEvent(
            event_id=str(uuid.uuid4()),
            event_type=AuditEventType.ACTION_COMPLETED,
            timestamp=datetime.now(timezone.utc),
            org_id=context.org_id,
            user_id=context.user_id,
            agent_id=context.agent_id,
            session_id=context.session_id,
            severity=AuditSeverity.INFO,
            message=f"Action '{action_name}' completed successfully",
            action_id=action_id,
            action_name=action_name,
            action_params=action_params,
            capability_type=metadata.capability_type,
            capability_source=metadata.source,
            capability_version=metadata.version,
            mcp_server_id=metadata.mcp_server_id,
            mcp_server_name=metadata.mcp_server_name,
            success=True,
            duration_ms=duration_ms,
            metadata={"result_preview": str(result)[:200] if result else None},
        )
        await self.log_event(event)

    async def log_action_failed(
        self,
        context: RuntimeSessionContext,
        action_id: str,
        action_name: str,
        action_params: dict[str, Any],
        metadata: ExecutionMetadata,
        duration_ms: int,
        error: str,
    ) -> None:
        """Log action execution failed."""
        event = AuditEvent(
            event_id=str(uuid.uuid4()),
            event_type=AuditEventType.ACTION_FAILED,
            timestamp=datetime.now(timezone.utc),
            org_id=context.org_id,
            user_id=context.user_id,
            agent_id=context.agent_id,
            session_id=context.session_id,
            severity=AuditSeverity.ERROR,
            message=f"Action '{action_name}' failed",
            action_id=action_id,
            action_name=action_name,
            action_params=action_params,
            capability_type=metadata.capability_type,
            capability_source=metadata.source,
            capability_version=metadata.version,
            mcp_server_id=metadata.mcp_server_id,
            mcp_server_name=metadata.mcp_server_name,
            success=False,
            error_message=error,
            duration_ms=duration_ms,
        )
        await self.log_event(event)

    async def log_action_rejected(
        self,
        context: RuntimeSessionContext,
        action_id: str,
        action_name: str,
        action_params: dict[str, Any],
        metadata: ExecutionMetadata,
        reason: str,
    ) -> None:
        """Log action rejected by approval hook."""
        event = AuditEvent(
            event_id=str(uuid.uuid4()),
            event_type=AuditEventType.ACTION_REJECTED,
            timestamp=datetime.now(timezone.utc),
            org_id=context.org_id,
            user_id=context.user_id,
            agent_id=context.agent_id,
            session_id=context.session_id,
            severity=AuditSeverity.WARNING,
            message=f"Action '{action_name}' rejected: {reason}",
            action_id=action_id,
            action_name=action_name,
            action_params=action_params,
            capability_type=metadata.capability_type,
            capability_source=metadata.source,
            capability_version=metadata.version,
            requires_approval=True,
            approval_granted=False,
            success=False,
            error_message=reason,
        )
        await self.log_event(event)

    async def log_approval_requested(
        self,
        context: RuntimeSessionContext,
        action_id: str,
        action_name: str,
        action_params: dict[str, Any],
        metadata: ExecutionMetadata,
    ) -> None:
        """Log approval requested for high-risk action."""
        event = AuditEvent(
            event_id=str(uuid.uuid4()),
            event_type=AuditEventType.APPROVAL_REQUESTED,
            timestamp=datetime.now(timezone.utc),
            org_id=context.org_id,
            user_id=context.user_id,
            agent_id=context.agent_id,
            session_id=context.session_id,
            severity=AuditSeverity.WARNING,
            message=f"Approval requested for action '{action_name}'",
            action_id=action_id,
            action_name=action_name,
            action_params=action_params,
            capability_type=metadata.capability_type,
            requires_approval=True,
        )
        await self.log_event(event)

    async def log_approval_granted(
        self,
        context: RuntimeSessionContext,
        action_id: str,
        action_name: str,
    ) -> None:
        """Log approval granted."""
        event = AuditEvent(
            event_id=str(uuid.uuid4()),
            event_type=AuditEventType.APPROVAL_GRANTED,
            timestamp=datetime.now(timezone.utc),
            org_id=context.org_id,
            user_id=context.user_id,
            agent_id=context.agent_id,
            session_id=context.session_id,
            severity=AuditSeverity.INFO,
            message=f"Approval granted for action '{action_name}'",
            action_id=action_id,
            action_name=action_name,
            approval_granted=True,
        )
        await self.log_event(event)

    async def log_approval_denied(
        self,
        context: RuntimeSessionContext,
        action_id: str,
        action_name: str,
    ) -> None:
        """Log approval denied."""
        event = AuditEvent(
            event_id=str(uuid.uuid4()),
            event_type=AuditEventType.APPROVAL_DENIED,
            timestamp=datetime.now(timezone.utc),
            org_id=context.org_id,
            user_id=context.user_id,
            agent_id=context.agent_id,
            session_id=context.session_id,
            severity=AuditSeverity.WARNING,
            message=f"Approval denied for action '{action_name}'",
            action_id=action_id,
            action_name=action_name,
            approval_granted=False,
        )
        await self.log_event(event)

    async def query_events(self, query: AuditQuery) -> list[AuditEvent]:
        """
        Query audit events.

        Args:
            query: Query parameters

        Returns:
            List of matching audit events
        """
        return await self.storage.query(query)

    async def count_events(self, query: AuditQuery) -> int:
        """
        Count audit events matching query.

        Args:
            query: Query parameters

        Returns:
            Number of matching events
        """
        return await self.storage.count(query)
