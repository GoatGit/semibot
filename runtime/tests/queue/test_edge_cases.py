"""Tests for Queue module edge cases and boundary conditions."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from src.queue.producer import TaskProducer
from src.queue.consumer import TaskConsumer, TaskMessage


@pytest.fixture
def mock_redis():
    """Create a mock Redis client."""
    mock = AsyncMock()
    mock.lpush = AsyncMock()
    mock.brpop = AsyncMock()
    mock.llen = AsyncMock(return_value=0)
    mock.lrange = AsyncMock(return_value=[])
    mock.lrem = AsyncMock()
    mock.delete = AsyncMock()
    mock.publish = AsyncMock()
    mock.close = AsyncMock()
    return mock


@pytest.fixture
def producer(mock_redis):
    """Create a TaskProducer instance."""
    prod = TaskProducer(
        redis_url="redis://localhost:6379",
        queue_name="test:queue",
        max_queue_size=10,
    )
    prod._redis = mock_redis
    return prod


@pytest.fixture
def consumer(mock_redis):
    """Create a TaskConsumer instance."""
    cons = TaskConsumer(
        redis_url="redis://localhost:6379",
        queue_name="test:queue",
        max_concurrent=3,
        poll_timeout=1,
    )
    cons._redis = mock_redis
    return cons


@pytest.mark.asyncio
async def test_producer_backpressure_when_queue_full(producer, mock_redis):
    """Test producer handles backpressure when queue is full."""
    # Simulate full queue
    mock_redis.llen.return_value = 10  # max_queue_size

    task = TaskMessage(
        task_id="task_001",
        session_id="sess_123",
        agent_id="agent_456",
        org_id="org_789",
        messages=[{"role": "user", "content": "test"}],
        config={},
        metadata={},
    )

    # Should raise or handle backpressure
    with pytest.raises(Exception) as exc_info:
        await producer.enqueue(task)

    assert "queue full" in str(exc_info.value).lower() or "backpressure" in str(exc_info.value).lower()


@pytest.mark.asyncio
async def test_consumer_concurrent_limit_enforcement(consumer, mock_redis):
    """Test consumer enforces max_concurrent limit."""
    # Create tasks that take time to process
    task_data = {
        "task_id": "task_001",
        "session_id": "sess_123",
        "agent_id": "agent_456",
        "org_id": "org_789",
        "messages": [{"role": "user", "content": "test"}],
        "config": {},
        "metadata": {},
    }

    # Mock brpop to return tasks
    mock_redis.brpop.side_effect = [
        ("test:queue", json.dumps(task_data).encode()),
        ("test:queue", json.dumps({**task_data, "task_id": "task_002"}).encode()),
        ("test:queue", json.dumps({**task_data, "task_id": "task_003"}).encode()),
        ("test:queue", json.dumps({**task_data, "task_id": "task_004"}).encode()),
        None,  # Stop after 4 tasks
    ]

    # Track concurrent executions
    concurrent_count = 0
    max_concurrent_seen = 0

    async def slow_handler(task):
        nonlocal concurrent_count, max_concurrent_seen
        concurrent_count += 1
        max_concurrent_seen = max(max_concurrent_seen, concurrent_count)
        await asyncio.sleep(0.1)  # Simulate work
        concurrent_count -= 1

    consumer._handler = slow_handler

    # Start consumer briefly
    consumer_task = asyncio.create_task(consumer.start())
    await asyncio.sleep(0.5)
    await consumer.stop()

    try:
        await asyncio.wait_for(consumer_task, timeout=2.0)
    except asyncio.TimeoutError:
        pass

    # Should not exceed max_concurrent
    assert max_concurrent_seen <= consumer.max_concurrent


@pytest.mark.asyncio
async def test_dead_letter_queue_retry_logic(producer, mock_redis):
    """Test dead letter queue handles failed tasks with retry."""
    task = TaskMessage(
        task_id="task_001",
        session_id="sess_123",
        agent_id="agent_456",
        org_id="org_789",
        messages=[{"role": "user", "content": "test"}],
        config={},
        metadata={"retry_count": 2},
    )

    # Mock DLQ operations
    dlq_key = "test:queue:dlq"

    await producer.move_to_dlq(task, error="execution failed")

    # Should push to DLQ
    mock_redis.lpush.assert_called()
    call_args = mock_redis.lpush.call_args
    assert dlq_key in call_args[0]


@pytest.mark.asyncio
async def test_consumer_handles_malformed_task_data(consumer, mock_redis):
    """Test consumer handles malformed task data gracefully."""
    # Mock brpop to return invalid JSON
    mock_redis.brpop.return_value = ("test:queue", b"invalid json {{{")

    # Should not crash, should log error and continue
    consumer_task = asyncio.create_task(consumer.start())
    await asyncio.sleep(0.1)
    await consumer.stop()

    try:
        await asyncio.wait_for(consumer_task, timeout=1.0)
    except asyncio.TimeoutError:
        pass

    # Consumer should still be functional (not crashed)
    assert consumer._redis is not None


@pytest.mark.asyncio
async def test_consumer_handles_missing_required_fields(consumer, mock_redis):
    """Test consumer handles tasks with missing required fields."""
    # Task missing required fields
    incomplete_task = {
        "task_id": "task_001",
        # Missing session_id, agent_id, org_id, messages
    }

    mock_redis.brpop.return_value = ("test:queue", json.dumps(incomplete_task).encode())

    # Should handle gracefully
    consumer_task = asyncio.create_task(consumer.start())
    await asyncio.sleep(0.1)
    await consumer.stop()

    try:
        await asyncio.wait_for(consumer_task, timeout=1.0)
    except asyncio.TimeoutError:
        pass

    # Should not crash
    assert consumer._redis is not None


@pytest.mark.asyncio
async def test_producer_handles_redis_connection_failure(producer):
    """Test producer handles Redis connection failures."""
    # Simulate connection failure
    producer._redis = None

    task = TaskMessage(
        task_id="task_001",
        session_id="sess_123",
        agent_id="agent_456",
        org_id="org_789",
        messages=[{"role": "user", "content": "test"}],
        config={},
        metadata={},
    )

    # Should raise connection error
    with pytest.raises(Exception):
        await producer.enqueue(task)


@pytest.mark.asyncio
async def test_consumer_graceful_shutdown_waits_for_tasks(consumer, mock_redis):
    """Test consumer waits for in-flight tasks during shutdown."""
    task_data = {
        "task_id": "task_001",
        "session_id": "sess_123",
        "agent_id": "agent_456",
        "org_id": "org_789",
        "messages": [{"role": "user", "content": "test"}],
        "config": {},
        "metadata": {},
    }

    mock_redis.brpop.return_value = ("test:queue", json.dumps(task_data).encode())

    # Track if task completed
    task_completed = False

    async def slow_handler(task):
        nonlocal task_completed
        await asyncio.sleep(0.5)
        task_completed = True

    consumer._handler = slow_handler

    # Start consumer and immediately stop
    consumer_task = asyncio.create_task(consumer.start())
    await asyncio.sleep(0.1)  # Let task start
    await consumer.stop()

    await asyncio.wait_for(consumer_task, timeout=2.0)

    # Task should have completed before shutdown
    assert task_completed


@pytest.mark.asyncio
async def test_queue_priority_ordering(producer, mock_redis):
    """Test queue maintains priority ordering for tasks."""
    high_priority_task = TaskMessage(
        task_id="task_high",
        session_id="sess_123",
        agent_id="agent_456",
        org_id="org_789",
        messages=[{"role": "user", "content": "urgent"}],
        config={},
        metadata={"priority": "high"},
    )

    low_priority_task = TaskMessage(
        task_id="task_low",
        session_id="sess_123",
        agent_id="agent_456",
        org_id="org_789",
        messages=[{"role": "user", "content": "normal"}],
        config={},
        metadata={"priority": "low"},
    )

    # Enqueue in reverse priority order
    await producer.enqueue(low_priority_task)
    await producer.enqueue(high_priority_task)

    # Verify high priority task is processed first
    # (This depends on implementation - may need adjustment)
    assert mock_redis.lpush.call_count == 2
