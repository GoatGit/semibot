"""Integration tests for queue module."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tests.queue.conftest import TaskConsumer, TaskMessage, TaskPayload, TaskProducer


class TestProducerConsumerIntegration:
    """Integration tests for producer-consumer workflow."""

    @pytest.fixture
    def mock_redis_client(self):
        """Create a mock Redis client that simulates queue behavior."""
        queue = []
        pubsub_messages = {}

        mock = AsyncMock()

        async def lpush(queue_name, data):
            queue.insert(0, data)
            return len(queue)

        async def brpop(queue_name, timeout=0):
            if queue:
                return (queue_name, queue.pop())
            return None

        async def llen(queue_name):
            return len(queue)

        async def publish(channel, message):
            if channel not in pubsub_messages:
                pubsub_messages[channel] = []
            pubsub_messages[channel].append(message)
            return 1

        mock.lpush = lpush
        mock.brpop = brpop
        mock.llen = llen
        mock.publish = publish
        mock.delete = AsyncMock()
        mock.lrange = AsyncMock(return_value=[])
        mock.lrem = AsyncMock()
        mock.close = AsyncMock()

        return mock, queue, pubsub_messages

    @pytest.mark.asyncio
    async def test_enqueue_and_consume(self, mock_redis_client):
        """Test full enqueue -> consume workflow."""
        mock_redis, queue, pubsub_messages = mock_redis_client

        # Setup producer
        producer = TaskProducer(redis_url="redis://localhost:6379")
        producer._redis = mock_redis

        # Setup consumer
        results = []

        async def handler(task: TaskMessage):
            results.append(task)
            return {"status": "completed", "task_id": task.task_id}

        consumer = TaskConsumer(
            redis_url="redis://localhost:6379",
            handler=handler,
        )
        consumer._redis = mock_redis
        consumer._semaphore = asyncio.Semaphore(10)

        # Enqueue a task
        payload = TaskPayload(
            session_id="sess_integration",
            agent_id="agent_test",
            org_id="org_test",
            messages=[{"role": "user", "content": "Integration test"}],
            task_id="task_integration_001",
        )

        task_id = await producer.enqueue(payload)
        assert task_id == "task_integration_001"
        assert len(queue) == 1

        # Consume the task
        await consumer._poll_and_process()

        # Wait for background task processing
        await asyncio.sleep(0.1)
        if consumer._tasks:
            await asyncio.gather(*consumer._tasks, return_exceptions=True)

        # Verify task was processed
        assert len(queue) == 0
        assert len(results) == 1
        assert results[0].task_id == "task_integration_001"
        assert results[0].session_id == "sess_integration"

    @pytest.mark.asyncio
    async def test_multiple_tasks_fifo_order(self, mock_redis_client):
        """Test that tasks are processed in FIFO order."""
        mock_redis, queue, _ = mock_redis_client

        producer = TaskProducer(redis_url="redis://localhost:6379")
        producer._redis = mock_redis

        processed_order = []

        async def handler(task: TaskMessage):
            processed_order.append(task.task_id)
            return {"status": "ok"}

        consumer = TaskConsumer(
            redis_url="redis://localhost:6379",
            handler=handler,
        )
        consumer._redis = mock_redis
        consumer._semaphore = asyncio.Semaphore(10)

        # Enqueue tasks in order
        for i in range(3):
            await producer.enqueue(
                TaskPayload(
                    session_id=f"sess_{i}",
                    agent_id="agent",
                    org_id="org",
                    messages=[],
                    task_id=f"task_{i}",
                )
            )

        # Consume all tasks
        for _ in range(3):
            await consumer._poll_and_process()

        # Wait for processing
        await asyncio.sleep(0.1)
        if consumer._tasks:
            await asyncio.gather(*consumer._tasks, return_exceptions=True)

        # Verify FIFO order (first in, first out)
        assert processed_order == ["task_0", "task_1", "task_2"]

    @pytest.mark.asyncio
    async def test_concurrent_task_limit(self, mock_redis_client):
        """Test that concurrent task limit is respected."""
        mock_redis, queue, _ = mock_redis_client

        producer = TaskProducer(redis_url="redis://localhost:6379")
        producer._redis = mock_redis

        processing_count = 0
        max_concurrent_seen = 0

        async def slow_handler(task: TaskMessage):
            nonlocal processing_count, max_concurrent_seen
            processing_count += 1
            max_concurrent_seen = max(max_concurrent_seen, processing_count)
            await asyncio.sleep(0.05)  # Simulate work
            processing_count -= 1
            return {"status": "ok"}

        consumer = TaskConsumer(
            redis_url="redis://localhost:6379",
            handler=slow_handler,
            max_concurrent=2,  # Limit to 2 concurrent
        )
        consumer._redis = mock_redis
        consumer._semaphore = asyncio.Semaphore(2)

        # Enqueue 5 tasks
        for i in range(5):
            await producer.enqueue(
                TaskPayload(
                    session_id=f"sess_{i}",
                    agent_id="agent",
                    org_id="org",
                    messages=[],
                    task_id=f"task_{i}",
                )
            )

        # Poll all tasks (they'll be processed with limited concurrency)
        for _ in range(5):
            await consumer._poll_and_process()

        # Wait for all tasks to complete
        if consumer._tasks:
            await asyncio.gather(*consumer._tasks, return_exceptions=True)

        # Max concurrent should not exceed 2
        assert max_concurrent_seen <= 2

    @pytest.mark.asyncio
    async def test_task_retry_flow(self, mock_redis_client):
        """Test task retry flow on failure."""
        mock_redis, queue, _ = mock_redis_client

        attempt_count = 0

        async def failing_handler(task: TaskMessage):
            nonlocal attempt_count
            attempt_count += 1
            if attempt_count < 3:
                raise Exception(f"Fail attempt {attempt_count}")
            return {"status": "success on attempt 3"}

        consumer = TaskConsumer(
            redis_url="redis://localhost:6379",
            handler=failing_handler,
            max_retry_attempts=3,
        )
        consumer._redis = mock_redis
        consumer._semaphore = asyncio.Semaphore(10)

        # Add initial task
        initial_task = {
            "task_id": "retry_task",
            "session_id": "sess",
            "agent_id": "agent",
            "org_id": "org",
            "messages": [],
            "config": {},
            "metadata": {},
        }
        queue.append(json.dumps(initial_task))

        # First attempt - should fail and retry
        await consumer._poll_and_process()
        await asyncio.sleep(0.1)
        if consumer._tasks:
            await asyncio.gather(*consumer._tasks, return_exceptions=True)

        # Task should be requeued with retry_count=1
        assert len(queue) == 1
        requeued = json.loads(queue[0])
        assert requeued["metadata"]["retry_count"] == 1

        # Second attempt - should fail and retry again
        consumer._tasks.clear()
        await consumer._poll_and_process()
        await asyncio.sleep(0.1)
        if consumer._tasks:
            await asyncio.gather(*consumer._tasks, return_exceptions=True)

        assert len(queue) == 1
        requeued = json.loads(queue[0])
        assert requeued["metadata"]["retry_count"] == 2

        # Third attempt - should succeed
        consumer._tasks.clear()
        await consumer._poll_and_process()
        await asyncio.sleep(0.1)
        if consumer._tasks:
            await asyncio.gather(*consumer._tasks, return_exceptions=True)

        # Queue should be empty (task completed)
        assert len(queue) == 0
        assert attempt_count == 3


class TestPublishSubscribe:
    """Tests for pub/sub result notification."""

    @pytest.mark.asyncio
    async def test_result_published_on_success(self):
        """Test that result is published on successful processing."""
        mock_redis = AsyncMock()
        mock_redis.publish = AsyncMock()
        mock_redis.close = AsyncMock()

        consumer = TaskConsumer(
            redis_url="redis://localhost:6379",
            handler=AsyncMock(return_value={"answer": 42}),
        )
        consumer._redis = mock_redis
        consumer._semaphore = asyncio.Semaphore(10)

        task = TaskMessage(
            task_id="pub_task",
            session_id="pub_session",
            agent_id="agent",
            org_id="org",
            messages=[],
        )

        await consumer._process_task(task)

        mock_redis.publish.assert_called_once()
        call_args = mock_redis.publish.call_args

        assert call_args[0][0] == "agent:results:pub_session"
        message = json.loads(call_args[0][1])
        assert message["task_id"] == "pub_task"
        assert message["result"] == {"answer": 42}

    @pytest.mark.asyncio
    async def test_error_result_published_on_failure(self):
        """Test that error result is published on failed processing."""
        mock_redis = AsyncMock()
        mock_redis.publish = AsyncMock()
        mock_redis.lpush = AsyncMock()
        mock_redis.close = AsyncMock()

        consumer = TaskConsumer(
            redis_url="redis://localhost:6379",
            handler=AsyncMock(side_effect=Exception("Processing failed")),
            max_retry_attempts=0,  # No retries
        )
        consumer._redis = mock_redis
        consumer._semaphore = asyncio.Semaphore(10)

        task = TaskMessage(
            task_id="error_task",
            session_id="error_session",
            agent_id="agent",
            org_id="org",
            messages=[],
        )

        await consumer._process_task(task)

        # Should have published error result
        publish_calls = mock_redis.publish.call_args_list
        assert len(publish_calls) >= 1

        last_publish = publish_calls[-1]
        message = json.loads(last_publish[0][1])
        assert "error" in message["result"]
        assert "Processing failed" in message["result"]["error"]
