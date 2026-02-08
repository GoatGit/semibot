"""Embedding service for generating vector representations of text."""

from __future__ import annotations

import hashlib
import json
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

import httpx
import redis.asyncio as redis
from tenacity import retry, stop_after_attempt, wait_exponential

from src.constants import (
    DEFAULT_EMBEDDING_MODEL,
    EMBEDDING_BATCH_SIZE,
    EMBEDDING_CACHE_PREFIX,
    EMBEDDING_CACHE_TTL,
    EMBEDDING_MAX_RETRIES,
    EMBEDDING_REQUEST_TIMEOUT,
    EMBEDDING_RETRY_DELAY_BASE,
    EMBEDDING_RETRY_DELAY_MAX,
    REDIS_MAX_RETRIES,
    REDIS_RETRY_DELAY_BASE,
    REDIS_RETRY_DELAY_MAX,
)
from src.utils.logging import get_logger
from src.utils.validation import MemoryConnectionError


logger = get_logger(__name__)


@dataclass
class EmbeddingResult:
    """Result from an embedding request."""

    embedding: list[float]
    model: str
    tokens_used: int = 0


class RedisEmbeddingCache:
    """
    Redis-based embedding cache using text hash as key.

    Reduces API calls by caching embedding results for repeated text.
    Uses SHA256 hash of text content as cache key.

    Example:
        ```python
        cache = RedisEmbeddingCache(redis_url="redis://localhost:6379")

        # Check cache
        result = await cache.get("Hello, world!")
        if result is None:
            result = await provider.embed("Hello, world!")
            await cache.set("Hello, world!", result)
        ```
    """

    def __init__(
        self,
        redis_url: str,
        ttl_seconds: int = EMBEDDING_CACHE_TTL,
        key_prefix: str = EMBEDDING_CACHE_PREFIX,
    ):
        """
        Initialize embedding cache.

        Args:
            redis_url: Redis connection URL
            ttl_seconds: Cache TTL in seconds (default: 7 days)
            key_prefix: Redis key prefix for cache entries
        """
        self.redis_url = redis_url
        self.ttl_seconds = ttl_seconds
        self.key_prefix = key_prefix
        self._client: redis.Redis | None = None

    async def __aenter__(self) -> "RedisEmbeddingCache":
        """Async context manager entry."""
        await self._get_client()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        """Async context manager exit."""
        await self.close()

    @retry(
        stop=stop_after_attempt(REDIS_MAX_RETRIES),
        wait=wait_exponential(
            multiplier=1, min=REDIS_RETRY_DELAY_BASE, max=REDIS_RETRY_DELAY_MAX
        ),
        reraise=True,
    )
    async def _get_client(self) -> redis.Redis:
        """Get or create Redis client with retry logic."""
        if self._client is None:
            try:
                self._client = redis.from_url(
                    self.redis_url,
                    encoding="utf-8",
                    decode_responses=True,
                )
                # Test connection
                await self._client.ping()
                logger.info("embedding_cache_connected", redis_url=self.redis_url)
            except Exception as e:
                logger.error(
                    "embedding_cache_connection_failed",
                    redis_url=self.redis_url,
                    error=str(e),
                )
                self._client = None
                raise MemoryConnectionError(
                    f"Failed to connect to Redis for embedding cache: {e}"
                ) from e
        return self._client

    async def close(self) -> None:
        """Close the Redis connection."""
        if self._client:
            await self._client.aclose()
            self._client = None

    def _hash_text(self, text: str) -> str:
        """Generate hash key for text using SHA256."""
        return hashlib.sha256(text.encode("utf-8")).hexdigest()[:32]

    def _cache_key(self, text: str) -> str:
        """Generate full cache key with prefix."""
        return f"{self.key_prefix}:{self._hash_text(text)}"

    async def get(self, text: str) -> EmbeddingResult | None:
        """
        Get cached embedding for text.

        Args:
            text: Text to look up in cache

        Returns:
            EmbeddingResult if found in cache, None otherwise
        """
        client = await self._get_client()
        key = self._cache_key(text)

        data = await client.get(key)
        if not data:
            logger.debug("embedding_cache_miss", text_length=len(text))
            return None

        try:
            parsed = json.loads(data)
            logger.debug("embedding_cache_hit", text_length=len(text))
            return EmbeddingResult(
                embedding=parsed["embedding"],
                model=parsed["model"],
                tokens_used=parsed.get("tokens_used", 0),
            )
        except (json.JSONDecodeError, KeyError) as e:
            logger.warning(
                "embedding_cache_parse_error",
                key=key,
                error=str(e),
            )
            return None

    async def set(self, text: str, result: EmbeddingResult) -> None:
        """
        Cache embedding result.

        Args:
            text: Original text (used for key generation)
            result: EmbeddingResult to cache
        """
        client = await self._get_client()
        key = self._cache_key(text)

        data = json.dumps({
            "embedding": result.embedding,
            "model": result.model,
            "tokens_used": result.tokens_used,
        })

        await client.setex(key, self.ttl_seconds, data)
        logger.debug(
            "embedding_cache_set",
            text_length=len(text),
            ttl_seconds=self.ttl_seconds,
        )

    async def get_batch(self, texts: list[str]) -> dict[str, EmbeddingResult | None]:
        """
        Get cached embeddings for multiple texts.

        Args:
            texts: List of texts to look up

        Returns:
            Dict mapping text to EmbeddingResult (or None if not cached)
        """
        if not texts:
            return {}

        client = await self._get_client()
        keys = [self._cache_key(text) for text in texts]

        # Use pipeline for batch get
        async with client.pipeline() as pipe:
            for key in keys:
                pipe.get(key)
            results = await pipe.execute()

        cache_results: dict[str, EmbeddingResult | None] = {}
        hits = 0
        for text, data in zip(texts, results):
            if data:
                try:
                    parsed = json.loads(data)
                    cache_results[text] = EmbeddingResult(
                        embedding=parsed["embedding"],
                        model=parsed["model"],
                        tokens_used=parsed.get("tokens_used", 0),
                    )
                    hits += 1
                except (json.JSONDecodeError, KeyError):
                    cache_results[text] = None
            else:
                cache_results[text] = None

        logger.debug(
            "embedding_cache_batch_get",
            total=len(texts),
            hits=hits,
            misses=len(texts) - hits,
        )

        return cache_results

    async def set_batch(
        self, items: list[tuple[str, EmbeddingResult]]
    ) -> None:
        """
        Cache multiple embedding results.

        Args:
            items: List of (text, EmbeddingResult) tuples
        """
        if not items:
            return

        client = await self._get_client()

        async with client.pipeline() as pipe:
            for text, result in items:
                key = self._cache_key(text)
                data = json.dumps({
                    "embedding": result.embedding,
                    "model": result.model,
                    "tokens_used": result.tokens_used,
                })
                pipe.setex(key, self.ttl_seconds, data)
            await pipe.execute()

        logger.debug(
            "embedding_cache_batch_set",
            count=len(items),
            ttl_seconds=self.ttl_seconds,
        )

    async def delete(self, text: str) -> bool:
        """
        Delete cached embedding for text.

        Args:
            text: Text to remove from cache

        Returns:
            True if deleted, False if not found
        """
        client = await self._get_client()
        key = self._cache_key(text)
        deleted = await client.delete(key)
        return deleted > 0

    async def health_check(self) -> bool:
        """
        Check if Redis connection is healthy.

        Returns:
            True if Redis is reachable
        """
        try:
            client = await self._get_client()
            await client.ping()
            return True
        except Exception as e:
            logger.error("embedding_cache_health_check_failed", error=str(e))
            return False


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
        stop=stop_after_attempt(EMBEDDING_MAX_RETRIES),
        wait=wait_exponential(
            multiplier=1, min=EMBEDDING_RETRY_DELAY_BASE, max=EMBEDDING_RETRY_DELAY_MAX
        ),
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
        stop=stop_after_attempt(EMBEDDING_MAX_RETRIES),
        wait=wait_exponential(
            multiplier=1, min=EMBEDDING_RETRY_DELAY_BASE, max=EMBEDDING_RETRY_DELAY_MAX
        ),
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
        Generate embeddings for multiple texts with partial cache support.

        Args:
            texts: List of texts to embed

        Returns:
            List of EmbeddingResult objects in same order as input
        """
        if not texts:
            return []

        # If no cache, just call provider directly
        if not self.cache:
            return await self.provider.embed_batch(texts)

        # Check cache for all texts
        if hasattr(self.cache, "get_batch"):
            cache_results = await self.cache.get_batch(texts)
        else:
            # Fallback for caches without batch support
            cache_results = {}
            for text in texts:
                cache_results[text] = await self.cache.get(text)

        # Identify cache misses
        misses: list[tuple[int, str]] = []
        for i, text in enumerate(texts):
            if cache_results.get(text) is None:
                misses.append((i, text))

        # If all cached, return immediately
        if not misses:
            logger.debug(
                "embedding_batch_all_cached",
                total=len(texts),
            )
            return [cache_results[text] for text in texts]

        # Generate embeddings for cache misses only
        miss_texts = [text for _, text in misses]
        logger.debug(
            "embedding_batch_partial_cache",
            total=len(texts),
            cached=len(texts) - len(misses),
            to_generate=len(misses),
        )

        new_results = await self.provider.embed_batch(miss_texts)

        # Cache the new results
        if hasattr(self.cache, "set_batch"):
            await self.cache.set_batch(list(zip(miss_texts, new_results)))
        else:
            # Fallback for caches without batch support
            for text, result in zip(miss_texts, new_results):
                await self.cache.set(text, result)

        # Build final results list preserving original order
        final_results: list[EmbeddingResult] = []
        miss_idx = 0
        for i, text in enumerate(texts):
            cached = cache_results.get(text)
            if cached is not None:
                final_results.append(cached)
            else:
                final_results.append(new_results[miss_idx])
                miss_idx += 1

        return final_results

    async def close(self) -> None:
        """Close the service and release resources."""
        if self.cache and hasattr(self.cache, "close"):
            await self.cache.close()
        if hasattr(self.provider, "close"):
            await self.provider.close()
