-- ============================================================================
-- 005_fix_security_functions.sql
-- 修复向量搜索函数的多租户隔离漏洞
-- ============================================================================

-- 注意：此迁移修复了严重的安全漏洞
-- search_similar_memories 和 search_similar_chunks 函数缺少 org_id 参数
-- 可能导致跨租户数据泄露

-- ============================================================================
-- 1. 删除旧函数（不同参数签名需要分别删除）
-- ============================================================================
DROP FUNCTION IF EXISTS search_similar_memories(UUID, VECTOR(1536), INTEGER, FLOAT);
DROP FUNCTION IF EXISTS search_similar_chunks(UUID, VECTOR(1536), INTEGER, FLOAT);

-- ============================================================================
-- 2. 创建修复后的 search_similar_memories 函数
-- ============================================================================
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
    -- 边界检查日志（通过 RAISE NOTICE 记录，生产环境可配置日志级别）
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
        AND (m.expires_at IS NULL OR m.expires_at > NOW())
        AND (1 - (m.embedding <=> p_query_embedding)) >= p_min_similarity
    ORDER BY m.embedding <=> p_query_embedding
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION search_similar_memories(UUID, UUID, VECTOR(1536), INTEGER, FLOAT)
    IS '搜索相似记忆的辅助函数（已修复多租户隔离）';

-- ============================================================================
-- 3. 创建修复后的 search_similar_chunks 函数
-- ============================================================================
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
    -- 边界检查日志
    IF p_limit > 100 THEN
        RAISE NOTICE '[search_similar_chunks] limit 超出建议值，已限制为 100 (请求: %)', p_limit;
        p_limit := 100;
    END IF;

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

COMMENT ON FUNCTION search_similar_chunks(UUID, UUID, VECTOR(1536), INTEGER, FLOAT)
    IS '搜索相似文档分块的辅助函数（已修复多租户隔离）';

-- ============================================================================
-- 4. 验证函数创建成功
-- ============================================================================
-- 可通过以下查询验证：
-- SELECT proname, pronargs FROM pg_proc WHERE proname IN ('search_similar_memories', 'search_similar_chunks');
