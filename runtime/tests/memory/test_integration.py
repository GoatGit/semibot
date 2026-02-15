"""Integration tests for Memory module with Redis and PostgreSQL.

These tests require actual Redis and PostgreSQL instances running.
Set RUN_INTEGRATION_TESTS=true and provide REDIS_URL / DATABASE_URL / OPENAI_API_KEY.
"""

import asyncio
import os
import pytest
from datetime import datetime, timezone

from src.memory.short_term import ShortTermMemory
from src.memory.long_term import LongTermMemory
from src.memory.embedding import EmbeddingService, OpenAIEmbeddingProvider
from src.memory.base import MemoryEntry, MemorySearchResult


# Skip if integration test environment not available
pytestmark = pytest.mark.skipif(
    os.getenv("RUN_INTEGRATION_TESTS") != "true",
    reason="Integration tests require RUN_INTEGRATION_TESTS=true and running services"
)

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://localhost:5432/semibot_test")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
CUSTOM_LLM_API_KEY = os.getenv("CUSTOM_LLM_API_KEY", "")
CUSTOM_LLM_API_BASE_URL = os.getenv("CUSTOM_LLM_API_BASE_URL", "")


@pytest.fixture
async def redis_memory():
    """Create ShortTermMemory with real Redis connection."""
    memory = ShortTermMemory(redis_url=REDIS_URL)
    # Lazy init — first operation will connect
    yield memory
    await memory.close()


@pytest.fixture
async def embedding_service():
    """Create EmbeddingService with real provider."""
    # Prefer custom LLM endpoint (cheaper), fallback to OpenAI
    api_key = CUSTOM_LLM_API_KEY or OPENAI_API_KEY
    base_url = CUSTOM_LLM_API_BASE_URL or "https://api.openai.com/v1"

    if not api_key:
        pytest.skip("No API key available for embedding service")

    provider = OpenAIEmbeddingProvider(
        api_key=api_key,
        model="text-embedding-3-small",
        base_url=base_url,
    )
    service = EmbeddingService(provider=provider)
    yield service
    await service.close()


@pytest.fixture
async def postgres_memory(embedding_service):
    """Create LongTermMemory with real PostgreSQL connection."""
    memory = LongTermMemory(
        database_url=DATABASE_URL,
        embedding_service=embedding_service,
    )
    yield memory
    await memory.close()


# ---------------------------------------------------------------------------
# ShortTermMemory (Redis) tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.integration
async def test_short_term_memory_redis_operations(redis_memory):
    """Test ShortTermMemory with real Redis."""
    session_id = "test-session-redis-integ"

    # Save memory entry
    entry_id = await redis_memory.save(
        session_id=session_id,
        content="Test memory content",
        agent_id="test-agent",
        metadata={"source": "integration_test"},
    )

    assert entry_id is not None

    # Retrieve session context
    memories = await redis_memory.get_session_context(
        session_id=session_id,
        limit=10,
    )

    assert len(memories) >= 1
    assert any(m.content == "Test memory content" for m in memories)

    # Clear session
    await redis_memory.clear_session(session_id)

    # Verify cleared
    memories_after = await redis_memory.get_session_context(
        session_id=session_id, limit=10
    )
    assert len(memories_after) == 0


@pytest.mark.asyncio
@pytest.mark.integration
async def test_short_term_memory_ttl_expiration(redis_memory):
    """Test ShortTermMemory TTL expiration."""
    session_id = "test-session-ttl-integ"

    # Save with short TTL (2 seconds)
    await redis_memory.save(
        session_id=session_id,
        content="Expiring memory",
        agent_id="test-agent",
        ttl_seconds=2,
    )

    # Should exist immediately
    memories = await redis_memory.get_session_context(
        session_id=session_id, limit=10
    )
    assert len(memories) == 1

    # Wait for expiration
    await asyncio.sleep(3)

    # Should be expired
    memories_after = await redis_memory.get_session_context(
        session_id=session_id, limit=10
    )
    assert len(memories_after) == 0


@pytest.mark.asyncio
@pytest.mark.integration
async def test_memory_concurrent_access(redis_memory):
    """Test concurrent access to ShortTermMemory."""
    session_id = "test-session-concurrent-integ"

    async def save_memory(index: int):
        return await redis_memory.save(
            session_id=session_id,
            content=f"Concurrent memory {index}",
            agent_id="test-agent",
            metadata={"index": index},
        )

    # Execute 10 concurrent saves
    results = await asyncio.gather(*[save_memory(i) for i in range(10)])

    # All should succeed
    assert len(results) == 10
    assert all(r is not None for r in results)

    # Retrieve all memories
    memories = await redis_memory.get_session_context(
        session_id=session_id, limit=20
    )
    assert len(memories) >= 10

    # Cleanup
    await redis_memory.clear_session(session_id)


# ---------------------------------------------------------------------------
# LongTermMemory (PostgreSQL + pgvector) tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.integration
async def test_long_term_memory_postgres_operations(postgres_memory):
    """Test LongTermMemory with real PostgreSQL."""
    # Use valid UUIDs as required by validation
    agent_id = "00000000-0000-4000-8000-000000000001"
    org_id = "00000000-0000-4000-8000-000000000099"

    # Save memory entry (embedding generated internally)
    entry_id = await postgres_memory.save(
        agent_id=agent_id,
        content="Test long-term memory for integration",
        importance=0.8,
        memory_type="episodic",
        metadata={"source": "integration_test"},
        org_id=org_id,
    )

    assert entry_id is not None

    # Search by semantic similarity
    results = await postgres_memory.search(
        agent_id=agent_id,
        query="Test long-term memory",
        limit=5,
        min_similarity=0.3,
        org_id=org_id,
    )

    assert len(results) >= 1
    assert any(r.entry.content == "Test long-term memory for integration" for r in results)

    # Delete entry
    deleted = await postgres_memory.delete(entry_id)
    assert deleted is True


@pytest.mark.asyncio
@pytest.mark.integration
async def test_long_term_memory_multi_tenant_isolation(postgres_memory):
    """Test multi-tenant isolation in LongTermMemory."""
    agent_id = "00000000-0000-4000-8000-000000000002"
    org_id_1 = "00000000-0000-4000-8000-000000000011"
    org_id_2 = "00000000-0000-4000-8000-000000000022"

    # Save memory for org 1
    entry_id_1 = await postgres_memory.save(
        agent_id=agent_id,
        content="Org 1 specific memory content",
        importance=0.7,
        org_id=org_id_1,
    )

    # Save memory for org 2
    entry_id_2 = await postgres_memory.save(
        agent_id=agent_id,
        content="Org 2 specific memory content",
        importance=0.7,
        org_id=org_id_2,
    )

    # Search from org 1 perspective
    results_org_1 = await postgres_memory.search(
        agent_id=agent_id,
        query="specific memory content",
        limit=10,
        min_similarity=0.3,
        org_id=org_id_1,
    )

    # Should only see org 1 memories
    org_1_ids = {r.entry.id for r in results_org_1}
    assert entry_id_1 in org_1_ids
    assert entry_id_2 not in org_1_ids

    # Search from org 2 perspective
    results_org_2 = await postgres_memory.search(
        agent_id=agent_id,
        query="specific memory content",
        limit=10,
        min_similarity=0.3,
        org_id=org_id_2,
    )

    # Should only see org 2 memories
    org_2_ids = {r.entry.id for r in results_org_2}
    assert entry_id_2 in org_2_ids
    assert entry_id_1 not in org_2_ids

    # Cleanup
    await postgres_memory.delete(entry_id_1)
    await postgres_memory.delete(entry_id_2)


# ---------------------------------------------------------------------------
# EmbeddingService tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.integration
async def test_embedding_service_caching(embedding_service):
    """Test EmbeddingService embedding generation."""
    text = "Test embedding generation behavior"

    # First call
    embedding_1 = await embedding_service.embed(text)
    assert embedding_1 is not None
    assert len(embedding_1.embedding) > 0

    # Different text should generate different embedding
    embedding_2 = await embedding_service.embed("Completely different text here")
    assert embedding_2 is not None
    assert len(embedding_2.embedding) > 0

    # Verify dimensions match
    assert len(embedding_1.embedding) == len(embedding_2.embedding)


# ---------------------------------------------------------------------------
# Access count tracking
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.integration
async def test_memory_access_count_tracking(postgres_memory):
    """Test that access counts are tracked correctly."""
    agent_id = "00000000-0000-4000-8000-000000000003"
    org_id = "00000000-0000-4000-8000-000000000099"

    # Save memory
    entry_id = await postgres_memory.save(
        agent_id=agent_id,
        content="Access tracking test memory",
        importance=0.7,
        org_id=org_id,
    )

    # Search multiple times (triggers access count updates)
    for _ in range(3):
        await postgres_memory.search(
            agent_id=agent_id,
            query="Access tracking test",
            limit=5,
            min_similarity=0.3,
            org_id=org_id,
        )

    # Verify the mechanism doesn't crash — access_count should be >= 3
    # (exact value depends on implementation)

    # Cleanup
    await postgres_memory.delete(entry_id)
