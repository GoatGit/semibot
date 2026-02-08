"""Tests for AuditLogger."""

import pytest
from datetime import datetime, timedelta
from unittest.mock import AsyncMock

from src.audit.logger import AuditLogger
from src.audit.storage import InMemoryAuditStorage
from src.audit.models import AuditEventType, AuditSeverity, AuditQuery
from src.orchestrator.context import (
    RuntimeSessionContext,
    AgentConfig,
    RuntimePolicy,
)
from src.orchestrator.unified_executor import ExecutionMetadata


@pytest.fixture
def storage():
    """Create in-memory storage."""
    return InMemoryAuditStorage()


@pytest.fixture
def audit_logger(storage):
    """Create audit logger."""
    return AuditLogger(storage=storage, batch_size=10, flush_interval=1.0)


@pytest.fixture
def runtime_context():
    """Create test runtime context."""
    return RuntimeSessionContext(
        org_id="org_123",
        user_id="user_456",
        agent_id="agent_789",
        session_id="session_abc",
        agent_config=AgentConfig(
            id="agent_789",
            name="Test Agent",
        ),
        runtime_policy=RuntimePolicy(),
    )


@pytest.fixture
def execution_metadata():
    """Create test execution metadata."""
    return ExecutionMetadata(
        capability_type="skill",
        source="local",
        version="1.0.0",
    )


@pytest.mark.asyncio
async def test_log_action_started(audit_logger, storage, runtime_context, execution_metadata):
    """Test logging action started event."""
    await audit_logger.log_action_started(
        context=runtime_context,
        action_id="action_1",
        action_name="test_skill",
        action_params={"input": "test"},
        metadata=execution_metadata,
    )

    # Flush to storage
    await audit_logger.flush()

    # Query events
    events = await storage.query(AuditQuery(session_id="session_abc"))

    assert len(events) == 1
    event = events[0]
    assert event.event_type == AuditEventType.ACTION_STARTED
    assert event.action_name == "test_skill"
    assert event.action_params == {"input": "test"}
    assert event.capability_type == "skill"
    assert event.capability_source == "local"
    assert event.capability_version == "1.0.0"


@pytest.mark.asyncio
async def test_log_action_completed(audit_logger, storage, runtime_context, execution_metadata):
    """Test logging action completed event."""
    await audit_logger.log_action_completed(
        context=runtime_context,
        action_id="action_1",
        action_name="test_skill",
        action_params={"input": "test"},
        metadata=execution_metadata,
        duration_ms=100,
        result="success",
    )

    await audit_logger.flush()

    events = await storage.query(AuditQuery(session_id="session_abc"))

    assert len(events) == 1
    event = events[0]
    assert event.event_type == AuditEventType.ACTION_COMPLETED
    assert event.success is True
    assert event.duration_ms == 100


@pytest.mark.asyncio
async def test_log_action_failed(audit_logger, storage, runtime_context, execution_metadata):
    """Test logging action failed event."""
    await audit_logger.log_action_failed(
        context=runtime_context,
        action_id="action_1",
        action_name="test_skill",
        action_params={"input": "test"},
        metadata=execution_metadata,
        duration_ms=50,
        error="Test error",
    )

    await audit_logger.flush()

    events = await storage.query(AuditQuery(session_id="session_abc"))

    assert len(events) == 1
    event = events[0]
    assert event.event_type == AuditEventType.ACTION_FAILED
    assert event.success is False
    assert event.error_message == "Test error"
    assert event.severity == AuditSeverity.ERROR


@pytest.mark.asyncio
async def test_log_action_rejected(audit_logger, storage, runtime_context, execution_metadata):
    """Test logging action rejected event."""
    await audit_logger.log_action_rejected(
        context=runtime_context,
        action_id="action_1",
        action_name="dangerous_tool",
        action_params={"input": "test"},
        metadata=execution_metadata,
        reason="User denied approval",
    )

    await audit_logger.flush()

    events = await storage.query(AuditQuery(session_id="session_abc"))

    assert len(events) == 1
    event = events[0]
    assert event.event_type == AuditEventType.ACTION_REJECTED
    assert event.requires_approval is True
    assert event.approval_granted is False
    assert event.error_message == "User denied approval"


@pytest.mark.asyncio
async def test_log_approval_flow(audit_logger, storage, runtime_context, execution_metadata):
    """Test logging complete approval flow."""
    # Request approval
    await audit_logger.log_approval_requested(
        context=runtime_context,
        action_id="action_1",
        action_name="dangerous_tool",
        action_params={"input": "test"},
        metadata=execution_metadata,
    )

    # Grant approval
    await audit_logger.log_approval_granted(
        context=runtime_context,
        action_id="action_1",
        action_name="dangerous_tool",
    )

    await audit_logger.flush()

    events = await storage.query(AuditQuery(session_id="session_abc"))

    assert len(events) == 2
    assert events[1].event_type == AuditEventType.APPROVAL_REQUESTED
    assert events[0].event_type == AuditEventType.APPROVAL_GRANTED


@pytest.mark.asyncio
async def test_batch_flushing(audit_logger, storage, runtime_context, execution_metadata):
    """Test batch flushing when batch size is reached."""
    # Log 10 events (batch size)
    for i in range(10):
        await audit_logger.log_action_started(
            context=runtime_context,
            action_id=f"action_{i}",
            action_name="test_skill",
            action_params={},
            metadata=execution_metadata,
        )

    # Wait a bit for async flush
    import asyncio
    await asyncio.sleep(0.1)

    # Events should be flushed automatically
    events = await storage.query(AuditQuery(session_id="session_abc", limit=100))
    assert len(events) == 10


@pytest.mark.asyncio
async def test_query_by_event_type(audit_logger, storage, runtime_context, execution_metadata):
    """Test querying events by type."""
    await audit_logger.log_action_started(
        context=runtime_context,
        action_id="action_1",
        action_name="test_skill",
        action_params={},
        metadata=execution_metadata,
    )

    await audit_logger.log_action_completed(
        context=runtime_context,
        action_id="action_1",
        action_name="test_skill",
        action_params={},
        metadata=execution_metadata,
        duration_ms=100,
    )

    await audit_logger.flush()

    # Query only ACTION_STARTED events
    events = await audit_logger.query_events(
        AuditQuery(
            session_id="session_abc",
            event_types=[AuditEventType.ACTION_STARTED],
        )
    )

    assert len(events) == 1
    assert events[0].event_type == AuditEventType.ACTION_STARTED


@pytest.mark.asyncio
async def test_query_by_success(audit_logger, storage, runtime_context, execution_metadata):
    """Test querying events by success status."""
    await audit_logger.log_action_completed(
        context=runtime_context,
        action_id="action_1",
        action_name="test_skill",
        action_params={},
        metadata=execution_metadata,
        duration_ms=100,
    )

    await audit_logger.log_action_failed(
        context=runtime_context,
        action_id="action_2",
        action_name="test_skill",
        action_params={},
        metadata=execution_metadata,
        duration_ms=50,
        error="Test error",
    )

    await audit_logger.flush()

    # Query only failed events
    events = await audit_logger.query_events(
        AuditQuery(session_id="session_abc", success=False)
    )

    assert len(events) == 1
    assert events[0].success is False


@pytest.mark.asyncio
async def test_count_events(audit_logger, storage, runtime_context, execution_metadata):
    """Test counting events."""
    for i in range(5):
        await audit_logger.log_action_started(
            context=runtime_context,
            action_id=f"action_{i}",
            action_name="test_skill",
            action_params={},
            metadata=execution_metadata,
        )

    await audit_logger.flush()

    count = await audit_logger.count_events(
        AuditQuery(session_id="session_abc")
    )

    assert count == 5


@pytest.mark.asyncio
async def test_start_stop(audit_logger, storage, runtime_context, execution_metadata):
    """Test starting and stopping audit logger."""
    await audit_logger.start()

    # Log some events
    await audit_logger.log_action_started(
        context=runtime_context,
        action_id="action_1",
        action_name="test_skill",
        action_params={},
        metadata=execution_metadata,
    )

    # Stop should flush pending events
    await audit_logger.stop()

    events = await storage.query(AuditQuery(session_id="session_abc"))
    assert len(events) == 1


@pytest.mark.asyncio
async def test_query_by_time_range(audit_logger, storage, runtime_context, execution_metadata):
    """Test querying events by time range."""
    from datetime import timezone
    now = datetime.now(timezone.utc)

    # Log event
    await audit_logger.log_action_started(
        context=runtime_context,
        action_id="action_1",
        action_name="test_skill",
        action_params={},
        metadata=execution_metadata,
    )

    await audit_logger.flush()

    # Query with time range
    events = await audit_logger.query_events(
        AuditQuery(
            session_id="session_abc",
            start_time=now - timedelta(minutes=1),
            end_time=now + timedelta(minutes=1),
        )
    )

    assert len(events) == 1
