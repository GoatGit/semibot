"""Unit tests for ShortTermMemory."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Add src to path to avoid importing through src/__init__.py
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from memory.base import MemoryEntry
from memory.short_term import (
    DEFAULT_TTL_SECONDS,
    MAX_SESSION_ENTRIES,
    REDIS_KEY_PREFIX,
    ShortTermMemory,
)


class MockAsyncContextManager:
    """Mock async context manager for Redis pipeline."""

    def __init__(self, pipe):
        self.pipe = pipe

    async def __aenter__(self):
        return self.pipe

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        return None


@pytest.fixture
def mock_redis():
    """Create a mock Redis client."""
    client = MagicMock()
    client.is_closed = False

    # Create mock pipeline
    pipe = AsyncMock()
    pipe.zadd = MagicMock()
    pipe.expire = MagicMock()
    pipe.zremrangebyrank = MagicMock()
    pipe.execute = AsyncMock(return_value=[])

    # Make pipeline() return a proper async context manager
    client.pipeline.return_value = MockAsyncContextManager(pipe)

    # Make other methods async
    client.zcard = AsyncMock(return_value=5)
    client.zrange = AsyncMock(return_value=[])
    client.delete = AsyncMock(return_value=1)
    client.expire = AsyncMock(return_value=True)
    client.ping = AsyncMock(return_value=True)
    client.eval = AsyncMock(return_value=0)

    return client


@pytest.fixture
def short_term_memory(mock_redis):
    """Create ShortTermMemory with mocked Redis."""
    memory = ShortTermMemory(redis_url="redis://localhost:6379")
    memory._client = mock_redis
    return memory


class TestShortTermMemoryInit:
    """Tests for ShortTermMemory initialization."""

    def test_default_values(self):
        """Test default initialization values."""
        memory = ShortTermMemory()
        assert memory.redis_url == "redis://localhost:6379"
        assert memory.key_prefix == REDIS_KEY_PREFIX
        assert memory.default_ttl == DEFAULT_TTL_SECONDS

    def test_custom_values(self):
        """Test custom initialization values."""
        memory = ShortTermMemory(
            redis_url="redis://custom:6380",
            key_prefix="custom:prefix",
            default_ttl=7200,
        )
        assert memory.redis_url == "redis://custom:6380"
        assert memory.key_prefix == "custom:prefix"
        assert memory.default_ttl == 7200


class TestShortTermMemorySave:
    """Tests for ShortTermMemory.save method."""

    @pytest.mark.asyncio
    async def test_save_creates_entry(self, short_term_memory, mock_redis):
        """Test that save creates a memory entry."""
        entry_id = await short_term_memory.save(
            session_id="sess_123",
            content="Test content",
            agent_id="agent_456",
        )

        assert entry_id is not None
        assert len(entry_id) == 36  # UUID format

    @pytest.mark.asyncio
    async def test_save_with_metadata(self, short_term_memory, mock_redis):
        """Test save with metadata."""
        metadata = {"source": "test", "priority": 1}
        entry_id = await short_term_memory.save(
            session_id="sess_123",
            content="Test content",
            agent_id="agent_456",
            metadata=metadata,
        )

        assert entry_id is not None

    @pytest.mark.asyncio
    async def test_save_trims_entries_at_limit(self, short_term_memory, mock_redis):
        """Test that entries are trimmed when limit is reached."""
        mock_redis.eval.return_value = 10  # Lua script returns trimmed count

        await short_term_memory.save(
            session_id="sess_123",
            content="Test content",
        )

        # Verify the Lua script was called for atomic add+trim
        assert mock_redis.eval.called


class TestShortTermMemoryGetSessionContext:
    """Tests for ShortTermMemory.get_session_context method."""

    @pytest.mark.asyncio
    async def test_get_session_context_returns_entries(
        self, short_term_memory, mock_redis
    ):
        """Test getting session context returns entries."""
        entry = MemoryEntry(
            id="entry_1",
            content="Test content",
            agent_id="agent_123",
            session_id="sess_123",
            created_at=datetime.now(timezone.utc),
        )
        mock_redis.zrange.return_value = [json.dumps(entry.to_dict())]

        entries = await short_term_memory.get_session_context("sess_123")

        assert len(entries) == 1
        assert entries[0].content == "Test content"
        assert entries[0].id == "entry_1"

    @pytest.mark.asyncio
    async def test_get_session_context_empty_session(
        self, short_term_memory, mock_redis
    ):
        """Test getting context for empty session."""
        mock_redis.zrange.return_value = []

        entries = await short_term_memory.get_session_context("sess_123")

        assert entries == []

    @pytest.mark.asyncio
    async def test_get_session_context_with_limit(self, short_term_memory, mock_redis):
        """Test getting context with custom limit."""
        mock_redis.zrange.return_value = []

        await short_term_memory.get_session_context("sess_123", limit=10)

        mock_redis.zrange.assert_called_once()
        call_args = mock_redis.zrange.call_args[0]
        assert call_args[1] == -10  # Negative index for last N items

    @pytest.mark.asyncio
    async def test_get_session_context_handles_invalid_json(
        self, short_term_memory, mock_redis
    ):
        """Test handling of invalid JSON entries."""
        mock_redis.zrange.return_value = ["invalid json", "{also invalid"]

        entries = await short_term_memory.get_session_context("sess_123")

        assert entries == []


class TestShortTermMemoryClearSession:
    """Tests for ShortTermMemory.clear_session method."""

    @pytest.mark.asyncio
    async def test_clear_session(self, short_term_memory, mock_redis):
        """Test clearing a session."""
        mock_redis.delete.return_value = 1

        await short_term_memory.clear_session("sess_123")

        expected_key = f"{REDIS_KEY_PREFIX}:sess_123"
        mock_redis.delete.assert_called_once_with(expected_key)


class TestShortTermMemoryHealthCheck:
    """Tests for ShortTermMemory.health_check method."""

    @pytest.mark.asyncio
    async def test_health_check_success(self, short_term_memory, mock_redis):
        """Test successful health check."""
        mock_redis.ping.return_value = True

        result = await short_term_memory.health_check()

        assert result is True

    @pytest.mark.asyncio
    async def test_health_check_failure(self, short_term_memory, mock_redis):
        """Test failed health check."""
        mock_redis.ping.side_effect = Exception("Connection refused")

        result = await short_term_memory.health_check()

        assert result is False


class TestShortTermMemoryKeyGeneration:
    """Tests for key generation methods."""

    def test_session_key_format(self):
        """Test session key format."""
        memory = ShortTermMemory()
        key = memory._session_key("sess_123")
        assert key == f"{REDIS_KEY_PREFIX}:sess_123"

    def test_entry_key_format(self):
        """Test entry key format."""
        memory = ShortTermMemory()
        key = memory._entry_key("sess_123", "entry_456")
        assert key == f"{REDIS_KEY_PREFIX}:sess_123:entry:entry_456"
