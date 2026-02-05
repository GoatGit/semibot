"""Memory System for Agent Runtime.

Provides a layered memory architecture:
- Short-term memory (Redis): Current conversation, tool results, temporary state
- Long-term memory (pgvector): Historical summaries, user preferences, knowledge base

Example:
    ```python
    from src.memory import MemorySystem, ShortTermMemory, LongTermMemory
    from src.memory.embedding import EmbeddingService, OpenAIEmbeddingProvider

    # Initialize embedding service
    embedding_service = EmbeddingService(
        provider=OpenAIEmbeddingProvider(api_key="sk-...")
    )

    # Initialize memory system
    memory = MemorySystem(
        short_term=ShortTermMemory(redis_url="redis://localhost:6379"),
        long_term=LongTermMemory(
            database_url="postgresql://...",
            embedding_service=embedding_service,
        ),
    )

    # Use short-term memory
    await memory.save_short_term(
        session_id="sess_123",
        content="User asked about weather",
    )

    # Use long-term memory
    await memory.save_long_term(
        agent_id="agent_456",
        content="User prefers Celsius",
        importance=0.8,
    )

    # Search long-term memory
    context = await memory.search_long_term(
        agent_id="agent_456",
        query="temperature preferences",
    )
    ```
"""

from .base import (
    LongTermMemoryInterface,
    MemoryEntry,
    MemorySearchResult,
    MemorySystem,
    ShortTermMemoryInterface,
)
from .embedding import (
    EmbeddingProvider,
    EmbeddingResult,
    EmbeddingService,
    OpenAIEmbeddingProvider,
    RedisEmbeddingCache,
)
from .long_term import LongTermMemory
from .short_term import ShortTermMemory

__all__ = [
    # Core classes
    "MemorySystem",
    "MemoryEntry",
    "MemorySearchResult",
    # Interfaces
    "ShortTermMemoryInterface",
    "LongTermMemoryInterface",
    # Implementations
    "ShortTermMemory",
    "LongTermMemory",
    # Embedding
    "EmbeddingService",
    "EmbeddingProvider",
    "EmbeddingResult",
    "OpenAIEmbeddingProvider",
    "RedisEmbeddingCache",
]
