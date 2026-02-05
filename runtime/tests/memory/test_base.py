"""Unit tests for MemorySystem."""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

# Add src to path to avoid importing through src/__init__.py
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from memory.base import (
    LongTermMemoryInterface,
    MemoryEntry,
    MemorySearchResult,
    MemorySystem,
    ShortTermMemoryInterface,
)


@pytest.fixture
def mock_short_term():
    """Create a mock short-term memory."""
    mock = AsyncMock(spec=ShortTermMemoryInterface)
    mock.get_session_context.return_value = [
        MemoryEntry(
            id="entry_1",
            content="First message",
            agent_id="agent_123",
            session_id="sess_123",
            created_at=datetime.now(timezone.utc),
        ),
        MemoryEntry(
            id="entry_2",
            content="Second message",
            agent_id="agent_123",
            session_id="sess_123",
            created_at=datetime.now(timezone.utc),
        ),
    ]
    return mock


@pytest.fixture
def mock_long_term():
    """Create a mock long-term memory."""
    mock = AsyncMock(spec=LongTermMemoryInterface)
    entry = MemoryEntry(
        id="mem_1",
        content="User prefers Celsius",
        agent_id="agent_123",
        importance=0.8,
        created_at=datetime.now(timezone.utc),
    )
    mock.search.return_value = [
        MemorySearchResult(entry=entry, score=0.95, distance=0.05)
    ]
    mock.save.return_value = "new_entry_id"
    mock.delete.return_value = True
    return mock


class TestMemorySystemInit:
    """Tests for MemorySystem initialization."""

    def test_init_with_both_memories(self, mock_short_term, mock_long_term):
        """Test initialization with both memory types."""
        system = MemorySystem(
            short_term=mock_short_term,
            long_term=mock_long_term,
        )
        assert system.short_term == mock_short_term
        assert system.long_term == mock_long_term

    def test_init_with_short_term_only(self, mock_short_term):
        """Test initialization with short-term only."""
        system = MemorySystem(short_term=mock_short_term)
        assert system.short_term == mock_short_term
        assert system.long_term is None

    def test_init_with_long_term_only(self, mock_long_term):
        """Test initialization with long-term only."""
        system = MemorySystem(long_term=mock_long_term)
        assert system.short_term is None
        assert system.long_term == mock_long_term

    def test_init_empty(self):
        """Test initialization without memories."""
        system = MemorySystem()
        assert system.short_term is None
        assert system.long_term is None


class TestMemorySystemShortTerm:
    """Tests for MemorySystem short-term operations."""

    @pytest.mark.asyncio
    async def test_get_short_term(self, mock_short_term):
        """Test getting short-term context."""
        system = MemorySystem(short_term=mock_short_term)

        context = await system.get_short_term("sess_123")

        assert "First message" in context
        assert "Second message" in context
        mock_short_term.get_session_context.assert_called_once_with("sess_123")

    @pytest.mark.asyncio
    async def test_get_short_term_empty(self, mock_short_term):
        """Test getting empty short-term context."""
        mock_short_term.get_session_context.return_value = []
        system = MemorySystem(short_term=mock_short_term)

        context = await system.get_short_term("sess_123")

        assert context == ""

    @pytest.mark.asyncio
    async def test_get_short_term_no_memory(self):
        """Test getting short-term when no memory configured."""
        system = MemorySystem()

        context = await system.get_short_term("sess_123")

        assert context == ""

    @pytest.mark.asyncio
    async def test_save_short_term(self, mock_short_term):
        """Test saving to short-term memory."""
        system = MemorySystem(short_term=mock_short_term)

        await system.save_short_term(
            session_id="sess_123",
            content="New message",
            agent_id="agent_123",
        )

        mock_short_term.save.assert_called_once()

    @pytest.mark.asyncio
    async def test_save_short_term_no_memory(self):
        """Test saving when no short-term memory configured."""
        system = MemorySystem()

        # Should not raise
        await system.save_short_term(
            session_id="sess_123",
            content="New message",
        )

    @pytest.mark.asyncio
    async def test_clear_session(self, mock_short_term):
        """Test clearing a session."""
        system = MemorySystem(short_term=mock_short_term)

        await system.clear_session("sess_123")

        mock_short_term.clear_session.assert_called_once_with("sess_123")


class TestMemorySystemLongTerm:
    """Tests for MemorySystem long-term operations."""

    @pytest.mark.asyncio
    async def test_search_long_term(self, mock_long_term):
        """Test searching long-term memory."""
        system = MemorySystem(long_term=mock_long_term)

        context = await system.search_long_term(
            agent_id="agent_123",
            query="temperature preference",
            limit=5,
        )

        assert "User prefers Celsius" in context
        mock_long_term.search.assert_called_once()

    @pytest.mark.asyncio
    async def test_search_long_term_empty(self, mock_long_term):
        """Test searching when no results."""
        mock_long_term.search.return_value = []
        system = MemorySystem(long_term=mock_long_term)

        context = await system.search_long_term(
            agent_id="agent_123",
            query="nonexistent",
        )

        assert context == ""

    @pytest.mark.asyncio
    async def test_search_long_term_no_memory(self):
        """Test searching when no long-term memory configured."""
        system = MemorySystem()

        context = await system.search_long_term(
            agent_id="agent_123",
            query="test",
        )

        assert context == ""

    @pytest.mark.asyncio
    async def test_save_long_term(self, mock_long_term):
        """Test saving to long-term memory."""
        system = MemorySystem(long_term=mock_long_term)

        entry_id = await system.save_long_term(
            agent_id="agent_123",
            content="New preference",
            importance=0.9,
        )

        assert entry_id == "new_entry_id"
        mock_long_term.save.assert_called_once()

    @pytest.mark.asyncio
    async def test_save_long_term_no_memory(self):
        """Test saving when no long-term memory configured."""
        system = MemorySystem()

        entry_id = await system.save_long_term(
            agent_id="agent_123",
            content="New preference",
        )

        assert entry_id == ""

    @pytest.mark.asyncio
    async def test_delete_long_term(self, mock_long_term):
        """Test deleting from long-term memory."""
        system = MemorySystem(long_term=mock_long_term)

        result = await system.delete_long_term("entry_123")

        assert result is True
        mock_long_term.delete.assert_called_once_with("entry_123")

    @pytest.mark.asyncio
    async def test_delete_long_term_no_memory(self):
        """Test deleting when no long-term memory configured."""
        system = MemorySystem()

        result = await system.delete_long_term("entry_123")

        assert result is False


class TestMemoryEntry:
    """Tests for MemoryEntry dataclass."""

    def test_to_dict(self):
        """Test converting to dictionary."""
        entry = MemoryEntry(
            id="entry_1",
            content="Test content",
            agent_id="agent_123",
            session_id="sess_123",
            importance=0.8,
            metadata={"key": "value"},
            created_at=datetime(2026, 2, 5, 12, 0, 0, tzinfo=timezone.utc),
        )

        data = entry.to_dict()

        assert data["id"] == "entry_1"
        assert data["content"] == "Test content"
        assert data["agent_id"] == "agent_123"
        assert data["importance"] == 0.8
        assert data["metadata"] == {"key": "value"}

    def test_from_dict(self):
        """Test creating from dictionary."""
        data = {
            "id": "entry_1",
            "content": "Test content",
            "agent_id": "agent_123",
            "session_id": "sess_123",
            "importance": 0.8,
            "metadata": {"key": "value"},
            "created_at": "2026-02-05T12:00:00+00:00",
            "expires_at": None,
        }

        entry = MemoryEntry.from_dict(data)

        assert entry.id == "entry_1"
        assert entry.content == "Test content"
        assert entry.agent_id == "agent_123"
        assert entry.importance == 0.8


class TestMemorySearchResult:
    """Tests for MemorySearchResult dataclass."""

    def test_content_property(self):
        """Test content property."""
        entry = MemoryEntry(
            id="entry_1",
            content="Test content",
            agent_id="agent_123",
            created_at=datetime.now(timezone.utc),
        )
        result = MemorySearchResult(entry=entry, score=0.95, distance=0.05)

        assert result.content == "Test content"
