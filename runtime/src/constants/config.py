"""Configuration constants for the runtime module.

All magic numbers and hardcoded values should be defined here.
Includes constants for: Queue, Memory, LLM, Orchestrator modules.
"""

import os

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

DEFAULT_TTL_SECONDS = 0
"""Default TTL for short-term memory entries. 0 = no expiration (rely on MAX_SESSION_ENTRIES window)."""

MAX_SESSION_ENTRIES = 100
"""Maximum number of entries per session in short-term memory (sliding window)."""

REDIS_KEY_PREFIX = "semibot:memory:short_term"
"""Redis key prefix for short-term memory."""

REDIS_MAX_RETRIES = 3
"""Maximum retries for Redis connection."""

REDIS_RETRY_DELAY_BASE = 1
"""Base delay in seconds for Redis retry exponential backoff."""

REDIS_RETRY_DELAY_MAX = 10
"""Maximum delay in seconds for Redis retry exponential backoff."""

# =============================================================================
# Long-term Memory (SQLite + numpy cosine similarity)
# =============================================================================

DEFAULT_SEARCH_LIMIT = 5
"""Default number of results for memory search."""

MAX_SEARCH_LIMIT = 100
"""Maximum number of results for memory search."""

DEFAULT_MIN_SIMILARITY = 0.7
"""Default minimum similarity threshold for vector search."""

EMBEDDING_DIMENSION = 1536
"""Vector embedding dimension (OpenAI text-embedding-ada-002)."""

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

LLM_MAX_RETRIES = 2
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

REPLAN_RESULT_MAX_CHARS = 80000
"""Maximum characters per tool result when injecting into replan context."""

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

# Low-risk tools that can bypass sandbox
SANDBOX_BYPASS_TOOLS = [
    "file_read",
    "search",
    "llm_call",
]
"""Tools that can execute without sandbox."""

# =============================================================================
# Capability Graph
# =============================================================================

CAPABILITY_CACHE_TTL = 300
"""能力图缓存 TTL（秒）"""

MAX_SKILLS_PER_AGENT = 50
"""每个 Agent 最多绑定的 Skills 数量"""

MAX_MCP_SERVERS_PER_ORG = 20
"""每个组织最多的 MCP Servers 数量"""

# =============================================================================
# Audit Events
# =============================================================================

AUDIT_EVENT_BATCH_SIZE = 100
"""审计事件批量写入大小"""

AUDIT_EVENT_FLUSH_INTERVAL = 5
"""审计事件刷新间隔（秒）"""

AUDIT_RETENTION_DAYS = 90
"""审计事件保留天数"""

# =============================================================================
# MCP Client
# =============================================================================

MCP_CONNECTION_TIMEOUT = 10
"""MCP 连接超时（秒）"""

MCP_CALL_TIMEOUT = 30
"""MCP 调用超时（秒）"""

MCP_RECONNECT_DELAY = 5
"""MCP 重连延迟（秒）"""

MCP_MAX_RETRIES = 3
"""MCP 最大重试次数"""

# =============================================================================
# HTTP Server
# =============================================================================

HTTP_SERVER_HOST = "0.0.0.0"
"""HTTP 服务监听地址"""

HTTP_SERVER_PORT = int(os.environ.get("RUNTIME_PORT", "8801"))
"""HTTP 服务监听端口"""

HTTP_SERVER_WORKERS = 1
"""HTTP 服务工作进程数"""

SSE_KEEPALIVE_INTERVAL = 15
"""SSE 心跳间隔（秒）"""

EXECUTION_STREAM_TIMEOUT = 300
"""执行流超时（秒）"""

# =============================================================================
# Generated Files
# =============================================================================

GENERATED_FILES_DIR = "/tmp/semibot/generated-files"
"""生成文件持久化目录"""

GENERATED_FILES_TTL_SECONDS = 3600
"""生成文件过期时间（秒）- 1 小时"""

GENERATED_FILES_MAX_SIZE_BYTES = 50 * 1024 * 1024
"""生成文件最大大小（字节）- 50MB"""

GENERATED_FILES_ALLOWED_EXTENSIONS = {
    ".pdf", ".csv", ".json", ".txt", ".md", ".markdown",
    ".png", ".jpg", ".svg", ".html",
    ".xlsx", ".pptx", ".docx",
}
"""允许持久化的文件扩展名"""

GENERATED_FILES_CLEANUP_INTERVAL_SECONDS = 300
"""过期文件清理间隔（秒）- 5 分钟"""

# =============================================================================
# Gateway
# =============================================================================

GATEWAY_TASK_TIMEOUT_SECONDS = 600
"""Gateway 任务执行超时时间（秒）"""

GATEWAY_APPROVAL_POLL_INTERVAL_SECONDS = 1.0
"""审批轮询间隔（秒）"""

GATEWAY_PLAN_PREVIEW_MAX_STEPS = 8
"""即时 ACK 中计划预览的最大步骤数"""

GATEWAY_APPROVAL_LIST_LIMIT = 1000
"""审批列表查询上限"""

GATEWAY_RESUME_CONTEXT_MESSAGES_LIMIT = 500
"""审批恢复时加载的上下文消息上限"""

GATEWAY_INBOUND_MAX_FILE_BYTES = 20 * 1024 * 1024
"""渠道入站附件最大字节数（20MB）"""

GATEWAY_CONNECTION_SUPERVISOR_POLL_INTERVAL_SECONDS = 5.0
"""渠道连接监督轮询间隔（秒）"""

# =============================================================================
# Skills CLI (npx skills)
# =============================================================================

SKILLS_CLI_TIMEOUT_SECONDS = 120
"""skills CLI 子进程超时（秒）"""

SKILLS_CLI_AUTO_CONFIRM_INTERVAL = 0.25
"""skills CLI 自动确认输入间隔（秒）"""

REGISTRY_NAME_PATTERN = r"^[a-zA-Z0-9._/@-]+$"
"""skills.sh 注册表技能名合法字符正则"""

GH_AUTH_LOGIN_TIMEOUT_SECONDS = 120
"""gh auth login --web 等待用户浏览器认证超时（秒）"""

GH_AUTH_POLL_INTERVAL_SECONDS = 3
"""轮询 gh auth status 的间隔（秒）"""

