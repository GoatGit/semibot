"""Redis Task Consumer.

Consumes tasks from Redis queue and executes agents.
"""

import asyncio
import json
import signal
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

import redis.asyncio as redis

from src.constants.config import (
    DEAD_LETTER_QUEUE,
    DEFAULT_QUEUE_NAME,
    ERROR_RETRY_DELAY,
    MAX_CONCURRENT_TASKS,
    MAX_RECONNECT_DELAY,
    MAX_RETRY_ATTEMPTS,
    QUEUE_POLL_TIMEOUT,
    RESULT_CHANNEL_PREFIX,
)
from src.utils.logging import get_logger

logger = get_logger(__name__)


@dataclass
class TaskMessage:
    """Represents a task message from the queue."""

    task_id: str
    session_id: str
    agent_id: str
    org_id: str
    messages: list[dict[str, str]]
    config: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TaskMessage":
        """Create TaskMessage from dictionary."""
        return cls(
            task_id=data.get("task_id", ""),
            session_id=data.get("session_id", ""),
            agent_id=data.get("agent_id", ""),
            org_id=data.get("org_id", ""),
            messages=data.get("messages", []),
            config=data.get("config", {}),
            metadata=data.get("metadata", {}),
        )

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


class TaskConsumer:
    """
    Redis task queue consumer.

    Listens for tasks on a Redis queue and processes them using
    a provided handler function.

    Example:
        ```python
        async def handle_task(task: TaskMessage) -> dict:
            # Process the task
            result = await run_agent(task)
            return result

        consumer = TaskConsumer(
            redis_url="redis://localhost:6379",
            queue_name="agent:tasks",
            handler=handle_task,
        )

        await consumer.start()
        ```
    """

    def __init__(
        self,
        redis_url: str,
        queue_name: str = DEFAULT_QUEUE_NAME,
        handler: Callable[[TaskMessage], Any] | None = None,
        result_channel_prefix: str = RESULT_CHANNEL_PREFIX,
        max_concurrent: int = MAX_CONCURRENT_TASKS,
        poll_timeout: int = QUEUE_POLL_TIMEOUT,
        dead_letter_queue: str = DEAD_LETTER_QUEUE,
        max_retry_attempts: int = MAX_RETRY_ATTEMPTS,
    ):
        """
        Initialize the task consumer.

        Args:
            redis_url: Redis connection URL
            queue_name: Name of the task queue
            handler: Async function to handle tasks
            result_channel_prefix: Prefix for result pub/sub channels
            max_concurrent: Maximum concurrent task processing
            poll_timeout: Queue poll timeout in seconds
            dead_letter_queue: Queue name for failed tasks
            max_retry_attempts: Maximum retry attempts before dead letter
        """
        self.redis_url = redis_url
        self.queue_name = queue_name
        self.handler = handler
        self.result_channel_prefix = result_channel_prefix
        self.max_concurrent = max_concurrent
        self.poll_timeout = poll_timeout
        self.dead_letter_queue = dead_letter_queue
        self.max_retry_attempts = max_retry_attempts

        self._redis: redis.Redis | None = None
        self._running = False
        self._semaphore: asyncio.Semaphore | None = None
        self._tasks: set[asyncio.Task[Any]] = set()
        self._reconnect_attempt = 0

    async def connect(self) -> None:
        """Connect to Redis."""
        if self._redis is None:
            self._redis = redis.from_url(
                self.redis_url,
                encoding="utf-8",
                decode_responses=True,
            )
            self._reconnect_attempt = 0
            logger.info(f"[Consumer] Connected to Redis: {self.redis_url}")

    async def disconnect(self) -> None:
        """Disconnect from Redis."""
        if self._redis:
            await self._redis.close()
            self._redis = None
            logger.info("[Consumer] Disconnected from Redis")

    async def _reconnect_with_backoff(self) -> bool:
        """
        Reconnect to Redis with exponential backoff.

        Returns:
            True if reconnected successfully, False otherwise
        """
        self._reconnect_attempt += 1
        delay = min(
            ERROR_RETRY_DELAY * (2 ** (self._reconnect_attempt - 1)),
            MAX_RECONNECT_DELAY,
        )

        logger.warning(
            f"[Consumer] 连接失败，{delay}秒后重试 "
            f"(尝试: {self._reconnect_attempt})"
        )

        await asyncio.sleep(delay)

        try:
            if self._redis:
                await self._redis.close()
                self._redis = None
            await self.connect()
            return True
        except Exception as e:
            logger.error(f"[Consumer] Reconnection failed: {e}")
            return False

    async def start(self) -> None:
        """
        Start consuming tasks from the queue.

        This method runs indefinitely until stop() is called.
        """
        await self.connect()

        self._running = True
        self._semaphore = asyncio.Semaphore(self.max_concurrent)

        # Setup signal handlers
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, lambda: asyncio.create_task(self.stop()))

        logger.info(f"[Consumer] Starting task consumer on queue: {self.queue_name}")

        while self._running:
            try:
                await self._poll_and_process()
            except asyncio.CancelledError:
                break
            except redis.ConnectionError:
                await self._reconnect_with_backoff()
            except Exception as e:
                logger.error(f"[Consumer] Error in consumer loop: {e}")
                await asyncio.sleep(ERROR_RETRY_DELAY)

        # Wait for pending tasks
        if self._tasks:
            logger.info(f"[Consumer] Waiting for {len(self._tasks)} pending tasks...")
            await asyncio.gather(*self._tasks, return_exceptions=True)

        await self.disconnect()
        logger.info("[Consumer] Task consumer stopped")

    async def stop(self) -> None:
        """Stop the consumer gracefully."""
        logger.info("[Consumer] Stopping task consumer...")
        self._running = False

    async def _poll_and_process(self) -> None:
        """Poll for a task and process it."""
        if not self._redis:
            return

        # Check if at concurrency limit and log
        if self._semaphore and self._semaphore.locked():
            logger.warning(
                f"[Consumer] 并发数已达上限，等待空闲槽位 "
                f"(限制: {self.max_concurrent})"
            )

        # Wait for semaphore
        if self._semaphore:
            await self._semaphore.acquire()

        try:
            # Blocking pop from queue
            result = await self._redis.brpop(
                self.queue_name,
                timeout=self.poll_timeout,
            )

            if result is None:
                # Timeout, no task available
                if self._semaphore:
                    self._semaphore.release()
                return

            _, task_data = result

            # Parse task
            try:
                data = json.loads(task_data)
                task = TaskMessage.from_dict(data)
            except json.JSONDecodeError as e:
                logger.error(f"[Consumer] Invalid task JSON: {e}")
                if self._semaphore:
                    self._semaphore.release()
                return

            # Process task in background
            task_coro = self._process_task(task)
            asyncio_task = asyncio.create_task(task_coro)
            self._tasks.add(asyncio_task)
            asyncio_task.add_done_callback(self._tasks.discard)

        except Exception as e:
            logger.error(f"[Consumer] Error polling queue: {e}")
            if self._semaphore:
                self._semaphore.release()
            raise

    async def _process_task(self, task: TaskMessage) -> None:
        """Process a single task."""
        logger.info(
            f"[Consumer] Processing task: {task.task_id}",
            extra={"session_id": task.session_id, "agent_id": task.agent_id},
        )

        try:
            if self.handler:
                result = await self.handler(task)
            else:
                result = {"error": "No handler configured"}

            # Publish result
            await self._publish_result(task, result)

            logger.info(f"[Consumer] Task completed: {task.task_id}")

        except Exception as e:
            logger.error(f"[Consumer] Task {task.task_id} failed: {e}")

            # Check retry count
            retry_count = task.metadata.get("retry_count", 0)
            if retry_count < self.max_retry_attempts:
                # Retry task
                await self._retry_task(task, str(e))
            else:
                # Move to dead letter queue
                await self._move_to_dead_letter(task, str(e))

            await self._publish_result(task, {"error": str(e)})

        finally:
            if self._semaphore:
                self._semaphore.release()

    async def _retry_task(self, task: TaskMessage, error: str) -> None:
        """
        Re-enqueue a failed task for retry.

        Args:
            task: The failed task
            error: Error message
        """
        if not self._redis:
            return

        retry_count = task.metadata.get("retry_count", 0) + 1
        task.metadata["retry_count"] = retry_count
        task.metadata["last_error"] = error
        task.metadata["last_retry_at"] = datetime.now(timezone.utc).isoformat()

        task_data = json.dumps(task.to_dict())
        await self._redis.lpush(self.queue_name, task_data)

        logger.warning(
            f"[Consumer] 任务重试 (task_id: {task.task_id}, "
            f"retry_count: {retry_count}/{self.max_retry_attempts})"
        )

    async def _move_to_dead_letter(self, task: TaskMessage, error: str) -> None:
        """
        Move a failed task to the dead letter queue.

        Args:
            task: The failed task
            error: Error message
        """
        if not self._redis:
            return

        dead_task = {
            **task.to_dict(),
            "error": error,
            "failed_at": datetime.now(timezone.utc).isoformat(),
            "retry_count": task.metadata.get("retry_count", 0),
        }

        await self._redis.lpush(self.dead_letter_queue, json.dumps(dead_task))

        logger.error(
            f"[Consumer] 任务移入死信队列 (task_id: {task.task_id}, "
            f"error: {error}, retry_count: {dead_task['retry_count']})"
        )

    async def _publish_result(
        self,
        task: TaskMessage,
        result: dict[str, Any],
    ) -> None:
        """Publish task result to Redis pub/sub."""
        if not self._redis:
            return

        channel = f"{self.result_channel_prefix}:{task.session_id}"
        message = json.dumps({
            "task_id": task.task_id,
            "session_id": task.session_id,
            "result": result,
        })

        await self._redis.publish(channel, message)
        logger.debug(f"[Consumer] Published result to {channel}")

    # =========================================================================
    # Dead Letter Queue Management
    # =========================================================================

    async def get_dead_letter_count(self) -> int:
        """
        Get the number of tasks in dead letter queue.

        Returns:
            Number of dead letter tasks
        """
        if not self._redis:
            await self.connect()

        if not self._redis:
            return 0

        return await self._redis.llen(self.dead_letter_queue)

    async def get_dead_letters(
        self, start: int = 0, count: int = 100
    ) -> list[dict[str, Any]]:
        """
        Get tasks from dead letter queue.

        Args:
            start: Start index
            count: Number of tasks to retrieve

        Returns:
            List of dead letter tasks
        """
        if not self._redis:
            await self.connect()

        if not self._redis:
            return []

        items = await self._redis.lrange(
            self.dead_letter_queue, start, start + count - 1
        )
        return [json.loads(item) for item in items]

    async def retry_dead_letter(self, task_id: str) -> bool:
        """
        Retry a specific task from dead letter queue.

        Args:
            task_id: Task ID to retry

        Returns:
            True if task was found and re-queued
        """
        if not self._redis:
            await self.connect()

        if not self._redis:
            return False

        # Get all dead letters
        items = await self._redis.lrange(self.dead_letter_queue, 0, -1)

        for i, item in enumerate(items):
            data = json.loads(item)
            if data.get("task_id") == task_id:
                # Remove from dead letter queue
                await self._redis.lrem(self.dead_letter_queue, 1, item)

                # Reset retry count and re-queue
                data["metadata"]["retry_count"] = 0
                data.pop("error", None)
                data.pop("failed_at", None)

                await self._redis.lpush(self.queue_name, json.dumps(data))

                logger.info(f"[Consumer] 死信任务重试 (task_id: {task_id})")
                return True

        return False

    async def clear_dead_letters(self) -> int:
        """
        Clear all tasks from dead letter queue.

        Returns:
            Number of tasks cleared
        """
        if not self._redis:
            await self.connect()

        if not self._redis:
            return 0

        count = await self._redis.llen(self.dead_letter_queue)
        await self._redis.delete(self.dead_letter_queue)

        logger.warning(f"[Consumer] Cleared {count} tasks from dead letter queue")
        return count


async def run_worker(
    redis_url: str,
    handler: Callable[[TaskMessage], Any],
    queue_name: str = DEFAULT_QUEUE_NAME,
) -> None:
    """
    Convenience function to run a worker.

    Args:
        redis_url: Redis connection URL
        handler: Task handler function
        queue_name: Queue name to consume from
    """
    consumer = TaskConsumer(
        redis_url=redis_url,
        queue_name=queue_name,
        handler=handler,
    )
    await consumer.start()
