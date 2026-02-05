"""Embedding service for generating vector representations of text."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

import httpx
from tenacity import retry, stop_after_attempt, wait_exponential

from src.utils.logging import get_logger

# Constants
DEFAULT_EMBEDDING_MODEL = "text-embedding-ada-002"
EMBEDDING_DIMENSION = 1536
EMBEDDING_BATCH_SIZE = 100
EMBEDDING_REQUEST_TIMEOUT = 30


logger = get_logger(__name__)


@dataclass
class EmbeddingResult:
    """Result from an embedding request."""

    embedding: list[float]
    model: str
    tokens_used: int = 0


class EmbeddingProvider(ABC):
    """Abstract base class for embedding providers."""

    @abstractmethod
    async def embed(self, text: str) -> EmbeddingResult:
        """
        Generate embedding for a single text.

        Args:
            text: Text to embed

        Returns:
            EmbeddingResult with vector representation
        """
        pass

    @abstractmethod
    async def embed_batch(self, texts: list[str]) -> list[EmbeddingResult]:
        """
        Generate embeddings for multiple texts.

        Args:
            texts: List of texts to embed

        Returns:
            List of EmbeddingResult objects
        """
        pass


class OpenAIEmbeddingProvider(EmbeddingProvider):
    """OpenAI embedding provider using text-embedding-ada-002."""

    def __init__(
        self,
        api_key: str,
        model: str = DEFAULT_EMBEDDING_MODEL,
        base_url: str = "https://api.openai.com/v1",
    ):
        """
        Initialize OpenAI embedding provider.

        Args:
            api_key: OpenAI API key
            model: Embedding model to use
            base_url: API base URL
        """
        self.api_key = api_key
        self.model = model
        self.base_url = base_url
        self._client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client."""
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                timeout=EMBEDDING_REQUEST_TIMEOUT,
            )
        return self._client

    async def close(self) -> None:
        """Close the HTTP client."""
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=10),
    )
    async def embed(self, text: str) -> EmbeddingResult:
        """
        Generate embedding for a single text.

        Args:
            text: Text to embed

        Returns:
            EmbeddingResult with vector representation
        """
        client = await self._get_client()

        response = await client.post(
            "/embeddings",
            json={
                "input": text,
                "model": self.model,
            },
        )
        response.raise_for_status()
        data = response.json()

        embedding = data["data"][0]["embedding"]
        tokens_used = data.get("usage", {}).get("total_tokens", 0)

        return EmbeddingResult(
            embedding=embedding,
            model=self.model,
            tokens_used=tokens_used,
        )

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=10),
    )
    async def embed_batch(self, texts: list[str]) -> list[EmbeddingResult]:
        """
        Generate embeddings for multiple texts.

        Args:
            texts: List of texts to embed

        Returns:
            List of EmbeddingResult objects
        """
        if not texts:
            return []

        # Process in batches to avoid API limits
        results: list[EmbeddingResult] = []
        for i in range(0, len(texts), EMBEDDING_BATCH_SIZE):
            batch = texts[i : i + EMBEDDING_BATCH_SIZE]
            if len(texts) > EMBEDDING_BATCH_SIZE:
                logger.info(
                    "embedding_batch_processing",
                    batch_start=i,
                    batch_size=len(batch),
                    total=len(texts),
                    limit=EMBEDDING_BATCH_SIZE,
                )

            client = await self._get_client()
            response = await client.post(
                "/embeddings",
                json={
                    "input": batch,
                    "model": self.model,
                },
            )
            response.raise_for_status()
            data = response.json()

            tokens_used = data.get("usage", {}).get("total_tokens", 0)
            tokens_per_text = tokens_used // len(batch) if batch else 0

            for item in data["data"]:
                results.append(
                    EmbeddingResult(
                        embedding=item["embedding"],
                        model=self.model,
                        tokens_used=tokens_per_text,
                    )
                )

        return results


class EmbeddingService:
    """
    High-level embedding service with caching and provider abstraction.

    Example:
        ```python
        service = EmbeddingService(
            provider=OpenAIEmbeddingProvider(api_key="sk-...")
        )

        # Single embedding
        result = await service.embed("Hello, world!")
        vector = result.embedding

        # Batch embedding
        results = await service.embed_batch(["Hello", "World"])
        ```
    """

    def __init__(
        self,
        provider: EmbeddingProvider,
        cache: Any | None = None,
    ):
        """
        Initialize embedding service.

        Args:
            provider: Embedding provider implementation
            cache: Optional cache implementation
        """
        self.provider = provider
        self.cache = cache

    async def embed(self, text: str) -> EmbeddingResult:
        """
        Generate embedding for text with optional caching.

        Args:
            text: Text to embed

        Returns:
            EmbeddingResult with vector representation
        """
        # Check cache first
        if self.cache:
            cached = await self.cache.get(text)
            if cached:
                logger.debug("embedding_cache_hit", text_length=len(text))
                return cached

        # Generate embedding
        result = await self.provider.embed(text)

        # Store in cache
        if self.cache:
            await self.cache.set(text, result)

        return result

    async def embed_batch(self, texts: list[str]) -> list[EmbeddingResult]:
        """
        Generate embeddings for multiple texts.

        Args:
            texts: List of texts to embed

        Returns:
            List of EmbeddingResult objects
        """
        if not texts:
            return []

        # For batch operations, we skip cache for simplicity
        # In production, you might want to check cache for each text
        return await self.provider.embed_batch(texts)

    async def close(self) -> None:
        """Close the service and release resources."""
        if hasattr(self.provider, "close"):
            await self.provider.close()
