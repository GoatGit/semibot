"""Queue configuration constants.

All magic numbers and hardcoded values for the queue module should be defined here.
"""

# =============================================================================
# Queue Names
# =============================================================================

DEFAULT_QUEUE_NAME = "agent:tasks"
"""Default Redis queue name for agent tasks."""

RESULT_CHANNEL_PREFIX = "agent:results"
"""Prefix for Redis pub/sub result channels."""

DEAD_LETTER_QUEUE = "agent:tasks:dead"
"""Dead letter queue for failed tasks."""

# =============================================================================
# Concurrency & Timeouts
# =============================================================================

MAX_CONCURRENT_TASKS = 10
"""Maximum number of concurrent task processing."""

QUEUE_POLL_TIMEOUT = 30
"""Queue poll timeout in seconds (BRPOP timeout)."""

RESULT_WAIT_TIMEOUT = 300
"""Maximum time to wait for task result in seconds."""

PUBSUB_MESSAGE_TIMEOUT = 1.0
"""Pub/sub message receive timeout in seconds."""

# =============================================================================
# Retry & Backoff
# =============================================================================

ERROR_RETRY_DELAY = 1
"""Initial delay in seconds before retrying after error."""

MAX_RECONNECT_DELAY = 60
"""Maximum delay in seconds for exponential backoff."""

MAX_RETRY_ATTEMPTS = 3
"""Maximum number of retry attempts for failed tasks."""

# =============================================================================
# Backpressure Control
# =============================================================================

MAX_QUEUE_LENGTH = 10000
"""Maximum queue length before rejecting new tasks (backpressure)."""

QUEUE_LENGTH_WARNING_THRESHOLD = 5000
"""Queue length threshold for warning logs."""
