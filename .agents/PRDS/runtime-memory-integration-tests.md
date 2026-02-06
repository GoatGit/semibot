# Semibot: Runtime Memory 集成测试补充

**Priority:** High
**Status:** Not Started
**Type:** Test
**Created:** 2026-02-06
**Last Updated:** 2026-02-06

## Overview

为 memory 模块补充集成测试，使用真实的 Redis 和 PostgreSQL 服务验证功能正确性。

## Description

当前测试全部使用 Mock，无法验证：
- 真实 Redis sorted set 行为
- 真实 pgvector 向量搜索
- 连接池实际行为
- TTL 过期机制
- 并发写入一致性

### 缺失的测试场景

| 场景 | 重要性 |
|------|--------|
| 并发写入测试 | HIGH |
| Redis/PostgreSQL 连接失败恢复 | HIGH |
| 大批量 embedding 分页 | MEDIUM |
| TTL 过期行为验证 | MEDIUM |
| memory_type 过滤测试 | MEDIUM |
| update_importance 方法 | MEDIUM |
| get_by_agent 方法 | MEDIUM |

## Features / Requirements

### 1. 设置测试基础设施

- 使用 testcontainers-python 管理 Redis 和 PostgreSQL
- 创建测试 fixture 自动启停容器
- 初始化 pgvector 扩展和表结构

### 2. ShortTermMemory 集成测试

- 实际 Redis sorted set 操作验证
- TTL 过期测试（使用时间模拟）
- 并发 save 测试
- 会话条目上限截断验证

### 3. LongTermMemory 集成测试

- pgvector 向量相似度搜索验证
- 多租户隔离验证
- importance 更新验证
- 过期记忆过滤验证

### 4. EmbeddingService 集成测试

- 真实 OpenAI API 调用（使用测试 key）
- 批量 embedding 分页验证

## Files to Create

- `runtime/tests/memory/conftest.py` (fixture)
- `runtime/tests/memory/integration/__init__.py`
- `runtime/tests/memory/integration/test_short_term_integration.py`
- `runtime/tests/memory/integration/test_long_term_integration.py`

## Code Examples

```python
# runtime/tests/memory/conftest.py
import pytest
from testcontainers.postgres import PostgresContainer
from testcontainers.redis import RedisContainer

@pytest.fixture(scope="session")
def redis_container():
    with RedisContainer() as redis:
        yield redis

@pytest.fixture(scope="session")
def postgres_container():
    with PostgresContainer("pgvector/pgvector:pg16") as pg:
        # 初始化 schema
        conn = pg.get_connection_url()
        # 执行 migrations...
        yield pg

@pytest.fixture
async def short_term_memory(redis_container):
    memory = ShortTermMemory(redis_url=redis_container.get_connection_url())
    yield memory
    await memory.close()

@pytest.fixture
async def long_term_memory(postgres_container, mock_embedding_service):
    memory = LongTermMemory(
        database_url=postgres_container.get_connection_url(),
        embedding_service=mock_embedding_service,
    )
    yield memory
    await memory.close()
```

```python
# runtime/tests/memory/integration/test_short_term_integration.py
import pytest
import asyncio

@pytest.mark.integration
class TestShortTermMemoryIntegration:

    @pytest.mark.asyncio
    async def test_ttl_expiration(self, short_term_memory):
        """验证 TTL 过期后条目自动删除。"""
        await short_term_memory.save(
            session_id="sess_1",
            content="Temporary",
            ttl_seconds=1,
        )

        # 立即可读
        entries = await short_term_memory.get_session_context("sess_1")
        assert len(entries) == 1

        # 等待过期
        await asyncio.sleep(2)

        entries = await short_term_memory.get_session_context("sess_1")
        assert len(entries) == 0

    @pytest.mark.asyncio
    async def test_concurrent_writes(self, short_term_memory):
        """验证并发写入不丢失数据。"""
        async def write_entry(i):
            await short_term_memory.save(
                session_id="sess_concurrent",
                content=f"Entry {i}",
            )

        await asyncio.gather(*[write_entry(i) for i in range(50)])

        entries = await short_term_memory.get_session_context(
            "sess_concurrent", limit=100
        )
        assert len(entries) == 50
```

## Testing Requirements

### Prerequisites

- Docker 运行环境
- testcontainers-python 依赖
- pgvector Docker 镜像

### Test Markers

```ini
# pytest.ini
[pytest]
markers =
    integration: marks tests as integration tests (deselect with '-m "not integration"')
```

## Acceptance Criteria

- [ ] testcontainers fixture 可正常启停容器
- [ ] ShortTermMemory 集成测试覆盖所有方法
- [ ] LongTermMemory 集成测试覆盖所有方法
- [ ] TTL 过期测试通过
- [ ] 并发写入测试通过
- [ ] 多租户隔离集成测试通过
- [ ] CI 可选择性跳过集成测试
