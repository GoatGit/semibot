"""Tests for TaskProducer."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tests.queue.conftest import QueueFullError, TaskPayload, TaskProducer


@pytest.fixture
def mock_redis():
    """Create a mock Redis client."""
    mock = AsyncMock()
    mock.llen = AsyncMock(return_value=0)
    mock.lpush = AsyncMock()
    mock.delete = AsyncMock()
    mock.close = AsyncMock()
    mock.pubsub = MagicMock()
    return mock


@pytest.fixture
def producer():
    """Create a TaskProducer instance."""
    return TaskProducer(
        redis_url="redis://localhost:6379",
        queue_name="test:queue",
        max_queue_length=100,
    )


class TestTaskProducerInit:
    """Tests for TaskProducer initialization."""

    def test_default_values(self):
        """Test default configuration values."""
        producer = TaskProducer(redis_url="redis://localhost:6379")

        assert producer.redis_url == "redis://localhost:6379"
        assert producer.queue_name == "agent:tasks"
        assert producer.result_channel_prefix == "agent:results"
        assert producer.max_queue_length == 10000

    def test_custom_values(self):
        """Test custom configuration values."""
        producer = TaskProducer(
            redis_url="redis://custom:6380",
            queue_name="custom:queue",
            result_channel_prefix="custom:results",
            max_queue_length=500,
        )

        assert producer.redis_url == "redis://custom:6380"
        assert producer.queue_name == "custom:queue"
        assert producer.result_channel_prefix == "custom:results"
        assert producer.max_queue_length == 500


class TestTaskProducerConnect:
    """Tests for connect/disconnect."""

    @pytest.mark.asyncio
    async def test_connect(self, producer):
        """Test Redis connection."""
        with patch("src.queue.producer.redis.from_url") as mock_from_url:
            mock_client = AsyncMock()
            mock_from_url.return_value = mock_client

            await producer.connect()

            mock_from_url.assert_called_once()
            assert producer._redis is mock_client

    @pytest.mark.asyncio
    async def test_connect_only_once(self, producer):
        """Test that connect is idempotent."""
        with patch("src.queue.producer.redis.from_url") as mock_from_url:
            mock_client = AsyncMock()
            mock_from_url.return_value = mock_client

            await producer.connect()
            await producer.connect()

            # Should only be called once
            assert mock_from_url.call_count == 1

    @pytest.mark.asyncio
    async def test_disconnect(self, producer, mock_redis):
        """Test Redis disconnection."""
        producer._redis = mock_redis

        await producer.disconnect()

        mock_redis.close.assert_called_once()
        assert producer._redis is None

    @pytest.mark.asyncio
    async def test_disconnect_with_pubsub(self, producer, mock_redis):
        """Test disconnection closes pubsub."""
        mock_pubsub = AsyncMock()
        producer._redis = mock_redis
        producer._pubsub = mock_pubsub

        await producer.disconnect()

        mock_pubsub.close.assert_called_once()
        assert producer._pubsub is None


class TestTaskProducerEnqueue:
    """Tests for enqueue method."""

    @pytest.mark.asyncio
    async def test_enqueue_success(self, producer, mock_redis):
        """Test successful task enqueue."""
        producer._redis = mock_redis

        payload = TaskPayload(
            session_id="sess_123",
            agent_id="agent_456",
            org_id="org_789",
            messages=[{"role": "user", "content": "Hello"}],
            task_id="task_001",
        )

        task_id = await producer.enqueue(payload)

        assert task_id == "task_001"
        mock_redis.lpush.assert_called_once()

        # Verify the pushed data
        call_args = mock_redis.lpush.call_args
        pushed_data = json.loads(call_args[0][1])
        assert pushed_data["task_id"] == "task_001"
        assert pushed_data["session_id"] == "sess_123"
        assert "enqueued_at" in pushed_data["metadata"]

    @pytest.mark.asyncio
    async def test_enqueue_auto_connects(self, producer):
        """Test that enqueue auto-connects if not connected."""
        with patch("src.queue.producer.redis.from_url") as mock_from_url:
            mock_client = AsyncMock()
            mock_client.llen = AsyncMock(return_value=0)
            mock_client.lpush = AsyncMock()
            mock_from_url.return_value = mock_client

            payload = TaskPayload(
                session_id="sess_123",
                agent_id="agent_456",
                org_id="org_789",
                messages=[],
            )

            await producer.enqueue(payload)

            mock_from_url.assert_called_once()

    @pytest.mark.asyncio
    async def test_enqueue_queue_full_error(self, producer, mock_redis):
        """Test QueueFullError when queue is at capacity."""
        mock_redis.llen = AsyncMock(return_value=100)  # At max capacity
        producer._redis = mock_redis

        payload = TaskPayload(
            session_id="sess_123",
            agent_id="agent_456",
            org_id="org_789",
            messages=[],
        )

        with pytest.raises(QueueFullError) as exc_info:
            await producer.enqueue(payload)

        assert "Queue length exceeded" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_enqueue_warning_threshold(self, producer, mock_redis, caplog):
        """Test warning log when queue approaches capacity."""
        mock_redis.llen = AsyncMock(return_value=5000)  # At warning threshold
        producer._redis = mock_redis
        producer.max_queue_length = 10000

        payload = TaskPayload(
            session_id="sess_123",
            agent_id="agent_456",
            org_id="org_789",
            messages=[],
        )

        import logging

        with caplog.at_level(logging.WARNING):
            await producer.enqueue(payload)

        assert "队列积压严重" in caplog.text


class TestTaskProducerQueueOperations:
    """Tests for queue length and clear operations."""

    @pytest.mark.asyncio
    async def test_get_queue_length(self, producer, mock_redis):
        """Test getting queue length."""
        mock_redis.llen = AsyncMock(return_value=42)
        producer._redis = mock_redis

        length = await producer.get_queue_length()

        assert length == 42
        mock_redis.llen.assert_called_once_with("test:queue")

    @pytest.mark.asyncio
    async def test_get_queue_length_not_connected(self, producer):
        """Test get_queue_length returns 0 when connection fails."""
        with patch("src.queue.producer.redis.from_url") as mock_from_url:
            mock_from_url.side_effect = Exception("Connection failed")

            # Should not raise, just return 0
            producer._redis = None

            with patch.object(producer, "connect", new_callable=AsyncMock):
                length = await producer.get_queue_length()
                assert length == 0

    @pytest.mark.asyncio
    async def test_clear_queue(self, producer, mock_redis):
        """Test clearing the queue."""
        mock_redis.llen = AsyncMock(return_value=10)
        producer._redis = mock_redis

        count = await producer.clear_queue()

        assert count == 10
        mock_redis.delete.assert_called_once_with("test:queue")


class TestTaskProducerWaitForResult:
    """Tests for wait_for_result method."""

    @pytest.mark.asyncio
    async def test_wait_for_result_success(self, producer, mock_redis):
        """Test receiving a result via pub/sub."""
        mock_pubsub = AsyncMock()
        mock_pubsub.subscribe = AsyncMock()
        mock_pubsub.unsubscribe = AsyncMock()
        mock_pubsub.close = AsyncMock()
        mock_pubsub.get_message = AsyncMock(
            return_value={
                "type": "message",
                "data": json.dumps({"result": {"status": "success"}}),
            }
        )
        mock_redis.pubsub = MagicMock(return_value=mock_pubsub)
        producer._redis = mock_redis

        result = await producer.wait_for_result("sess_123", timeout=5)

        assert result == {"status": "success"}
        mock_pubsub.subscribe.assert_called_once_with("agent:results:sess_123")

    @pytest.mark.asyncio
    async def test_wait_for_result_timeout(self, producer, mock_redis):
        """Test timeout waiting for result."""
        mock_pubsub = AsyncMock()
        mock_pubsub.subscribe = AsyncMock()
        mock_pubsub.unsubscribe = AsyncMock()
        mock_pubsub.close = AsyncMock()
        mock_pubsub.get_message = AsyncMock(return_value=None)
        mock_redis.pubsub = MagicMock(return_value=mock_pubsub)
        producer._redis = mock_redis

        result = await producer.wait_for_result("sess_123", timeout=0.1)

        assert result is None
