# Semibot: Memory Collection Relation Fix

**Priority:** Medium
**Status:** Not Started
**Type:** Bug
**Created:** 2026-02-06
**Last Updated:** 2026-02-06

## Overview

修复 memories 表缺少 collection_id 字段的问题，使记忆可以正确关联到记忆集合。

## Description

当前 `memories` 表无法关联到 `memory_collections` 表，导致：
- 记忆无法按集合分组管理
- 无法实现"为特定知识库添加记忆"的功能
- 与 `memory_chunks` 表设计不一致（chunks 有 collection_id）

## Features / Requirements

### 1. 添加 collection_id 字段

```sql
ALTER TABLE memories ADD COLUMN collection_id UUID;
CREATE INDEX idx_memories_collection ON memories(collection_id) WHERE collection_id IS NOT NULL;
COMMENT ON COLUMN memories.collection_id IS '逻辑外键，关联 memory_collections.id';
```

### 2. 更新搜索函数

```sql
-- 支持按 collection_id 搜索
CREATE OR REPLACE FUNCTION search_similar_memories(
    p_org_id UUID,
    p_agent_id UUID,
    p_collection_id UUID DEFAULT NULL,  -- 新增可选参数
    p_query_embedding VECTOR(1536),
    p_limit INTEGER DEFAULT 10,
    p_min_similarity FLOAT DEFAULT 0.7
)
...
WHERE m.org_id = p_org_id
    AND m.agent_id = p_agent_id
    AND (p_collection_id IS NULL OR m.collection_id = p_collection_id)
...
```

## Files to Modify

- `database/migrations/009_add_memory_collection_relation.sql` (新建)
- `apps/api/src/repositories/memory.repository.ts`

## Acceptance Criteria

- [ ] memories 表有 collection_id 字段
- [ ] 搜索函数支持按集合过滤
- [ ] 现有数据不受影响（collection_id 可为 NULL）
