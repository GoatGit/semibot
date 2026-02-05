# Semibot: Database Security Function Fix

**Priority:** Critical
**Status:** Not Started
**Type:** Bug
**Created:** 2026-02-06
**Last Updated:** 2026-02-06

## Overview

修复数据库向量搜索函数的多租户隔离漏洞，防止跨租户数据泄露。

## Description

`search_similar_memories` 和 `search_similar_chunks` 两个 PostgreSQL 函数缺少 `org_id` 参数，存在严重的跨租户数据泄露风险。攻击者如果获取或猜测到 `agent_id` 或 `collection_id`，可以访问其他租户的记忆和文档数据。

### 当前问题

```sql
-- search_similar_memories 只通过 agent_id 过滤
CREATE FUNCTION search_similar_memories(
    p_agent_id UUID,  -- 缺少 org_id 参数
    ...
)

-- search_similar_chunks 只通过 collection_id 过滤
CREATE FUNCTION search_similar_chunks(
    p_collection_id UUID,  -- 缺少 org_id 参数
    ...
)
```

## Features / Requirements

### 1. 修复 search_similar_memories 函数

- 添加 `p_org_id UUID` 作为第一个参数
- WHERE 条件增加 `m.org_id = p_org_id`
- 更新所有调用该函数的代码

### 2. 修复 search_similar_chunks 函数

- 添加 `p_org_id UUID` 作为第一个参数
- WHERE 条件增加 `c.org_id = p_org_id`
- 更新所有调用该函数的代码

## Files to Modify

- `database/migrations/005_fix_security_functions.sql` (新建)
- `apps/api/src/repositories/memory.repository.ts`
- `apps/api/src/services/memory.service.ts`

## Migration Script

```sql
-- 005_fix_security_functions.sql

-- 1. 删除旧函数
DROP FUNCTION IF EXISTS search_similar_memories(UUID, VECTOR(1536), INTEGER, FLOAT);
DROP FUNCTION IF EXISTS search_similar_chunks(UUID, VECTOR(1536), INTEGER, FLOAT);

-- 2. 创建修复后的 search_similar_memories
CREATE OR REPLACE FUNCTION search_similar_memories(
    p_org_id UUID,
    p_agent_id UUID,
    p_query_embedding VECTOR(1536),
    p_limit INTEGER DEFAULT 10,
    p_min_similarity FLOAT DEFAULT 0.7
)
RETURNS TABLE (
    id UUID,
    content TEXT,
    memory_type VARCHAR(50),
    importance FLOAT,
    similarity FLOAT,
    metadata JSONB,
    created_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        m.id,
        m.content,
        m.memory_type,
        m.importance,
        (1 - (m.embedding <=> p_query_embedding))::FLOAT as similarity,
        m.metadata,
        m.created_at
    FROM memories m
    WHERE m.org_id = p_org_id
        AND m.agent_id = p_agent_id
        AND (m.expires_at IS NULL OR m.expires_at > NOW())
        AND (1 - (m.embedding <=> p_query_embedding)) >= p_min_similarity
    ORDER BY m.embedding <=> p_query_embedding
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- 3. 创建修复后的 search_similar_chunks
CREATE OR REPLACE FUNCTION search_similar_chunks(
    p_org_id UUID,
    p_collection_id UUID,
    p_query_embedding VECTOR(1536),
    p_limit INTEGER DEFAULT 10,
    p_min_similarity FLOAT DEFAULT 0.7
)
RETURNS TABLE (
    id UUID,
    document_id UUID,
    content TEXT,
    chunk_index INTEGER,
    similarity FLOAT,
    metadata JSONB
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        c.id,
        c.document_id,
        c.content,
        c.chunk_index,
        (1 - (c.embedding <=> p_query_embedding))::FLOAT as similarity,
        c.metadata
    FROM memory_chunks c
    WHERE c.org_id = p_org_id
        AND c.collection_id = p_collection_id
        AND (1 - (c.embedding <=> p_query_embedding)) >= p_min_similarity
    ORDER BY c.embedding <=> p_query_embedding
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;
```

## Testing Requirements

### Unit Tests

- [ ] 验证函数调用必须传入正确的 org_id
- [ ] 验证跨租户调用返回空结果
- [ ] 验证相同租户内搜索正常工作

### Integration Tests

- [ ] 模拟跨租户攻击场景，验证隔离有效

## Acceptance Criteria

- [ ] 两个函数都添加了 org_id 参数
- [ ] 所有调用方代码已更新
- [ ] 跨租户搜索返回空结果
- [ ] 迁移脚本可重复执行（幂等）
- [ ] 单元测试通过
