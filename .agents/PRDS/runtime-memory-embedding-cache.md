# Semibot: Runtime Memory Embedding 缓存实现

**Priority:** Medium
**Status:** Not Started
**Type:** Enhancement
**Created:** 2026-02-06
**Last Updated:** 2026-02-06

## Overview

实现 EmbeddingService 的缓存机制，减少重复文本的 API 调用成本。

## Description

当前 `EmbeddingService` 接受 `cache` 参数但没有提供具体的缓存实现类。每次相同文本的 embedding 请求都会调用 OpenAI API，造成不必要的成本和延迟。

### 当前问题

```python
# embedding.py:214-227
def __init__(
    self,
    provider: EmbeddingProvider,
    cache: Any | None = None,  # 参数存在但无具体实现
):
    self.provider = provider
    self.cache = cache  # 只是存储，无默认实现
```

## Features / Requirements

### 1. 实现 Redis 缓存

```python
class RedisEmbeddingCache:
    """Redis-based embedding cache."""

    def __init__(
        self,
        redis_url: str,
        ttl_seconds: int = 86400 * 7,  # 默认 7 天
        key_prefix: str = "semibot:embedding_cache",
    ):
        ...

    async def get(self, text: str) -> EmbeddingResult | None:
        """Get cached embedding by text hash."""
        ...

    async def set(self, text: str, result: EmbeddingResult) -> None:
        """Cache embedding result."""
        ...
```

### 2. 缓存键策略

- 使用文本内容的 SHA256 哈希作为键
- 前缀隔离避免键冲突
- 支持配置 TTL

### 3. 批量操作优化

- `embed_batch` 也支持缓存
- 只对缓存未命中的文本调用 API
- 保持结果顺序与输入一致

## Files to Create/Modify

- `runtime/src/memory/embedding.py` (添加 cache 类)
- `runtime/src/memory/__init__.py` (导出)

## Code Implementation

```python
# embedding.py 添加

import hashlib
import json
import redis.asyncio as redis

EMBEDDING_CACHE_TTL = 86400 * 7  # 7 days
EMBEDDING_CACHE_PREFIX = "semibot:embedding_cache"


class RedisEmbeddingCache:
    """Redis-based embedding cache using text hash as key."""

    def __init__(
        self,
        redis_url: str,
        ttl_seconds: int = EMBEDDING_CACHE_TTL,
        key_prefix: str = EMBEDDING_CACHE_PREFIX,
    ):
        self.redis_url = redis_url
        self.ttl_seconds = ttl_seconds
        self.key_prefix = key_prefix
        self._client: redis.Redis | None = None

    async def _get_client(self) -> redis.Redis:
        if self._client is None:
            self._client = redis.from_url(
                self.redis_url,
                encoding="utf-8",
                decode_responses=True,
            )
        return self._client

    def _hash_text(self, text: str) -> str:
        """Generate hash key for text."""
        return hashlib.sha256(text.encode()).hexdigest()[:32]

    def _cache_key(self, text: str) -> str:
        """Generate full cache key."""
        return f"{self.key_prefix}:{self._hash_text(text)}"

    async def get(self, text: str) -> EmbeddingResult | None:
        """Get cached embedding."""
        client = await self._get_client()
        key = self._cache_key(text)

        data = await client.get(key)
        if not data:
            return None

        try:
            parsed = json.loads(data)
            return EmbeddingResult(
                embedding=parsed["embedding"],
                model=parsed["model"],
                tokens_used=parsed.get("tokens_used", 0),
            )
        except (json.JSONDecodeError, KeyError):
            return None

    async def set(self, text: str, result: EmbeddingResult) -> None:
        """Cache embedding result."""
        client = await self._get_client()
        key = self._cache_key(text)

        data = json.dumps({
            "embedding": result.embedding,
            "model": result.model,
            "tokens_used": result.tokens_used,
        })

        await client.setex(key, self.ttl_seconds, data)

    async def close(self) -> None:
        """Close Redis connection."""
        if self._client:
            await self._client.aclose()
            self._client = None
```

## Testing Requirements

### Unit Tests

- [ ] 测试缓存命中返回正确结果
- [ ] 测试缓存未命中返回 None
- [ ] 测试缓存写入和读取一致性
- [ ] 测试 TTL 过期后缓存失效
- [ ] 测试文本哈希生成唯一键

### Integration Tests

- [ ] 真实 Redis 缓存读写测试
- [ ] 批量 embedding 部分缓存命中测试

## Acceptance Criteria

- [ ] RedisEmbeddingCache 类实现完成
- [ ] EmbeddingService 可使用缓存
- [ ] 缓存命中时不调用 API
- [ ] embed_batch 支持部分缓存命中
- [ ] 单元测试覆盖
- [ ] 更新 __init__.py 导出
