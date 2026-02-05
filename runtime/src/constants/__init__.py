"""Constants and configuration for the runtime module."""

# =============================================================================
# Redis Configuration (Short-term Memory)
# =============================================================================

# Connection settings
REDIS_DEFAULT_URL = "redis://localhost:6379"
REDIS_KEY_PREFIX = "semibot:memory:short_term"

# Retry settings
REDIS_MAX_RETRIES = 3
REDIS_RETRY_DELAY_BASE = 1  # seconds
REDIS_RETRY_DELAY_MAX = 10  # seconds

# TTL settings
DEFAULT_TTL_SECONDS = 3600  # 1 hour
MAX_SESSION_ENTRIES = 100

# =============================================================================
# PostgreSQL Configuration (Long-term Memory)
# =============================================================================

# Connection pool settings
PG_POOL_MIN_SIZE = 2
PG_POOL_MAX_SIZE = 10
PG_POOL_ACQUIRE_TIMEOUT = 30  # seconds

# Retry settings
PG_MAX_RETRIES = 3
PG_RETRY_DELAY_BASE = 1  # seconds
PG_RETRY_DELAY_MAX = 10  # seconds

# Query settings
DEFAULT_SEARCH_LIMIT = 10
DEFAULT_MIN_SIMILARITY = 0.7
MAX_SEARCH_LIMIT = 100

# =============================================================================
# Embedding Configuration
# =============================================================================

DEFAULT_EMBEDDING_MODEL = "text-embedding-ada-002"
EMBEDDING_DIMENSION = 1536
EMBEDDING_BATCH_SIZE = 100
EMBEDDING_REQUEST_TIMEOUT = 30  # seconds

# Embedding retry settings
EMBEDDING_MAX_RETRIES = 3
EMBEDDING_RETRY_DELAY_BASE = 1  # seconds
EMBEDDING_RETRY_DELAY_MAX = 10  # seconds

# Embedding cache settings
EMBEDDING_CACHE_TTL = 86400 * 7  # 7 days
EMBEDDING_CACHE_PREFIX = "semibot:embedding_cache"
