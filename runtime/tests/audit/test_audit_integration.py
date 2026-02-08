"""Integration tests for audit logging with UnifiedActionExecutor."""

import pytest
from unittest.mock import AsyncMock, MagicMock

from src.audit.logger import AuditLogger
from src.audit.storage import InMemoryAuditStorage
from src.audit.models import AuditEventType, AuditQuery
from src.orchestrator.unified_executor import UnifiedActionExecutor
from src.orchestrator.context import (
    RuntimeSessionContext,
    AgentConfig,
    SkillDefinition,
    RuntimePolicy,
)
from src.orchestrator.state import PlanStep
from src.skills.base import ToolResult


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
        available_skills=[
            SkillDefinition(
                id="skill_1",
                name="test_skill",
                description="Test skill",
                version="1.0.0",
                source="local",
            ),
        ],
        runtime_policy=RuntimePolicy(
            require_approval_for_high_risk=True,
            high_risk_tools=["dangerous_tool"],
        ),
    )


@pytest.fixture
def mock_skill_registry():
    """Create mock skill registry."""
    registry = MagicMock()
    registry.execute = AsyncMock(
        return_value=ToolResult(
            result="skill result",
            success=True,
        )
    )
    return registry


@pytest.mark.asyncio
async def test_audit_successful_action(
    runtime_context, mock_skill_registry, audit_logger, storage
):
    """Test audit logging for successful action execution."""
    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
        audit_logger=audit_logger,
    )

    action = PlanStep(
        id="step_1",
        title="Test action",
        tool="test_skill",
        params={"input": "test"},
    )

    result = await executor.execute(action)

    assert result.success is True

    # Flush audit events
    await audit_logger.flush()

    # Query audit events
    events = await storage.query(AuditQuery(session_id="session_abc"))

    # Should have ACTION_STARTED and ACTION_COMPLETED
    assert len(events) == 2
    assert events[1].event_type == AuditEventType.ACTION_STARTED
    assert events[0].event_type == AuditEventType.ACTION_COMPLETED
    assert events[0].success is True
    assert events[0].action_name == "test_skill"


@pytest.mark.asyncio
async def test_audit_failed_action(
    runtime_context, audit_logger, storage
):
    """Test audit logging for failed action execution."""
    mock_registry = MagicMock()
    mock_registry.execute = AsyncMock(
        side_effect=Exception("Execution failed")
    )

    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_registry,
        audit_logger=audit_logger,
    )

    action = PlanStep(
        id="step_1",
        title="Test action",
        tool="test_skill",
        params={"input": "test"},
    )

    result = await executor.execute(action)

    assert result.success is False

    # Flush audit events
    await audit_logger.flush()

    # Query audit events
    events = await storage.query(AuditQuery(session_id="session_abc"))

    # Should have ACTION_STARTED and ACTION_FAILED
    assert len(events) == 2
    assert events[1].event_type == AuditEventType.ACTION_STARTED
    assert events[0].event_type == AuditEventType.ACTION_FAILED
    assert events[0].success is False
    assert "Execution failed" in events[0].error_message


@pytest.mark.asyncio
async def test_audit_approval_granted(
    runtime_context, mock_skill_registry, audit_logger, storage
):
    """Test audit logging for approval granted."""
    # Add high-risk tool to context
    runtime_context.available_skills.append(
        SkillDefinition(
            id="skill_2",
            name="dangerous_tool",
            description="Dangerous tool",
        )
    )

    approval_hook = AsyncMock(return_value=True)

    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
        approval_hook=approval_hook,
        audit_logger=audit_logger,
    )

    action = PlanStep(
        id="step_1",
        title="Test action",
        tool="dangerous_tool",
        params={"input": "test"},
    )

    result = await executor.execute(action)

    assert result.success is True

    # Flush audit events
    await audit_logger.flush()

    # Query audit events
    events = await storage.query(AuditQuery(session_id="session_abc"))

    # Should have: ACTION_STARTED, APPROVAL_REQUESTED, APPROVAL_GRANTED, ACTION_COMPLETED
    assert len(events) == 4
    event_types = [e.event_type for e in reversed(events)]
    assert AuditEventType.ACTION_STARTED in event_types
    assert AuditEventType.APPROVAL_REQUESTED in event_types
    assert AuditEventType.APPROVAL_GRANTED in event_types
    assert AuditEventType.ACTION_COMPLETED in event_types


@pytest.mark.asyncio
async def test_audit_approval_denied(
    runtime_context, mock_skill_registry, audit_logger, storage
):
    """Test audit logging for approval denied."""
    # Add high-risk tool to context
    runtime_context.available_skills.append(
        SkillDefinition(
            id="skill_2",
            name="dangerous_tool",
            description="Dangerous tool",
        )
    )

    approval_hook = AsyncMock(return_value=False)

    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
        approval_hook=approval_hook,
        audit_logger=audit_logger,
    )

    action = PlanStep(
        id="step_1",
        title="Test action",
        tool="dangerous_tool",
        params={"input": "test"},
    )

    result = await executor.execute(action)

    assert result.success is False

    # Flush audit events
    await audit_logger.flush()

    # Query audit events
    events = await storage.query(AuditQuery(session_id="session_abc"))

    # Should have: ACTION_STARTED, APPROVAL_REQUESTED, APPROVAL_DENIED, ACTION_REJECTED
    assert len(events) == 4
    event_types = [e.event_type for e in reversed(events)]
    assert AuditEventType.ACTION_STARTED in event_types
    assert AuditEventType.APPROVAL_REQUESTED in event_types
    assert AuditEventType.APPROVAL_DENIED in event_types
    assert AuditEventType.ACTION_REJECTED in event_types


@pytest.mark.asyncio
async def test_audit_metadata_captured(
    runtime_context, mock_skill_registry, audit_logger, storage
):
    """Test that execution metadata is captured in audit events."""
    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
        audit_logger=audit_logger,
    )

    action = PlanStep(
        id="step_1",
        title="Test action",
        tool="test_skill",
        params={"input": "test"},
    )

    await executor.execute(action)
    await audit_logger.flush()

    events = await storage.query(AuditQuery(session_id="session_abc"))

    # Check metadata in ACTION_STARTED event
    started_event = next(e for e in events if e.event_type == AuditEventType.ACTION_STARTED)
    assert started_event.capability_type == "skill"
    assert started_event.capability_source == "local"
    assert started_event.capability_version == "1.0.0"
    assert started_event.action_params == {"input": "test"}


@pytest.mark.asyncio
async def test_audit_query_by_action_name(
    runtime_context, mock_skill_registry, audit_logger, storage
):
    """Test querying audit events by action name."""
    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
        audit_logger=audit_logger,
    )

    # Execute multiple actions
    for i in range(3):
        action = PlanStep(
            id=f"step_{i}",
            title="Test action",
            tool="test_skill",
            params={"input": f"test_{i}"},
        )
        await executor.execute(action)

    await audit_logger.flush()

    # Query by action name
    events = await audit_logger.query_events(
        AuditQuery(
            session_id="session_abc",
            action_name="test_skill",
        )
    )

    # Should have 6 events (3 x ACTION_STARTED + 3 x ACTION_COMPLETED)
    assert len(events) == 6


@pytest.mark.asyncio
async def test_audit_without_logger(
    runtime_context, mock_skill_registry
):
    """Test that executor works without audit logger."""
    executor = UnifiedActionExecutor(
        runtime_context=runtime_context,
        skill_registry=mock_skill_registry,
        audit_logger=None,  # No audit logger
    )

    action = PlanStep(
        id="step_1",
        title="Test action",
        tool="test_skill",
        params={"input": "test"},
    )

    # Should work without errors
    result = await executor.execute(action)
    assert result.success is True
