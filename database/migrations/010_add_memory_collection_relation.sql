-- ============================================================================
-- 010_add_memory_collection_relation.sql
-- 修复 memories 表缺少 collection_id 关联
-- ============================================================================

-- ============================================================================
-- 1. 添加 collection_id 字段
-- ============================================================================
ALTER TABLE memories ADD COLUMN IF NOT EXISTS collection_id UUID;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_memories_collection
    ON memories(collection_id) WHERE collection_id IS NOT NULL;

-- 添加注释
COMMENT ON COLUMN memories.collection_id IS '逻辑外键，关联 memory_collections.id，用于记忆分组管理';

-- ============================================================================
-- 2. 更新 search_similar_memories 函数支持 collection 过滤
-- ============================================================================

-- 删除旧函数（新签名）
DROP FUNCTION IF EXISTS search_similar_memories(UUID, UUID, VECTOR(1536), INTEGER, FLOAT);

-- 创建支持 collection_id 的新函数
CREATE OR REPLACE FUNCTION search_similar_memories(
    p_org_id UUID,
    p_agent_id UUID,
    p_query_embedding VECTOR(1536),
    p_limit INTEGER DEFAULT 10,
    p_min_similarity FLOAT DEFAULT 0.7,
    p_collection_id UUID DEFAULT NULL
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
    -- 边界检查日志
    IF p_limit > 100 THEN
        RAISE NOTICE '[search_similar_memories] limit 超出建议值，已限制为 100 (请求: %)', p_limit;
        p_limit := 100;
    END IF;

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
        AND (p_collection_id IS NULL OR m.collection_id = p_collection_id)
        AND (m.expires_at IS NULL OR m.expires_at > NOW())
        AND (1 - (m.embedding <=> p_query_embedding)) >= p_min_similarity
    ORDER BY m.embedding <=> p_query_embedding
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION search_similar_memories(UUID, UUID, VECTOR(1536), INTEGER, FLOAT, UUID)
    IS '搜索相似记忆的辅助函数（支持 collection 过滤）';

-- ============================================================================
-- 3. 验证修改成功
-- ============================================================================
-- 可通过以下查询验证：
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'memories' AND column_name = 'collection_id';
