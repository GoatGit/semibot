"""Unit tests for LongTermMemory."""

from __future__ import annotations

import sys
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Add src to path to avoid importing through src/__init__.py
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from memory.base import MemoryEntry, MemorySearchResult
from memory.embedding import EmbeddingResult, EmbeddingService
from memory.long_term import (
    DEFAULT_MIN_SIMILARITY,
    DEFAULT_SEARCH_LIMIT,
    MAX_SEARCH_LIMIT,
    LongTermMemory,
)


@pytest.fixture
def mock_embedding_service():
    """Create a mock embedding service."""
    service = AsyncMock(spec=EmbeddingService)
    service.embed.return_value = EmbeddingResult(
        embedding=[0.1] * 1536,
        model="text-embedding-ada-002",
        tokens_used=10,
    )
    service.embed_batch.return_value = [
        EmbeddingResult(
            embedding=[0.1] * 1536,
            model="text-embedding-ada-002",
            tokens_used=10,
        )
    ]
    return service


class MockAsyncContextManager:
    """Mock async context manager for pool.acquire()."""

    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        return None


@pytest.fixture
def mock_pool():
    """Create a mock database connection pool."""
    pool = MagicMock()
    conn = AsyncMock()

    # Make acquire() return a proper async context manager
    pool.acquire.return_value = MockAsyncContextManager(conn)

    return pool, conn


@pytest.fixture
def long_term_memory(mock_embedding_service, mock_pool):
    """Create LongTermMemory with mocked dependencies."""
    pool, conn = mock_pool
    memory = LongTermMemory(
        database_url="postgresql://test:test@localhost/test",
        embedding_service=mock_embedding_service,
        org_id="00000000-0000-0000-0000-000000000001",
    )
    memory._pool = pool
    return memory, conn


class TestLongTermMemoryInit:
    """Tests for LongTermMemory initialization."""

    def test_initialization(self, mock_embedding_service):
        """Test initialization with required parameters."""
        memory = LongTermMemory(
            database_url="postgresql://test:test@localhost/test",
            embedding_service=mock_embedding_service,
        )
        assert memory.database_url == "postgresql://test:test@localhost/test"
        assert memory.embedding_service == mock_embedding_service
        assert memory.org_id is None

    def test_initialization_with_org_id(self, mock_embedding_service):
        """Test initialization with org_id."""
        memory = LongTermMemory(
            database_url="postgresql://test:test@localhost/test",
            embedding_service=mock_embedding_service,
            org_id="org_123",
        )
        assert memory.org_id == "org_123"


class TestLongTermMemorySave:
    """Tests for LongTermMemory.save method."""

    @pytest.mark.asyncio
    async def test_save_creates_entry(self, long_term_memory, mock_embedding_service):
        """Test that save creates a memory entry."""
        memory, conn = long_term_memory
        conn.execute.return_value = None

        agent_id = str(uuid.uuid4())
        entry_id = await memory.save(
            agent_id=agent_id,
            content="Test content",
            importance=0.8,
        )

        assert entry_id is not None
        assert len(entry_id) == 36  # UUID format
        mock_embedding_service.embed.assert_called_once_with("Test content")
        conn.execute.assert_called_once()

    @pytest.mark.asyncio
    async def test_save_with_metadata(self, long_term_memory, mock_embedding_service):
        """Test save with metadata."""
        memory, conn = long_term_memory
        conn.execute.return_value = None

        agent_id = str(uuid.uuid4())
        metadata = {"source": "test", "category": "preference"}
        entry_id = await memory.save(
            agent_id=agent_id,
            content="User prefers dark mode",
            importance=0.9,
            metadata=metadata,
        )

        assert entry_id is not None
        # Verify execute was called with metadata (serialized as JSON string)
        call_args = conn.execute.call_args[0]
        import json
        assert json.dumps(metadata) in call_args

    @pytest.mark.asyncio
    async def test_save_clamps_importance(self, long_term_memory):
        """Test that importance is clamped to [0, 1]."""
        memory, conn = long_term_memory
        conn.execute.return_value = None

        agent_id = str(uuid.uuid4())

        # Test importance > 1
        await memory.save(
            agent_id=agent_id,
            content="Test",
            importance=1.5,
        )

        # Test importance < 0
        await memory.save(
            agent_id=agent_id,
            content="Test",
            importance=-0.5,
        )

        # Both should succeed without error
        assert conn.execute.call_count == 2


class TestLongTermMemorySearch:
    """Tests for LongTermMemory.search method."""

    @pytest.mark.asyncio
    async def test_search_returns_results(self, long_term_memory, mock_embedding_service):
        """Test search returns matching results."""
        memory, conn = long_term_memory

        agent_id = str(uuid.uuid4())
        entry_id = uuid.uuid4()

        conn.fetch.return_value = [
            {
                "id": entry_id,
                "content": "User prefers Celsius",
                "memory_type": "semantic",
                "importance": 0.8,
                "metadata": {"type": "preference"},
                "created_at": datetime.now(timezone.utc),
                "similarity": 0.95,
            }
        ]
        conn.execute.return_value = None  # For access update

        results = await memory.search(
            agent_id=agent_id,
            query="temperature preference",
            limit=5,
        )

        assert len(results) == 1
        assert results[0].content == "User prefers Celsius"
        assert results[0].score == 0.95
        mock_embedding_service.embed.assert_called_once_with("temperature preference")

    @pytest.mark.asyncio
    async def test_search_empty_results(self, long_term_memory):
        """Test search with no results."""
        memory, conn = long_term_memory
        conn.fetch.return_value = []

        agent_id = str(uuid.uuid4())
        results = await memory.search(
            agent_id=agent_id,
            query="nonexistent query",
        )

        assert results == []

    @pytest.mark.asyncio
    async def test_search_enforces_max_limit(self, long_term_memory):
        """Test that search enforces maximum limit."""
        memory, conn = long_term_memory
        conn.fetch.return_value = []

        agent_id = str(uuid.uuid4())
        await memory.search(
            agent_id=agent_id,
            query="test",
            limit=MAX_SEARCH_LIMIT + 50,
        )

        # Verify the limit was clamped
        call_args = conn.fetch.call_args[0]
        # The limit should be MAX_SEARCH_LIMIT, not the requested value
        assert MAX_SEARCH_LIMIT in call_args


class TestLongTermMemoryDelete:
    """Tests for LongTermMemory.delete method."""

    @pytest.mark.asyncio
    async def test_delete_success(self, long_term_memory):
        """Test successful deletion."""
        memory, conn = long_term_memory
        conn.execute.return_value = "DELETE 1"

        entry_id = str(uuid.uuid4())
        result = await memory.delete(entry_id)

        assert result is True

    @pytest.mark.asyncio
    async def test_delete_not_found(self, long_term_memory):
        """Test deletion of non-existent entry."""
        memory, conn = long_term_memory
        conn.execute.return_value = "DELETE 0"

        entry_id = str(uuid.uuid4())
        result = await memory.delete(entry_id)

        assert result is False


class TestLongTermMemoryGet:
    """Tests for LongTermMemory.get method."""

    @pytest.mark.asyncio
    async def test_get_existing_entry(self, long_term_memory):
        """Test getting an existing entry."""
        memory, conn = long_term_memory

        entry_id = uuid.uuid4()
        agent_id = uuid.uuid4()

        conn.fetchrow.return_value = {
            "id": entry_id,
            "agent_id": agent_id,
            "session_id": None,
            "content": "Test content",
            "importance": 0.7,
            "metadata": {},
            "created_at": datetime.now(timezone.utc),
            "expires_at": None,
        }

        entry = await memory.get(str(entry_id))

        assert entry is not None
        assert entry.content == "Test content"
        assert entry.importance == 0.7

    @pytest.mark.asyncio
    async def test_get_nonexistent_entry(self, long_term_memory):
        """Test getting a non-existent entry."""
        memory, conn = long_term_memory
        conn.fetchrow.return_value = None

        entry_id = str(uuid.uuid4())
        entry = await memory.get(entry_id)

        assert entry is None


class TestLongTermMemoryHealthCheck:
    """Tests for LongTermMemory.health_check method."""

    @pytest.mark.asyncio
    async def test_health_check_success(self, long_term_memory):
        """Test successful health check."""
        memory, conn = long_term_memory
        conn.execute.return_value = None

        result = await memory.health_check()

        assert result is True

    @pytest.mark.asyncio
    async def test_health_check_failure(self, long_term_memory):
        """Test failed health check."""
        memory, conn = long_term_memory
        conn.execute.side_effect = Exception("Connection refused")

        result = await memory.health_check()

        assert result is False
