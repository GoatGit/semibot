"""Configuration constants for the runtime module.

All magic numbers and hardcoded values should be defined here.
Includes constants for: Queue, Memory, LLM, Orchestrator modules.
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

# =============================================================================
# Short-term Memory (Redis)
# =============================================================================

DEFAULT_TTL_SECONDS = 3600
"""Default TTL for short-term memory entries (1 hour)."""

MAX_SESSION_ENTRIES = 100
"""Maximum number of entries per session in short-term memory."""

REDIS_KEY_PREFIX = "semibot:memory:short_term"
"""Redis key prefix for short-term memory."""

REDIS_MAX_RETRIES = 3
"""Maximum retries for Redis connection."""

REDIS_RETRY_DELAY_BASE = 1
"""Base delay in seconds for Redis retry exponential backoff."""

REDIS_RETRY_DELAY_MAX = 10
"""Maximum delay in seconds for Redis retry exponential backoff."""

# =============================================================================
# Long-term Memory (PostgreSQL + pgvector)
# =============================================================================

DEFAULT_SEARCH_LIMIT = 5
"""Default number of results for memory search."""

MAX_SEARCH_LIMIT = 100
"""Maximum number of results for memory search."""

DEFAULT_MIN_SIMILARITY = 0.7
"""Default minimum similarity threshold for vector search."""

EMBEDDING_DIMENSION = 1536
"""Vector embedding dimension (OpenAI text-embedding-ada-002)."""

PG_POOL_MIN_SIZE = 2
"""Minimum PostgreSQL connection pool size."""

PG_POOL_MAX_SIZE = 10
"""Maximum PostgreSQL connection pool size."""

PG_POOL_ACQUIRE_TIMEOUT = 30
"""Timeout in seconds for acquiring a PostgreSQL connection."""

PG_MAX_RETRIES = 3
"""Maximum retries for PostgreSQL connection."""

PG_RETRY_DELAY_BASE = 1
"""Base delay in seconds for PostgreSQL retry exponential backoff."""

PG_RETRY_DELAY_MAX = 10
"""Maximum delay in seconds for PostgreSQL retry exponential backoff."""

# =============================================================================
# Embedding Service
# =============================================================================

DEFAULT_EMBEDDING_MODEL = "text-embedding-ada-002"
"""Default OpenAI embedding model."""

EMBEDDING_BATCH_SIZE = 100
"""Maximum batch size for embedding requests."""

EMBEDDING_CACHE_PREFIX = "semibot:embedding:cache"
"""Redis key prefix for embedding cache."""

EMBEDDING_CACHE_TTL = 604800
"""Embedding cache TTL in seconds (7 days)."""

EMBEDDING_MAX_RETRIES = 3
"""Maximum retries for embedding API calls."""

EMBEDDING_REQUEST_TIMEOUT = 30
"""Timeout in seconds for embedding API requests."""

EMBEDDING_RETRY_DELAY_BASE = 1
"""Base delay in seconds for embedding retry exponential backoff."""

EMBEDDING_RETRY_DELAY_MAX = 10
"""Maximum delay in seconds for embedding retry exponential backoff."""

# =============================================================================
# LLM Provider
# =============================================================================

LLM_MAX_RETRIES = 3
"""Maximum retries for LLM API calls."""

LLM_RETRY_DELAY_BASE = 1
"""Base delay in seconds for LLM retry exponential backoff."""

LLM_RETRY_DELAY_MAX = 10
"""Maximum delay in seconds for LLM retry exponential backoff."""

DEFAULT_TASK_MODEL_ROUTING = {
    "planning": "gpt-4o",
    "execution": "gpt-4o-mini",
    "reflection": "gpt-4o-mini",
    "complex_reasoning": "claude-3-sonnet",
}
"""Default model routing for different task types."""

DEFAULT_LLM_MODEL = "gpt-4o"
"""Default LLM model for general tasks."""

DEFAULT_FALLBACK_MODEL = "gpt-4o-mini"
"""Default fallback model when primary fails."""

# =============================================================================
# Orchestrator
# =============================================================================

MAX_REPLAN_ATTEMPTS = 3
"""Maximum number of replan attempts after all actions fail."""

DEFAULT_MAX_ITERATIONS = 10
"""Default maximum iterations for agent execution."""

# =============================================================================
# Sandbox Security
# =============================================================================

SANDBOX_POOL_SIZE = 5
"""Default number of pre-warmed sandbox containers."""

SANDBOX_MAX_MEMORY_MB = 512
"""Default maximum memory per sandbox in MB."""

SANDBOX_MAX_CPU_CORES = 1.0
"""Default maximum CPU cores per sandbox."""

SANDBOX_DEFAULT_TIMEOUT = 30
"""Default execution timeout in seconds."""

SANDBOX_MAX_TIMEOUT = 300
"""Maximum allowed execution timeout in seconds."""

SANDBOX_DOCKER_IMAGE = "semibot/sandbox:latest"
"""Default Docker image for sandbox containers."""

SANDBOX_WORKING_DIR = "/workspace"
"""Default working directory inside sandbox."""

SANDBOX_NETWORK_MODE = "none"
"""Default network mode for sandbox (none = no network access)."""

SANDBOX_MAX_OUTPUT_SIZE = 10 * 1024 * 1024
"""Maximum output size in bytes (10MB)."""

SANDBOX_AUDIT_LOG_DIR = "/var/log/semibot/sandbox"
"""Directory for sandbox audit logs."""

SANDBOX_AUDIT_MAX_ENTRIES = 10000
"""Maximum in-memory audit log entries."""

SANDBOX_POLICY_FILE = "sandbox_policy.yaml"
"""Default sandbox policy configuration file."""

# High-risk tools that require sandbox execution
SANDBOX_REQUIRED_TOOLS = [
    "code_run",
    "shell_exec",
    "browser_automation",
    "file_write",
    "file_edit",
]
"""Tools that must execute in sandbox."""

# Low-risk tools that can bypass sandbox
SANDBOX_BYPASS_TOOLS = [
    "file_read",
    "search",
    "llm_call",
]
"""Tools that can execute without sandbox."""
