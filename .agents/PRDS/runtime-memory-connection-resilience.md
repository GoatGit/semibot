# Semibot: Runtime Memory 连接容错与重试机制

**Priority:** High
**Status:** Not Started
**Type:** Enhancement
**Created:** 2026-02-06
**Last Updated:** 2026-02-06

## Overview

为 ShortTermMemory (Redis) 和 LongTermMemory (PostgreSQL) 添加连接重试机制和容错处理，提高系统稳定性。

## Description

当前模块缺少连接失败重试机制：
- `ShortTermMemory` 没有类似 `EmbeddingService` 的 `@retry` 装饰器
- `LongTermMemory` 连接池耗尽时无处理逻辑
- embedding API 调用失败会直接传播到上层

### 当前问题

```python
# short_term.py:82-90 - 无重试机制
async def _get_client(self) -> redis.Redis:
    if self._client is None:
        self._client = redis.from_url(...)  # 连接失败直接抛异常
    return self._client

# long_term.py:105-113 - 连接池耗尽无处理
async def _get_pool(self) -> asyncpg.Pool:
    if self._pool is None:
        self._pool = await asyncpg.create_pool(
            self.database_url,
            min_size=2,
            max_size=10,  # 硬编码，耗尽时无处理
        )
    return self._pool

# 对比 embedding.py:104-107 - 有重试机制
@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=10),
)
async def embed(self, text: str) -> EmbeddingResult:
```

## Features / Requirements

### 1. ShortTermMemory 添加重试机制

- Redis 操作添加 `@retry` 装饰器
- 配置合理的重试次数和退避策略
- 连接失败时记录错误日志

### 2. LongTermMemory 连接池优化

- 提取连接池配置为常量
- 添加连接池获取超时处理
- 添加连接失败重试

### 3. 统一错误处理

- 创建 `MemoryConnectionError` 异常类
- 区分临时性错误（可重试）和永久性错误
- 添加优雅降级策略

### 4. 资源清理保证

- 添加 `__aenter__` / `__aexit__` 支持 async with
- 确保异常情况下资源正确释放

## Files to Modify

- `runtime/src/memory/short_term.py`
- `runtime/src/memory/long_term.py`
- `runtime/src/constants/config.py` (添加常量)

## Code Changes

```python
# constants/config.py 添加
REDIS_MAX_RETRIES = 3
REDIS_RETRY_DELAY_BASE = 1  # seconds
REDIS_RETRY_DELAY_MAX = 10

PG_POOL_MIN_SIZE = 2
PG_POOL_MAX_SIZE = 10
PG_POOL_ACQUIRE_TIMEOUT = 30  # seconds
PG_MAX_RETRIES = 3
```

```python
# short_term.py 修改
from tenacity import retry, stop_after_attempt, wait_exponential

@retry(
    stop=stop_after_attempt(REDIS_MAX_RETRIES),
    wait=wait_exponential(multiplier=1, min=REDIS_RETRY_DELAY_BASE, max=REDIS_RETRY_DELAY_MAX),
)
async def save(self, ...):
    # 现有逻辑

async def __aenter__(self):
    await self._get_client()
    return self

async def __aexit__(self, exc_type, exc_val, exc_tb):
    await self.close()
```

```python
# long_term.py 修改
async def _get_pool(self) -> asyncpg.Pool:
    if self._pool is None:
        try:
            self._pool = await asyncpg.create_pool(
                self.database_url,
                min_size=PG_POOL_MIN_SIZE,
                max_size=PG_POOL_MAX_SIZE,
                command_timeout=PG_POOL_ACQUIRE_TIMEOUT,
            )
        except Exception as e:
            logger.error("database_pool_creation_failed", error=str(e))
            raise MemoryConnectionError("Failed to create database pool") from e
    return self._pool
```

## Testing Requirements

### Unit Tests

- [ ] 测试 Redis 连接失败后重试成功
- [ ] 测试 Redis 连接失败达到最大重试次数
- [ ] 测试 PostgreSQL 连接池创建失败处理
- [ ] 测试 async with 上下文管理器正确释放资源

### Integration Tests

- [ ] 模拟 Redis 临时不可用后恢复
- [ ] 模拟 PostgreSQL 连接池耗尽场景

## Acceptance Criteria

- [ ] ShortTermMemory 添加重试装饰器
- [ ] LongTermMemory 连接池配置提取为常量
- [ ] 连接失败时有明确的错误日志
- [ ] 支持 async with 上下文管理
- [ ] 硬编码值提取到 config.py
