"""Sandbox audit logging tests."""

import pytest
from unittest.mock import Mock, AsyncMock, patch
from datetime import datetime

from src.sandbox.audit import SandboxAuditLogger, AuditEventType
from src.sandbox.models import AuditLogEntry


class TestSandboxAuditLogger:
    """SandboxAuditLogger tests."""

    @pytest.fixture
    def logger(self):
        """Create a SandboxAuditLogger instance."""
        return SandboxAuditLogger()

    @pytest.mark.asyncio
    async def test_log_sandbox_created(self, logger):
        """Test logging sandbox creation event."""
        event = await logger.log_event(
            event_type=AuditEventType.SANDBOX_CREATED,
            sandbox_id="sandbox-123",
            user_id="user-456",
            details={"config": {"memory": "256MB"}},
        )

        assert event is not None
        assert event.event_type == AuditEventType.SANDBOX_CREATED
        assert event.sandbox_id == "sandbox-123"
        assert event.user_id == "user-456"
        assert event.timestamp is not None

    @pytest.mark.asyncio
    async def test_log_code_executed(self, logger):
        """Test logging code execution event."""
        event = await logger.log_event(
            event_type=AuditEventType.CODE_EXECUTED,
            sandbox_id="sandbox-123",
            details={
                "command": "python script.py",
                "exit_code": 0,
                "execution_time_ms": 150,
            },
        )

        assert event.event_type == AuditEventType.CODE_EXECUTED
        assert event.details["exit_code"] == 0

    @pytest.mark.asyncio
    async def test_log_policy_violation(self, logger):
        """Test logging policy violation event."""
        event = await logger.log_event(
            event_type=AuditEventType.POLICY_VIOLATION,
            sandbox_id="sandbox-123",
            severity="HIGH",
            details={
                "violation_type": "BLOCKED_COMMAND",
                "command": "rm -rf /",
            },
        )

        assert event.event_type == AuditEventType.POLICY_VIOLATION
        assert event.severity == "HIGH"
        assert event.details["violation_type"] == "BLOCKED_COMMAND"

    @pytest.mark.asyncio
    async def test_log_sandbox_destroyed(self, logger):
        """Test logging sandbox destruction event."""
        event = await logger.log_event(
            event_type=AuditEventType.SANDBOX_DESTROYED,
            sandbox_id="sandbox-123",
            details={"reason": "USER_REQUEST"},
        )

        assert event.event_type == AuditEventType.SANDBOX_DESTROYED
        assert event.details["reason"] == "USER_REQUEST"

    @pytest.mark.asyncio
    async def test_log_execution_timeout(self, logger):
        """Test logging execution timeout event."""
        event = await logger.log_event(
            event_type=AuditEventType.EXECUTION_TIMEOUT,
            sandbox_id="sandbox-123",
            details={
                "command": "while true; do :; done",
                "timeout_seconds": 30,
            },
        )

        assert event.event_type == AuditEventType.EXECUTION_TIMEOUT
        assert event.details["timeout_seconds"] == 30

    @pytest.mark.asyncio
    async def test_log_resource_limit_exceeded(self, logger):
        """Test logging resource limit exceeded event."""
        event = await logger.log_event(
            event_type=AuditEventType.RESOURCE_LIMIT_EXCEEDED,
            sandbox_id="sandbox-123",
            details={
                "resource": "memory",
                "limit": "256MB",
                "used": "512MB",
            },
        )

        assert event.event_type == AuditEventType.RESOURCE_LIMIT_EXCEEDED
        assert event.details["resource"] == "memory"

    @pytest.mark.asyncio
    async def test_get_events_by_sandbox(self, logger):
        """Test getting events by sandbox ID."""
        # Log some events
        await logger.log_event(
            event_type=AuditEventType.SANDBOX_CREATED,
            sandbox_id="sandbox-123",
        )
        await logger.log_event(
            event_type=AuditEventType.CODE_EXECUTED,
            sandbox_id="sandbox-123",
        )
        await logger.log_event(
            event_type=AuditEventType.SANDBOX_CREATED,
            sandbox_id="sandbox-456",
        )

        events = await logger.get_events(sandbox_id="sandbox-123")

        assert len(events) == 2
        assert all(e.sandbox_id == "sandbox-123" for e in events)

    @pytest.mark.asyncio
    async def test_get_events_by_user(self, logger):
        """Test getting events by user ID."""
        await logger.log_event(
            event_type=AuditEventType.SANDBOX_CREATED,
            sandbox_id="sandbox-1",
            user_id="user-A",
        )
        await logger.log_event(
            event_type=AuditEventType.SANDBOX_CREATED,
            sandbox_id="sandbox-2",
            user_id="user-A",
        )
        await logger.log_event(
            event_type=AuditEventType.SANDBOX_CREATED,
            sandbox_id="sandbox-3",
            user_id="user-B",
        )

        events = await logger.get_events(user_id="user-A")

        assert len(events) == 2
        assert all(e.user_id == "user-A" for e in events)

    @pytest.mark.asyncio
    async def test_get_events_by_type(self, logger):
        """Test getting events by event type."""
        await logger.log_event(
            event_type=AuditEventType.SANDBOX_CREATED,
            sandbox_id="sandbox-1",
        )
        await logger.log_event(
            event_type=AuditEventType.POLICY_VIOLATION,
            sandbox_id="sandbox-1",
        )
        await logger.log_event(
            event_type=AuditEventType.POLICY_VIOLATION,
            sandbox_id="sandbox-2",
        )

        events = await logger.get_events(event_type=AuditEventType.POLICY_VIOLATION)

        assert len(events) == 2
        assert all(e.event_type == AuditEventType.POLICY_VIOLATION for e in events)

    @pytest.mark.asyncio
    async def test_get_events_with_limit(self, logger):
        """Test getting events with limit."""
        for i in range(10):
            await logger.log_event(
                event_type=AuditEventType.CODE_EXECUTED,
                sandbox_id=f"sandbox-{i}",
            )

        events = await logger.get_events(limit=5)

        assert len(events) == 5

    @pytest.mark.asyncio
    async def test_clear_events(self, logger):
        """Test clearing events."""
        await logger.log_event(
            event_type=AuditEventType.SANDBOX_CREATED,
            sandbox_id="sandbox-1",
        )

        await logger.clear_events()

        events = await logger.get_events()
        assert len(events) == 0
