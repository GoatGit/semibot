"""Tests for TaskConsumer."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tests.queue.conftest import TaskConsumer, TaskMessage


@pytest.fixture
def mock_redis():
    """Create a mock Redis client."""
    mock = AsyncMock()
    mock.brpop = AsyncMock(return_value=None)
    mock.lpush = AsyncMock()
    mock.llen = AsyncMock(return_value=0)
    mock.lrange = AsyncMock(return_value=[])
    mock.lrem = AsyncMock()
    mock.delete = AsyncMock()
    mock.publish = AsyncMock()
    mock.close = AsyncMock()
    return mock


@pytest.fixture
def consumer():
    """Create a TaskConsumer instance."""
    return TaskConsumer(
        redis_url="redis://localhost:6379",
        queue_name="test:queue",
        max_concurrent=5,
        poll_timeout=1,
    )


@pytest.fixture
def sample_task_data():
    """Create sample task data."""
    return {
        "task_id": "task_001",
        "session_id": "sess_123",
        "agent_id": "agent_456",
        "org_id": "org_789",
        "messages": [{"role": "user", "content": "Hello"}],
        "config": {},
        "metadata": {},
    }


class TestTaskConsumerInit:
    """Tests for TaskConsumer initialization."""

    def test_default_values(self):
        """Test default configuration values."""
        consumer = TaskConsumer(redis_url="redis://localhost:6379")

        assert consumer.redis_url == "redis://localhost:6379"
        assert consumer.queue_name == "agent:tasks"
        assert consumer.result_channel_prefix == "agent:results"
        assert consumer.max_concurrent == 10
        assert consumer.poll_timeout == 30
        assert consumer.dead_letter_queue == "agent:tasks:dead"
        assert consumer.max_retry_attempts == 3

    def test_custom_values(self):
        """Test custom configuration values."""
        consumer = TaskConsumer(
            redis_url="redis://custom:6380",
            queue_name="custom:queue",
            max_concurrent=20,
            poll_timeout=60,
            dead_letter_queue="custom:dead",
            max_retry_attempts=5,
        )

        assert consumer.queue_name == "custom:queue"
        assert consumer.max_concurrent == 20
        assert consumer.poll_timeout == 60
        assert consumer.dead_letter_queue == "custom:dead"
        assert consumer.max_retry_attempts == 5


class TestTaskConsumerConnect:
    """Tests for connect/disconnect."""

    @pytest.mark.asyncio
    async def test_connect(self, consumer):
        """Test Redis connection."""
        with patch("src.queue.consumer.redis.from_url") as mock_from_url:
            mock_client = AsyncMock()
            mock_from_url.return_value = mock_client

            await consumer.connect()

            mock_from_url.assert_called_once()
            assert consumer._redis is mock_client
            assert consumer._reconnect_attempt == 0

    @pytest.mark.asyncio
    async def test_disconnect(self, consumer, mock_redis):
        """Test Redis disconnection."""
        consumer._redis = mock_redis

        await consumer.disconnect()

        mock_redis.close.assert_called_once()
        assert consumer._redis is None


class TestTaskConsumerProcessTask:
    """Tests for task processing."""

    @pytest.mark.asyncio
    async def test_process_task_success(self, consumer, mock_redis, sample_task_data):
        """Test successful task processing."""
        consumer._redis = mock_redis
        consumer._semaphore = asyncio.Semaphore(5)

        handler_result = {"status": "completed"}
        consumer.handler = AsyncMock(return_value=handler_result)

        task = TaskMessage.from_dict(sample_task_data)
        await consumer._process_task(task)

        consumer.handler.assert_called_once_with(task)
        mock_redis.publish.assert_called_once()

        # Verify published result
        call_args = mock_redis.publish.call_args
        channel = call_args[0][0]
        message = json.loads(call_args[0][1])

        assert channel == "agent:results:sess_123"
        assert message["result"] == {"status": "completed"}

    @pytest.mark.asyncio
    async def test_process_task_no_handler(self, consumer, mock_redis, sample_task_data):
        """Test task processing without handler configured."""
        consumer._redis = mock_redis
        consumer._semaphore = asyncio.Semaphore(5)
        consumer.handler = None

        task = TaskMessage.from_dict(sample_task_data)
        await consumer._process_task(task)

        # Should publish error result
        call_args = mock_redis.publish.call_args
        message = json.loads(call_args[0][1])
        assert message["result"] == {"error": "No handler configured"}

    @pytest.mark.asyncio
    async def test_process_task_handler_error_retry(
        self, consumer, mock_redis, sample_task_data
    ):
        """Test task retry on handler error."""
        consumer._redis = mock_redis
        consumer._semaphore = asyncio.Semaphore(5)
        consumer.handler = AsyncMock(side_effect=Exception("Handler failed"))
        consumer.max_retry_attempts = 3

        task = TaskMessage.from_dict(sample_task_data)
        task.metadata["retry_count"] = 0

        await consumer._process_task(task)

        # Should re-enqueue for retry
        mock_redis.lpush.assert_called_once()
        call_args = mock_redis.lpush.call_args
        assert call_args[0][0] == "test:queue"

        requeued_data = json.loads(call_args[0][1])
        assert requeued_data["metadata"]["retry_count"] == 1
        assert requeued_data["metadata"]["last_error"] == "Handler failed"

    @pytest.mark.asyncio
    async def test_process_task_move_to_dead_letter(
        self, consumer, mock_redis, sample_task_data
    ):
        """Test moving task to dead letter queue after max retries."""
        consumer._redis = mock_redis
        consumer._semaphore = asyncio.Semaphore(5)
        consumer.handler = AsyncMock(side_effect=Exception("Handler failed"))
        consumer.max_retry_attempts = 3

        task = TaskMessage.from_dict(sample_task_data)
        task.metadata["retry_count"] = 3  # Already at max retries

        await consumer._process_task(task)

        # Should push to dead letter queue, not regular queue
        lpush_calls = mock_redis.lpush.call_args_list

        # Find the dead letter push
        dead_letter_call = None
        for call in lpush_calls:
            if call[0][0] == "agent:tasks:dead":
                dead_letter_call = call
                break

        assert dead_letter_call is not None
        dead_data = json.loads(dead_letter_call[0][1])
        assert dead_data["error"] == "Handler failed"
        assert "failed_at" in dead_data


class TestTaskConsumerDeadLetterManagement:
    """Tests for dead letter queue management."""

    @pytest.mark.asyncio
    async def test_get_dead_letter_count(self, consumer, mock_redis):
        """Test getting dead letter count."""
        mock_redis.llen = AsyncMock(return_value=5)
        consumer._redis = mock_redis

        count = await consumer.get_dead_letter_count()

        assert count == 5
        mock_redis.llen.assert_called_once_with("agent:tasks:dead")

    @pytest.mark.asyncio
    async def test_get_dead_letters(self, consumer, mock_redis):
        """Test getting dead letter tasks."""
        dead_tasks = [
            json.dumps({"task_id": "task_001", "error": "Error 1"}),
            json.dumps({"task_id": "task_002", "error": "Error 2"}),
        ]
        mock_redis.lrange = AsyncMock(return_value=dead_tasks)
        consumer._redis = mock_redis

        result = await consumer.get_dead_letters(start=0, count=10)

        assert len(result) == 2
        assert result[0]["task_id"] == "task_001"
        assert result[1]["task_id"] == "task_002"

    @pytest.mark.asyncio
    async def test_retry_dead_letter(self, consumer, mock_redis):
        """Test retrying a dead letter task."""
        dead_task = json.dumps({
            "task_id": "task_001",
            "session_id": "sess_123",
            "agent_id": "agent_456",
            "org_id": "org_789",
            "messages": [],
            "config": {},
            "metadata": {"retry_count": 3},
            "error": "Previous error",
            "failed_at": "2026-02-06T00:00:00Z",
        })
        mock_redis.lrange = AsyncMock(return_value=[dead_task])
        consumer._redis = mock_redis

        success = await consumer.retry_dead_letter("task_001")

        assert success is True
        mock_redis.lrem.assert_called_once()
        mock_redis.lpush.assert_called_once()

        # Verify the requeued task has reset retry count
        call_args = mock_redis.lpush.call_args
        requeued_data = json.loads(call_args[0][1])
        assert requeued_data["metadata"]["retry_count"] == 0
        assert "error" not in requeued_data
        assert "failed_at" not in requeued_data

    @pytest.mark.asyncio
    async def test_retry_dead_letter_not_found(self, consumer, mock_redis):
        """Test retrying non-existent dead letter task."""
        mock_redis.lrange = AsyncMock(return_value=[])
        consumer._redis = mock_redis

        success = await consumer.retry_dead_letter("nonexistent")

        assert success is False

    @pytest.mark.asyncio
    async def test_clear_dead_letters(self, consumer, mock_redis):
        """Test clearing dead letter queue."""
        mock_redis.llen = AsyncMock(return_value=10)
        consumer._redis = mock_redis

        count = await consumer.clear_dead_letters()

        assert count == 10
        mock_redis.delete.assert_called_once_with("agent:tasks:dead")


class TestTaskConsumerReconnect:
    """Tests for reconnection with backoff."""

    @pytest.mark.asyncio
    async def test_reconnect_with_backoff(self, consumer):
        """Test exponential backoff on reconnection."""
        with patch("src.queue.consumer.redis.from_url") as mock_from_url:
            mock_client = AsyncMock()
            mock_from_url.return_value = mock_client

            with patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
                consumer._reconnect_attempt = 0

                await consumer._reconnect_with_backoff()

                # First attempt should wait 1 second
                mock_sleep.assert_called_once_with(1)
                assert consumer._reconnect_attempt == 1

    @pytest.mark.asyncio
    async def test_reconnect_backoff_max_delay(self, consumer):
        """Test backoff respects max delay."""
        with patch("src.queue.consumer.redis.from_url") as mock_from_url:
            mock_client = AsyncMock()
            mock_from_url.return_value = mock_client

            with patch("asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
                consumer._reconnect_attempt = 10  # Many attempts

                await consumer._reconnect_with_backoff()

                # Should cap at MAX_RECONNECT_DELAY (60 seconds)
                call_args = mock_sleep.call_args[0][0]
                assert call_args <= 60


class TestTaskConsumerPollAndProcess:
    """Tests for poll and process."""

    @pytest.mark.asyncio
    async def test_poll_no_task(self, consumer, mock_redis):
        """Test polling with no task available."""
        mock_redis.brpop = AsyncMock(return_value=None)
        consumer._redis = mock_redis
        consumer._semaphore = asyncio.Semaphore(5)

        await consumer._poll_and_process()

        mock_redis.brpop.assert_called_once()

    @pytest.mark.asyncio
    async def test_poll_invalid_json(self, consumer, mock_redis, caplog):
        """Test handling invalid JSON in queue."""
        mock_redis.brpop = AsyncMock(return_value=("queue", "invalid json"))
        consumer._redis = mock_redis
        consumer._semaphore = asyncio.Semaphore(5)

        import logging

        with caplog.at_level(logging.ERROR):
            await consumer._poll_and_process()

        assert "Invalid task JSON" in caplog.text

    @pytest.mark.asyncio
    async def test_poll_concurrent_limit_warning(self, consumer, mock_redis, caplog):
        """Test warning when at concurrent limit."""
        mock_redis.brpop = AsyncMock(return_value=None)
        consumer._redis = mock_redis

        # Create a locked semaphore
        consumer._semaphore = asyncio.Semaphore(1)
        await consumer._semaphore.acquire()  # Lock it

        import logging

        with caplog.at_level(logging.WARNING):
            # Start poll in background (will wait for semaphore)
            poll_task = asyncio.create_task(consumer._poll_and_process())

            # Give it time to log warning
            await asyncio.sleep(0.1)

            # Release semaphore to let poll complete
            consumer._semaphore.release()
            await poll_task

        assert "并发数已达上限" in caplog.text


class TestTaskConsumerStop:
    """Tests for graceful shutdown."""

    @pytest.mark.asyncio
    async def test_stop_sets_running_false(self, consumer):
        """Test that stop sets _running to False."""
        consumer._running = True

        await consumer.stop()

        assert consumer._running is False
