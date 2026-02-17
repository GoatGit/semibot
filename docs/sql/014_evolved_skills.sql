-- 014_evolved_skills.sql
-- 进化技能表 — 存储 Agent 自学习产生的可复用技能

CREATE TABLE IF NOT EXISTS evolved_skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,                    -- 所属组织
    agent_id UUID NOT NULL,                  -- 产生此技能的 Agent
    session_id UUID NOT NULL,                -- 产生此技能的会话

    -- 技能定义
    name VARCHAR(200) NOT NULL,              -- 技能名称
    description TEXT NOT NULL,               -- 技能描述
    trigger_keywords TEXT[] DEFAULT '{}',    -- 触发关键词
    steps JSONB NOT NULL,                    -- 执行步骤序列
    tools_used TEXT[] DEFAULT '{}',          -- 使用的工具列表
    parameters JSONB DEFAULT '{}',           -- 可参数化的变量
    preconditions JSONB DEFAULT '{}',        -- 前置条件
    expected_outcome TEXT,                   -- 预期结果

    -- 向量索引
    embedding VECTOR(1536),                  -- 技能描述的向量表示

    -- 质量与状态
    quality_score FLOAT DEFAULT 0,           -- 质量评分 (0-1)
    reusability_score FLOAT DEFAULT 0,       -- 复用价值评分 (0-1)
    status VARCHAR(20) DEFAULT 'pending_review'
        CHECK (status IN ('pending_review', 'approved', 'rejected', 'auto_approved', 'deprecated')),

    -- 使用统计
    use_count INTEGER DEFAULT 0,             -- 被复用次数
    success_count INTEGER DEFAULT 0,         -- 复用成功次数
    last_used_at TIMESTAMPTZ,                -- 最后使用时间

    -- 审核
    reviewed_by UUID,                        -- 审核人
    reviewed_at TIMESTAMPTZ,                 -- 审核时间
    review_comment TEXT,                     -- 审核意见

    -- 审计字段
    version INTEGER NOT NULL DEFAULT 1,      -- 版本号（乐观锁）
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,                  -- 软删除
    deleted_by UUID                          -- 删除人
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_evolved_skills_org ON evolved_skills(org_id);
CREATE INDEX IF NOT EXISTS idx_evolved_skills_agent ON evolved_skills(agent_id);
CREATE INDEX IF NOT EXISTS idx_evolved_skills_status ON evolved_skills(status);
CREATE INDEX IF NOT EXISTS idx_evolved_skills_quality ON evolved_skills(quality_score DESC);
CREATE INDEX IF NOT EXISTS idx_evolved_skills_use_count ON evolved_skills(use_count DESC);
CREATE INDEX IF NOT EXISTS idx_evolved_skills_org_status ON evolved_skills(org_id, status, created_at DESC);

-- 向量索引（需要 pgvector 扩展）
-- CREATE INDEX IF NOT EXISTS idx_evolved_skills_embedding ON evolved_skills
--     USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

COMMENT ON TABLE evolved_skills IS '进化技能 — Agent 自学习产生的可复用技能定义';
