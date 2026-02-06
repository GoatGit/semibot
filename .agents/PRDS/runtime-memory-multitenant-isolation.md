# Semibot: Runtime Memory 多租户隔离修复

**Priority:** Critical
**Status:** Not Started
**Type:** Security
**Created:** 2026-02-06
**Last Updated:** 2026-02-06

## Overview

修复 `LongTermMemory.search()` 方法中缺少的 org_id 多租户隔离过滤，防止跨租户数据泄露。

## Description

当前 `search()` 方法只通过 `agent_id` 过滤数据，没有使用 `org_id` 进行租户隔离。虽然实例初始化时可以传入 `org_id`，但搜索 SQL 查询中未使用该参数，存在安全风险。

### 当前问题

```python
# long_term.py:86-102 - 初始化时接受 org_id
def __init__(
    self,
    database_url: str,
    embedding_service: EmbeddingService,
    org_id: str | None = None,  # 接受但未使用
):
    self.org_id = org_id

# long_term.py:239-271 - search() 未按 org_id 过滤
base_query = """
    SELECT ...
    FROM memories
    WHERE agent_id = $2  -- 只过滤 agent_id，缺少 org_id
        AND (expires_at IS NULL OR expires_at > NOW())
        ...
"""
```

## Features / Requirements

### 1. 修复 search() 方法

- 添加 `org_id` 参数（可选，默认使用实例 org_id）
- WHERE 条件增加 `org_id = $X`
- 如果 org_id 为 None，记录安全警告日志

### 2. 修复 get_by_agent() 方法

- 同样添加 org_id 过滤条件

### 3. 添加安全日志

- 当未提供 org_id 时记录 WARN 级别日志
- 便于安全审计和问题排查

## Files to Modify

- `runtime/src/memory/long_term.py`
- `runtime/src/memory/base.py` (更新接口定义)

## Code Changes

```python
# long_term.py search() 方法修改
async def search(
    self,
    agent_id: str,
    query: str,
    limit: int = DEFAULT_SEARCH_LIMIT,
    min_importance: float = 0.0,
    min_similarity: float = DEFAULT_MIN_SIMILARITY,
    memory_type: str | None = None,
    org_id: str | None = None,  # 新增参数
) -> list[MemorySearchResult]:
    effective_org_id = org_id or self.org_id

    if not effective_org_id:
        logger.warning(
            "search_without_org_id",
            agent_id=agent_id,
            message="Searching without org_id may expose cross-tenant data",
        )

    # 更新 SQL 查询
    base_query = """
        SELECT
            id, content, memory_type, importance, metadata, created_at,
            1 - (embedding <=> $1::vector) as similarity
        FROM memories
        WHERE agent_id = $2
            AND org_id = $3  -- 新增 org_id 过滤
            AND (expires_at IS NULL OR expires_at > NOW())
            AND importance >= $4
            AND 1 - (embedding <=> $1::vector) >= $5
    """
```

## Testing Requirements

### Unit Tests

- [ ] 测试带 org_id 的搜索只返回该租户数据
- [ ] 测试不带 org_id 时记录警告日志
- [ ] 测试使用实例 org_id 的默认行为

### Integration Tests

- [ ] 模拟跨租户攻击场景，验证隔离有效
- [ ] 验证 org_id + agent_id 组合过滤正确

## Acceptance Criteria

- [ ] search() 方法增加 org_id 过滤
- [ ] get_by_agent() 方法增加 org_id 过滤
- [ ] 未提供 org_id 时记录安全警告
- [ ] 接口定义更新
- [ ] 单元测试验证隔离有效
