"""Unit tests for EmbeddingService."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Add src to path to avoid importing through src/__init__.py
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from memory.embedding import (
    DEFAULT_EMBEDDING_MODEL,
    EMBEDDING_BATCH_SIZE,
    EMBEDDING_DIMENSION,
    EmbeddingResult,
    EmbeddingService,
    OpenAIEmbeddingProvider,
)


class TestEmbeddingResult:
    """Tests for EmbeddingResult dataclass."""

    def test_creation(self):
        """Test EmbeddingResult creation."""
        result = EmbeddingResult(
            embedding=[0.1] * 1536,
            model="text-embedding-ada-002",
            tokens_used=10,
        )
        assert len(result.embedding) == 1536
        assert result.model == "text-embedding-ada-002"
        assert result.tokens_used == 10

    def test_default_tokens(self):
        """Test default tokens_used value."""
        result = EmbeddingResult(
            embedding=[0.1],
            model="test-model",
        )
        assert result.tokens_used == 0


class TestOpenAIEmbeddingProvider:
    """Tests for OpenAIEmbeddingProvider."""

    def test_initialization(self):
        """Test provider initialization."""
        provider = OpenAIEmbeddingProvider(
            api_key="sk-test",
            model="text-embedding-ada-002",
        )
        assert provider.api_key == "sk-test"
        assert provider.model == "text-embedding-ada-002"
        assert provider.base_url == "https://api.openai.com/v1"

    def test_custom_base_url(self):
        """Test provider with custom base URL."""
        provider = OpenAIEmbeddingProvider(
            api_key="sk-test",
            base_url="https://custom.api.com/v1",
        )
        assert provider.base_url == "https://custom.api.com/v1"

    @pytest.mark.asyncio
    async def test_embed_single(self):
        """Test embedding a single text."""
        provider = OpenAIEmbeddingProvider(api_key="sk-test")

        mock_response = MagicMock()
        mock_response.json.return_value = {
            "data": [{"embedding": [0.1] * 1536}],
            "usage": {"total_tokens": 5},
        }
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        mock_client.is_closed = False
        provider._client = mock_client

        result = await provider.embed("Hello, world!")

        assert len(result.embedding) == 1536
        assert result.tokens_used == 5
        mock_client.post.assert_called_once()

    @pytest.mark.asyncio
    async def test_embed_batch(self):
        """Test embedding multiple texts."""
        provider = OpenAIEmbeddingProvider(api_key="sk-test")

        mock_response = MagicMock()
        mock_response.json.return_value = {
            "data": [
                {"embedding": [0.1] * 1536},
                {"embedding": [0.2] * 1536},
            ],
            "usage": {"total_tokens": 10},
        }
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        mock_client.is_closed = False
        provider._client = mock_client

        results = await provider.embed_batch(["Hello", "World"])

        assert len(results) == 2
        assert all(len(r.embedding) == 1536 for r in results)

    @pytest.mark.asyncio
    async def test_embed_batch_empty(self):
        """Test embedding empty list."""
        provider = OpenAIEmbeddingProvider(api_key="sk-test")

        results = await provider.embed_batch([])

        assert results == []

    @pytest.mark.asyncio
    async def test_close(self):
        """Test closing the provider."""
        provider = OpenAIEmbeddingProvider(api_key="sk-test")

        mock_client = AsyncMock()
        mock_client.is_closed = False
        provider._client = mock_client

        await provider.close()

        mock_client.aclose.assert_called_once()
        assert provider._client is None


class TestEmbeddingService:
    """Tests for EmbeddingService."""

    @pytest.fixture
    def mock_provider(self):
        """Create a mock embedding provider."""
        provider = AsyncMock()
        provider.embed.return_value = EmbeddingResult(
            embedding=[0.1] * 1536,
            model="test-model",
            tokens_used=5,
        )
        provider.embed_batch.return_value = [
            EmbeddingResult(embedding=[0.1] * 1536, model="test-model", tokens_used=5)
        ]
        return provider

    def test_initialization(self, mock_provider):
        """Test service initialization."""
        service = EmbeddingService(provider=mock_provider)
        assert service.provider == mock_provider
        assert service.cache is None

    def test_initialization_with_cache(self, mock_provider):
        """Test service initialization with cache."""
        mock_cache = MagicMock()
        service = EmbeddingService(provider=mock_provider, cache=mock_cache)
        assert service.cache == mock_cache

    @pytest.mark.asyncio
    async def test_embed_without_cache(self, mock_provider):
        """Test embedding without cache."""
        service = EmbeddingService(provider=mock_provider)

        result = await service.embed("Hello, world!")

        assert len(result.embedding) == 1536
        mock_provider.embed.assert_called_once_with("Hello, world!")

    @pytest.mark.asyncio
    async def test_embed_with_cache_miss(self, mock_provider):
        """Test embedding with cache miss."""
        mock_cache = AsyncMock()
        mock_cache.get.return_value = None

        service = EmbeddingService(provider=mock_provider, cache=mock_cache)

        result = await service.embed("Hello, world!")

        assert len(result.embedding) == 1536
        mock_cache.get.assert_called_once_with("Hello, world!")
        mock_cache.set.assert_called_once()
        mock_provider.embed.assert_called_once()

    @pytest.mark.asyncio
    async def test_embed_with_cache_hit(self, mock_provider):
        """Test embedding with cache hit."""
        cached_result = EmbeddingResult(
            embedding=[0.5] * 1536,
            model="cached-model",
            tokens_used=0,
        )
        mock_cache = AsyncMock()
        mock_cache.get.return_value = cached_result

        service = EmbeddingService(provider=mock_provider, cache=mock_cache)

        result = await service.embed("Hello, world!")

        assert result == cached_result
        mock_cache.get.assert_called_once()
        mock_provider.embed.assert_not_called()

    @pytest.mark.asyncio
    async def test_embed_batch(self, mock_provider):
        """Test batch embedding."""
        service = EmbeddingService(provider=mock_provider)

        results = await service.embed_batch(["Hello", "World"])

        assert len(results) == 1  # Based on mock return
        mock_provider.embed_batch.assert_called_once_with(["Hello", "World"])

    @pytest.mark.asyncio
    async def test_embed_batch_empty(self, mock_provider):
        """Test batch embedding with empty list."""
        service = EmbeddingService(provider=mock_provider)

        results = await service.embed_batch([])

        assert results == []
        mock_provider.embed_batch.assert_not_called()

    @pytest.mark.asyncio
    async def test_close(self, mock_provider):
        """Test closing the service."""
        service = EmbeddingService(provider=mock_provider)

        await service.close()

        mock_provider.close.assert_called_once()
