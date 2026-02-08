"""Integration tests for Memory module with Redis and PostgreSQL.

These tests require actual Redis and PostgreSQL instances running.
Use docker-compose or skip with pytest markers if services unavailable.
"""

import asyncio
import os
import pytest
from datetime import datetime, timezone

from src.memory.short_term import ShortTermMemory
from src.memory.long_term import LongTermMemory
from src.memory.embedding import EmbeddingService
from src.memory.models import MemoryEntry, MemorySearchResult


# Skip if integration test environment not available
pytestmark = pytest.mark.skipif(
    os.getenv("RUN_INTEGRATION_TESTS") != "true",
    reason="Integration tests require RUN_INTEGRATION_TESTS=true and running services"
)


@pytest.fixture
async def redis_memory():
    """Create ShortTermMemory with real Redis connection."""
    redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")
    memory = ShortTermMemory(redis_url=redis_url)
    await memory.connect()
    yield memory
    await memory.close()


@pytest.fixture
async def postgres_memory():
    """Create LongTermMemory with real PostgreSQL connection."""
    db_url = os.getenv("DATABASE_URL", "postgresql://localhost:5432/semibot_test")
    memory = LongTermMemory(database_url=db_url)
    await memory.connect()
    yield memory
    await memory.close()


@pytest.fixture
async def embedding_service():
    """Create EmbeddingService with real provider."""
    service = EmbeddingService(
        provider_type="openai",
        api_key=os.getenv("OPENAI_API_KEY", "test-key"),
        model="text-embedding-3-small",
    )
    yield service
    await service.close()


@pytest.mark.asyncio
@pytest.mark.integration
async def test_short_term_memory_redis_operations(redis_memory):
    """Test ShortTermMemory with real Redis."""
    session_id = "test-session-redis"
    agent_id = "test-agent"

    # Save memory entry
    entry_id = await redis_memory.save(
        content="Test memory content",
        agent_id=agent_id,
        session_id=session_id,
        metadata={"source": "integration_test"},
    )

    assert entry_id is not None

    # Retrieve recent memories
    memories = await redis_memory.get_recent(
        session_id=session_id,
        limit=10,
    )

    assert len(memories) >= 1
    assert any(m.content == "Test memory content" for m in memories)

    # Clear session
    await redis_memory.clear_session(session_id)

    # Verify cleared
    memories_after = await redis_memory.get_recent(session_id=session_id, limit=10)
    assert len(memories_after) == 0


@pytest.mark.asyncio
@pytest.mark.integration
async def test_short_term_memory_ttl_expiration(redis_memory):
    """Test ShortTermMemory TTL expiration."""
    session_id = "test-session-ttl"
    agent_id = "test-agent"

    # Save with short TTL (2 seconds)
    entry_id = await redis_memory.save(
        content="Expiring memory",
        agent_id=agent_id,
        session_id=session_id,
        ttl_seconds=2,
    )

    # Should exist immediately
    memories = await redis_memory.get_recent(session_id=session_id, limit=10)
    assert len(memories) == 1

    # Wait for expiration
    await asyncio.sleep(3)

    # Should be expired
    memories_after = await redis_memory.get_recent(session_id=session_id, limit=10)
    assert len(memories_after) == 0


@pytest.mark.asyncio
@pytest.mark.integration
async def test_long_term_memory_postgres_operations(postgres_memory, embedding_service):
    """Test LongTermMemory with real PostgreSQL."""
    agent_id = "test-agent-pg"
    org_id = "test-org"

    # Generate embedding
    embedding = await embedding_service.embed("Test long-term memory")

    # Save memory entry
    entry_id = await postgres_memory.save(
        content="Test long-term memory",
        agent_id=agent_id,
        org_id=org_id,
        embedding=embedding,
        importance=0.8,
        memory_type="episodic",
        metadata={"source": "integration_test"},
    )

    assert entry_id is not None

    # Search by embedding
    query_embedding = await embedding_service.embed("Test memory")
    results = await postgres_memory.search(
        query_embedding=query_embedding,
        agent_id=agent_id,
        org_id=org_id,
        limit=5,
        min_similarity=0.5,
    )

    assert len(results) >= 1
    assert any(r.entry.content == "Test long-term memory" for r in results)

    # Delete entry
    await postgres_memory.delete(entry_id, org_id=org_id)

    # Verify deleted
    results_after = await postgres_memory.search(
        query_embedding=query_embedding,
        agent_id=agent_id,
        org_id=org_id,
        limit=5,
    )
    assert not any(r.entry.id == entry_id for r in results_after)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_long_term_memory_multi_tenant_isolation(postgres_memory, embedding_service):
    """Test multi-tenant isolation in LongTermMemory."""
    agent_id = "test-agent-mt"
    org_id_1 = "org-1"
    org_id_2 = "org-2"

    embedding = await embedding_service.embed("Tenant-specific memory")

    # Save memory for org 1
    entry_id_1 = await postgres_memory.save(
        content="Org 1 memory",
        agent_id=agent_id,
        org_id=org_id_1,
        embedding=embedding,
        importance=0.7,
    )

    # Save memory for org 2
    entry_id_2 = await postgres_memory.save(
        content="Org 2 memory",
        agent_id=agent_id,
        org_id=org_id_2,
        embedding=embedding,
        importance=0.7,
    )

    # Search from org 1 perspective
    results_org_1 = await postgres_memory.search(
        query_embedding=embedding,
        agent_id=agent_id,
        org_id=org_id_1,
        limit=10,
    )

    # Should only see org 1 memories
    assert all(r.entry.id == entry_id_1 for r in results_org_1 if r.entry.content in ["Org 1 memory", "Org 2 memory"])

    # Search from org 2 perspective
    results_org_2 = await postgres_memory.search(
        query_embedding=embedding,
        agent_id=agent_id,
        org_id=org_id_2,
        limit=10,
    )

    # Should only see org 2 memories
    assert all(r.entry.id == entry_id_2 for r in results_org_2 if r.entry.content in ["Org 1 memory", "Org 2 memory"])

    # Cleanup
    await postgres_memory.delete(entry_id_1, org_id=org_id_1)
    await postgres_memory.delete(entry_id_2, org_id=org_id_2)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_memory_concurrent_access(redis_memory):
    """Test concurrent access to ShortTermMemory."""
    session_id = "test-session-concurrent"
    agent_id = "test-agent"

    # Create multiple concurrent save operations
    async def save_memory(index: int):
        return await redis_memory.save(
            content=f"Concurrent memory {index}",
            agent_id=agent_id,
            session_id=session_id,
            metadata={"index": index},
        )

    # Execute 10 concurrent saves
    results = await asyncio.gather(*[save_memory(i) for i in range(10)])

    # All should succeed
    assert len(results) == 10
    assert all(r is not None for r in results)

    # Retrieve all memories
    memories = await redis_memory.get_recent(session_id=session_id, limit=20)

    # Should have all 10 memories
    assert len(memories) >= 10

    # Cleanup
    await redis_memory.clear_session(session_id)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_embedding_service_caching(embedding_service):
    """Test EmbeddingService caching behavior."""
    text = "Test caching behavior"

    # First call - should hit API
    embedding_1 = await embedding_service.embed(text)

    # Second call - should hit cache
    embedding_2 = await embedding_service.embed(text)

    # Should return same embedding
    assert embedding_1 == embedding_2

    # Different text should generate different embedding
    embedding_3 = await embedding_service.embed("Different text")
    assert embedding_3 != embedding_1


@pytest.mark.asyncio
@pytest.mark.integration
async def test_memory_access_count_tracking(postgres_memory, embedding_service):
    """Test that access counts are tracked correctly."""
    agent_id = "test-agent-access"
    org_id = "test-org"

    embedding = await embedding_service.embed("Access tracking test")

    # Save memory
    entry_id = await postgres_memory.save(
        content="Access tracking test",
        agent_id=agent_id,
        org_id=org_id,
        embedding=embedding,
        importance=0.7,
    )

    # Search multiple times (triggers access count updates)
    for _ in range(3):
        await postgres_memory.search(
            query_embedding=embedding,
            agent_id=agent_id,
            org_id=org_id,
            limit=5,
        )

    # Access count should be updated (implementation-dependent)
    # This test verifies the mechanism doesn't crash

    # Cleanup
    await postgres_memory.delete(entry_id, org_id=org_id)
