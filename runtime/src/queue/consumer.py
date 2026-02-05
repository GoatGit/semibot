"""Redis Task Consumer.

Consumes tasks from Redis queue and executes agents.
"""

import asyncio
import json
import logging
import signal
from dataclasses import dataclass
from typing import Any, Callable

import redis.asyncio as redis

logger = logging.getLogger(__name__)


@dataclass
class TaskMessage:
    """Represents a task message from the queue."""

    task_id: str
    session_id: str
    agent_id: str
    org_id: str
    messages: list[dict[str, str]]
    config: dict[str, Any]
    metadata: dict[str, Any]

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
        queue_name: str = "agent:tasks",
        handler: Callable[[TaskMessage], Any] | None = None,
        result_channel_prefix: str = "agent:results",
        max_concurrent: int = 10,
        poll_timeout: int = 30,
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
        """
        self.redis_url = redis_url
        self.queue_name = queue_name
        self.handler = handler
        self.result_channel_prefix = result_channel_prefix
        self.max_concurrent = max_concurrent
        self.poll_timeout = poll_timeout

        self._redis: redis.Redis | None = None
        self._running = False
        self._semaphore: asyncio.Semaphore | None = None
        self._tasks: set[asyncio.Task[Any]] = set()

    async def connect(self) -> None:
        """Connect to Redis."""
        if self._redis is None:
            self._redis = redis.from_url(
                self.redis_url,
                encoding="utf-8",
                decode_responses=True,
            )
            logger.info(f"Connected to Redis: {self.redis_url}")

    async def disconnect(self) -> None:
        """Disconnect from Redis."""
        if self._redis:
            await self._redis.close()
            self._redis = None
            logger.info("Disconnected from Redis")

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

        logger.info(f"Starting task consumer on queue: {self.queue_name}")

        while self._running:
            try:
                await self._poll_and_process()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in consumer loop: {e}")
                await asyncio.sleep(1)

        # Wait for pending tasks
        if self._tasks:
            logger.info(f"Waiting for {len(self._tasks)} pending tasks...")
            await asyncio.gather(*self._tasks, return_exceptions=True)

        await self.disconnect()
        logger.info("Task consumer stopped")

    async def stop(self) -> None:
        """Stop the consumer gracefully."""
        logger.info("Stopping task consumer...")
        self._running = False

    async def _poll_and_process(self) -> None:
        """Poll for a task and process it."""
        if not self._redis:
            return

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
                logger.error(f"Invalid task JSON: {e}")
                if self._semaphore:
                    self._semaphore.release()
                return

            # Process task in background
            task_coro = self._process_task(task)
            asyncio_task = asyncio.create_task(task_coro)
            self._tasks.add(asyncio_task)
            asyncio_task.add_done_callback(self._tasks.discard)

        except Exception as e:
            logger.error(f"Error polling queue: {e}")
            if self._semaphore:
                self._semaphore.release()

    async def _process_task(self, task: TaskMessage) -> None:
        """Process a single task."""
        logger.info(
            f"Processing task: {task.task_id}",
            extra={"session_id": task.session_id, "agent_id": task.agent_id},
        )

        try:
            if self.handler:
                result = await self.handler(task)
            else:
                result = {"error": "No handler configured"}

            # Publish result
            await self._publish_result(task, result)

            logger.info(f"Task completed: {task.task_id}")

        except Exception as e:
            logger.error(f"Task {task.task_id} failed: {e}")
            await self._publish_result(task, {"error": str(e)})

        finally:
            if self._semaphore:
                self._semaphore.release()

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
        logger.debug(f"Published result to {channel}")


async def run_worker(
    redis_url: str,
    handler: Callable[[TaskMessage], Any],
    queue_name: str = "agent:tasks",
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
