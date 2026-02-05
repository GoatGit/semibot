-- ============================================================================
-- 003_add_memory_tables.sql
-- 记忆系统表（包含 pgvector 向量存储）
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 启用 pgvector 扩展
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================================
-- 1. memories - 向量记忆表
-- ============================================================================
CREATE TABLE memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- 记忆唯一标识
    org_id UUID NOT NULL,                                           -- 所属组织（逻辑外键 -> organizations.id）
    agent_id UUID NOT NULL,                                         -- 关联Agent（逻辑外键 -> agents.id）
    session_id UUID,                                                -- 来源会话（逻辑外键 -> sessions.id，可选）
    user_id UUID,                                                   -- 关联用户（逻辑外键 -> users.id，可选）
    content TEXT NOT NULL,                                          -- 记忆内容
    embedding VECTOR(1536),                                         -- 向量表示（OpenAI text-embedding-ada-002）
    memory_type VARCHAR(50) DEFAULT 'episodic'                      -- 记忆类型
        CHECK (memory_type IN ('episodic', 'semantic', 'procedural')),
    importance FLOAT DEFAULT 0.5                                    -- 重要性评分（0-1）
        CHECK (importance >= 0 AND importance <= 1),
    access_count INTEGER DEFAULT 0,                                 -- 访问次数
    last_accessed_at TIMESTAMPTZ,                                   -- 最后访问时间
    metadata JSONB DEFAULT '{}',                                    -- 扩展元数据
    expires_at TIMESTAMPTZ,                                         -- 过期时间（可选）
    created_at TIMESTAMPTZ DEFAULT NOW()                            -- 创建时间
);

-- 普通索引
CREATE INDEX idx_memories_org ON memories(org_id);
CREATE INDEX idx_memories_agent ON memories(agent_id);
CREATE INDEX idx_memories_session ON memories(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_memories_user ON memories(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_memories_type ON memories(memory_type);
CREATE INDEX idx_memories_importance ON memories(importance DESC);
CREATE INDEX idx_memories_expires ON memories(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_memories_created ON memories(created_at DESC);

-- 向量索引（IVFFlat for faster search）
-- 注意：需要先插入一定数量数据后再创建此索引效果更好
CREATE INDEX idx_memories_embedding ON memories
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

COMMENT ON TABLE memories IS '向量记忆表，用于Agent长期记忆存储';
COMMENT ON COLUMN memories.id IS '记忆唯一标识';
COMMENT ON COLUMN memories.org_id IS '逻辑外键，关联 organizations.id';
COMMENT ON COLUMN memories.agent_id IS '逻辑外键，关联 agents.id';
COMMENT ON COLUMN memories.session_id IS '逻辑外键，关联 sessions.id，记忆来源会话';
COMMENT ON COLUMN memories.user_id IS '逻辑外键，关联 users.id，用户相关记忆';
COMMENT ON COLUMN memories.content IS '记忆内容文本';
COMMENT ON COLUMN memories.embedding IS '向量表示（1536维，OpenAI text-embedding-ada-002）';
COMMENT ON COLUMN memories.memory_type IS '记忆类型：episodic(情节)/semantic(语义)/procedural(程序)';
COMMENT ON COLUMN memories.importance IS '重要性评分（0-1），用于记忆检索排序';
COMMENT ON COLUMN memories.access_count IS '访问次数，用于记忆强化';
COMMENT ON COLUMN memories.last_accessed_at IS '最后访问时间';
COMMENT ON COLUMN memories.metadata IS '扩展元数据 JSON';
COMMENT ON COLUMN memories.expires_at IS '过期时间，NULL表示永不过期';

-- ============================================================================
-- 2. memory_collections - 记忆集合表（用于组织记忆）
-- ============================================================================
CREATE TABLE memory_collections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- 集合唯一标识
    org_id UUID NOT NULL,                                           -- 所属组织（逻辑外键 -> organizations.id）
    agent_id UUID,                                                  -- 关联Agent（逻辑外键 -> agents.id，可选）
    name VARCHAR(100) NOT NULL,                                     -- 集合名称
    description TEXT,                                               -- 集合描述
    embedding_model VARCHAR(100) DEFAULT 'text-embedding-ada-002',  -- 使用的嵌入模型
    embedding_dimension INTEGER DEFAULT 1536,                       -- 向量维度
    metadata JSONB DEFAULT '{}',                                    -- 扩展元数据
    is_active BOOLEAN DEFAULT true,                                 -- 是否启用
    created_at TIMESTAMPTZ DEFAULT NOW(),                           -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW()                            -- 更新时间
);

-- 索引
CREATE INDEX idx_memory_collections_org ON memory_collections(org_id);
CREATE INDEX idx_memory_collections_agent ON memory_collections(agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX idx_memory_collections_name ON memory_collections(org_id, name);
CREATE INDEX idx_memory_collections_active ON memory_collections(is_active) WHERE is_active = true;

-- 更新触发器
CREATE TRIGGER memory_collections_updated_at
    BEFORE UPDATE ON memory_collections
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE memory_collections IS '记忆集合表，用于组织和管理记忆';
COMMENT ON COLUMN memory_collections.id IS '集合唯一标识';
COMMENT ON COLUMN memory_collections.org_id IS '逻辑外键，关联 organizations.id';
COMMENT ON COLUMN memory_collections.agent_id IS '逻辑外键，关联 agents.id，可选';
COMMENT ON COLUMN memory_collections.name IS '集合名称';
COMMENT ON COLUMN memory_collections.description IS '集合描述';
COMMENT ON COLUMN memory_collections.embedding_model IS '使用的嵌入模型名称';
COMMENT ON COLUMN memory_collections.embedding_dimension IS '向量维度';
COMMENT ON COLUMN memory_collections.metadata IS '扩展元数据 JSON';
COMMENT ON COLUMN memory_collections.is_active IS '是否启用';

-- ============================================================================
-- 3. memory_documents - 文档记忆表（用于RAG）
-- ============================================================================
CREATE TABLE memory_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- 文档唯一标识
    org_id UUID NOT NULL,                                           -- 所属组织（逻辑外键 -> organizations.id）
    collection_id UUID NOT NULL,                                    -- 所属集合（逻辑外键 -> memory_collections.id）
    title VARCHAR(500),                                             -- 文档标题
    content TEXT NOT NULL,                                          -- 文档内容
    content_hash VARCHAR(64),                                       -- 内容哈希（用于去重）
    source_type VARCHAR(50),                                        -- 来源类型：file/url/api/manual
    source_url TEXT,                                                -- 来源URL（如有）
    file_path TEXT,                                                 -- 文件路径（如有）
    file_type VARCHAR(50),                                          -- 文件类型：pdf/docx/txt/md等
    file_size INTEGER,                                              -- 文件大小（字节）
    chunk_count INTEGER DEFAULT 0,                                  -- 分块数量
    metadata JSONB DEFAULT '{}',                                    -- 扩展元数据
    is_processed BOOLEAN DEFAULT false,                             -- 是否已处理（分块+向量化）
    processed_at TIMESTAMPTZ,                                       -- 处理完成时间
    created_at TIMESTAMPTZ DEFAULT NOW(),                           -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW()                            -- 更新时间
);

-- 索引
CREATE INDEX idx_memory_documents_org ON memory_documents(org_id);
CREATE INDEX idx_memory_documents_collection ON memory_documents(collection_id);
CREATE INDEX idx_memory_documents_hash ON memory_documents(content_hash);
CREATE INDEX idx_memory_documents_source ON memory_documents(source_type);
CREATE INDEX idx_memory_documents_processed ON memory_documents(is_processed);
CREATE INDEX idx_memory_documents_created ON memory_documents(created_at DESC);

-- 更新触发器
CREATE TRIGGER memory_documents_updated_at
    BEFORE UPDATE ON memory_documents
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE memory_documents IS '文档记忆表，用于RAG知识库';
COMMENT ON COLUMN memory_documents.id IS '文档唯一标识';
COMMENT ON COLUMN memory_documents.org_id IS '逻辑外键，关联 organizations.id';
COMMENT ON COLUMN memory_documents.collection_id IS '逻辑外键，关联 memory_collections.id';
COMMENT ON COLUMN memory_documents.title IS '文档标题';
COMMENT ON COLUMN memory_documents.content IS '文档原始内容';
COMMENT ON COLUMN memory_documents.content_hash IS '内容SHA256哈希，用于去重';
COMMENT ON COLUMN memory_documents.source_type IS '来源类型：file/url/api/manual';
COMMENT ON COLUMN memory_documents.source_url IS '来源URL';
COMMENT ON COLUMN memory_documents.file_path IS '文件存储路径';
COMMENT ON COLUMN memory_documents.file_type IS '文件类型：pdf/docx/txt/md等';
COMMENT ON COLUMN memory_documents.file_size IS '文件大小（字节）';
COMMENT ON COLUMN memory_documents.chunk_count IS '分块数量';
COMMENT ON COLUMN memory_documents.metadata IS '扩展元数据 JSON';
COMMENT ON COLUMN memory_documents.is_processed IS '是否已完成分块和向量化';
COMMENT ON COLUMN memory_documents.processed_at IS '处理完成时间';

-- ============================================================================
-- 4. memory_chunks - 文档分块表（向量检索单元）
-- ============================================================================
CREATE TABLE memory_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- 分块唯一标识
    org_id UUID NOT NULL,                                           -- 所属组织（逻辑外键 -> organizations.id）
    document_id UUID NOT NULL,                                      -- 所属文档（逻辑外键 -> memory_documents.id）
    collection_id UUID NOT NULL,                                    -- 所属集合（逻辑外键 -> memory_collections.id）
    chunk_index INTEGER NOT NULL,                                   -- 分块索引（在文档中的顺序）
    content TEXT NOT NULL,                                          -- 分块内容
    embedding VECTOR(1536),                                         -- 向量表示
    token_count INTEGER,                                            -- token数量
    metadata JSONB DEFAULT '{}',                                    -- 扩展元数据（如页码、章节等）
    created_at TIMESTAMPTZ DEFAULT NOW()                            -- 创建时间
);

-- 普通索引
CREATE INDEX idx_memory_chunks_org ON memory_chunks(org_id);
CREATE INDEX idx_memory_chunks_document ON memory_chunks(document_id);
CREATE INDEX idx_memory_chunks_collection ON memory_chunks(collection_id);
CREATE INDEX idx_memory_chunks_index ON memory_chunks(document_id, chunk_index);

-- 向量索引
CREATE INDEX idx_memory_chunks_embedding ON memory_chunks
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

COMMENT ON TABLE memory_chunks IS '文档分块表，向量检索的基本单元';
COMMENT ON COLUMN memory_chunks.id IS '分块唯一标识';
COMMENT ON COLUMN memory_chunks.org_id IS '逻辑外键，关联 organizations.id';
COMMENT ON COLUMN memory_chunks.document_id IS '逻辑外键，关联 memory_documents.id';
COMMENT ON COLUMN memory_chunks.collection_id IS '逻辑外键，关联 memory_collections.id';
COMMENT ON COLUMN memory_chunks.chunk_index IS '分块在文档中的顺序索引';
COMMENT ON COLUMN memory_chunks.content IS '分块文本内容';
COMMENT ON COLUMN memory_chunks.embedding IS '向量表示（1536维）';
COMMENT ON COLUMN memory_chunks.token_count IS 'token数量';
COMMENT ON COLUMN memory_chunks.metadata IS '扩展元数据 JSON（如页码、章节等）';

-- ============================================================================
-- 5. 辅助函数：相似记忆检索
-- ============================================================================
CREATE OR REPLACE FUNCTION search_similar_memories(
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
    WHERE m.agent_id = p_agent_id
        AND (m.expires_at IS NULL OR m.expires_at > NOW())
        AND (1 - (m.embedding <=> p_query_embedding)) >= p_min_similarity
    ORDER BY m.embedding <=> p_query_embedding
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION search_similar_memories IS '搜索相似记忆的辅助函数';

-- ============================================================================
-- 6. 辅助函数：相似文档分块检索
-- ============================================================================
CREATE OR REPLACE FUNCTION search_similar_chunks(
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
    WHERE c.collection_id = p_collection_id
        AND (1 - (c.embedding <=> p_query_embedding)) >= p_min_similarity
    ORDER BY c.embedding <=> p_query_embedding
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION search_similar_chunks IS '搜索相似文档分块的辅助函数';
