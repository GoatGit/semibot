"""Redis Task Producer.

Produces tasks to Redis queue for async processing.
"""

import json
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any

import redis.asyncio as redis

logger = logging.getLogger(__name__)


@dataclass
class TaskPayload:
    """Payload for a task to be queued."""

    session_id: str
    agent_id: str
    org_id: str
    messages: list[dict[str, str]]
    config: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)
    task_id: str = field(default_factory=lambda: str(uuid.uuid4()))

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "task_id": self.task_id,
            "session_id": self.session_id,
            "agent_id": self.agent_id,
            "org_id": self.org_id,
            "messages": self.messages,
            "config": self.config,
            "metadata": self.metadata,
        }


class TaskProducer:
    """
    Redis task queue producer.

    Pushes tasks to a Redis queue for async processing by workers.

    Example:
        ```python
        producer = TaskProducer(redis_url="redis://localhost:6379")
        await producer.connect()

        task_id = await producer.enqueue(TaskPayload(
            session_id="sess_123",
            agent_id="agent_456",
            org_id="org_789",
            messages=[{"role": "user", "content": "Hello"}],
        ))

        # Listen for result
        result = await producer.wait_for_result(task_id, timeout=300)
        ```
    """

    def __init__(
        self,
        redis_url: str,
        queue_name: str = "agent:tasks",
        result_channel_prefix: str = "agent:results",
    ):
        """
        Initialize the task producer.

        Args:
            redis_url: Redis connection URL
            queue_name: Name of the task queue
            result_channel_prefix: Prefix for result pub/sub channels
        """
        self.redis_url = redis_url
        self.queue_name = queue_name
        self.result_channel_prefix = result_channel_prefix
        self._redis: redis.Redis | None = None
        self._pubsub: redis.client.PubSub | None = None

    async def connect(self) -> None:
        """Connect to Redis."""
        if self._redis is None:
            self._redis = redis.from_url(
                self.redis_url,
                encoding="utf-8",
                decode_responses=True,
            )
            logger.info(f"Producer connected to Redis: {self.redis_url}")

    async def disconnect(self) -> None:
        """Disconnect from Redis."""
        if self._pubsub:
            await self._pubsub.close()
            self._pubsub = None
        if self._redis:
            await self._redis.close()
            self._redis = None
            logger.info("Producer disconnected from Redis")

    async def enqueue(self, payload: TaskPayload) -> str:
        """
        Enqueue a task for processing.

        Args:
            payload: Task payload

        Returns:
            Task ID
        """
        if not self._redis:
            await self.connect()

        if not self._redis:
            raise RuntimeError("Failed to connect to Redis")

        task_data = json.dumps(payload.to_dict())

        # Push to queue (LPUSH for FIFO with BRPOP)
        await self._redis.lpush(self.queue_name, task_data)

        logger.info(
            f"Enqueued task: {payload.task_id}",
            extra={
                "session_id": payload.session_id,
                "agent_id": payload.agent_id,
            },
        )

        return payload.task_id

    async def wait_for_result(
        self,
        session_id: str,
        timeout: int = 300,
    ) -> dict[str, Any] | None:
        """
        Wait for a task result via pub/sub.

        Args:
            session_id: Session ID to wait for
            timeout: Timeout in seconds

        Returns:
            Result dictionary or None if timeout
        """
        if not self._redis:
            await self.connect()

        if not self._redis:
            raise RuntimeError("Failed to connect to Redis")

        channel = f"{self.result_channel_prefix}:{session_id}"

        # Create pubsub
        pubsub = self._redis.pubsub()
        await pubsub.subscribe(channel)

        try:
            import asyncio

            start_time = asyncio.get_event_loop().time()

            while True:
                # Check timeout
                elapsed = asyncio.get_event_loop().time() - start_time
                if elapsed >= timeout:
                    logger.warning(f"Timeout waiting for result: {session_id}")
                    return None

                # Get message
                message = await pubsub.get_message(
                    ignore_subscribe_messages=True,
                    timeout=1.0,
                )

                if message and message["type"] == "message":
                    data = json.loads(message["data"])
                    return data.get("result")

        finally:
            await pubsub.unsubscribe(channel)
            await pubsub.close()

    async def get_queue_length(self) -> int:
        """
        Get the current queue length.

        Returns:
            Number of tasks in queue
        """
        if not self._redis:
            await self.connect()

        if not self._redis:
            return 0

        return await self._redis.llen(self.queue_name)

    async def clear_queue(self) -> int:
        """
        Clear all tasks from the queue.

        Returns:
            Number of tasks cleared
        """
        if not self._redis:
            await self.connect()

        if not self._redis:
            return 0

        length = await self._redis.llen(self.queue_name)
        await self._redis.delete(self.queue_name)

        logger.warning(f"Cleared {length} tasks from queue")
        return length


async def enqueue_task(
    redis_url: str,
    session_id: str,
    agent_id: str,
    org_id: str,
    messages: list[dict[str, str]],
    config: dict[str, Any] | None = None,
) -> str:
    """
    Convenience function to enqueue a single task.

    Args:
        redis_url: Redis connection URL
        session_id: Session identifier
        agent_id: Agent identifier
        org_id: Organization identifier
        messages: Chat messages
        config: Optional agent config

    Returns:
        Task ID
    """
    producer = TaskProducer(redis_url=redis_url)

    try:
        await producer.connect()
        task_id = await producer.enqueue(
            TaskPayload(
                session_id=session_id,
                agent_id=agent_id,
                org_id=org_id,
                messages=messages,
                config=config or {},
            )
        )
        return task_id
    finally:
        await producer.disconnect()
