-- ============================================================================
-- 008_add_soft_delete_and_audit.sql
-- 添加软删除机制和审计字段
-- ============================================================================

-- ============================================================================
-- 1. 添加软删除字段
-- ============================================================================

-- organizations 表
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deleted_by UUID;

-- users 表
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_by UUID;

-- agents 表
ALTER TABLE agents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS deleted_by UUID;

-- skills 表
ALTER TABLE skills ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS deleted_by UUID;

-- tools 表
ALTER TABLE tools ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE tools ADD COLUMN IF NOT EXISTS deleted_by UUID;

-- mcp_servers 表
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS deleted_by UUID;

-- memory_collections 表
ALTER TABLE memory_collections ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE memory_collections ADD COLUMN IF NOT EXISTS deleted_by UUID;

-- memory_documents 表
ALTER TABLE memory_documents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE memory_documents ADD COLUMN IF NOT EXISTS deleted_by UUID;

-- api_keys 表
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS deleted_by UUID;

-- ============================================================================
-- 2. 添加软删除索引（用于快速过滤已删除数据）
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_organizations_deleted ON organizations(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_deleted ON users(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agents_deleted ON agents(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_skills_deleted ON skills(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tools_deleted ON tools(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mcp_servers_deleted ON mcp_servers(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_collections_deleted ON memory_collections(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_documents_deleted ON memory_documents(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_deleted ON api_keys(deleted_at) WHERE deleted_at IS NOT NULL;

-- ============================================================================
-- 3. 添加审计字段（部分表缺失）
-- ============================================================================

-- organizations 表
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS created_by UUID;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS updated_by UUID;

-- users 表
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_by UUID;

-- agents 表
ALTER TABLE agents ADD COLUMN IF NOT EXISTS created_by UUID;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS updated_by UUID;

-- sessions 表
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- ============================================================================
-- 4. 添加乐观锁版本字段
-- ============================================================================

-- skills 表（agents 已有 version）
ALTER TABLE skills ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;

-- tools 表
ALTER TABLE tools ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;

-- mcp_servers 表
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;

-- ============================================================================
-- 5. 添加注释
-- ============================================================================
COMMENT ON COLUMN organizations.deleted_at IS '软删除时间，NULL表示未删除';
COMMENT ON COLUMN organizations.deleted_by IS '执行删除操作的用户ID';
COMMENT ON COLUMN organizations.created_by IS '创建者用户ID';
COMMENT ON COLUMN organizations.updated_by IS '最后更新者用户ID';

COMMENT ON COLUMN users.deleted_at IS '软删除时间，NULL表示未删除';
COMMENT ON COLUMN users.deleted_by IS '执行删除操作的用户ID';
COMMENT ON COLUMN users.updated_by IS '最后更新者用户ID';

COMMENT ON COLUMN agents.deleted_at IS '软删除时间，NULL表示未删除';
COMMENT ON COLUMN agents.deleted_by IS '执行删除操作的用户ID';
COMMENT ON COLUMN agents.created_by IS '创建者用户ID';
COMMENT ON COLUMN agents.updated_by IS '最后更新者用户ID';

COMMENT ON COLUMN skills.deleted_at IS '软删除时间，NULL表示未删除';
COMMENT ON COLUMN skills.deleted_by IS '执行删除操作的用户ID';
COMMENT ON COLUMN skills.version IS '乐观锁版本号';

COMMENT ON COLUMN tools.deleted_at IS '软删除时间，NULL表示未删除';
COMMENT ON COLUMN tools.deleted_by IS '执行删除操作的用户ID';
COMMENT ON COLUMN tools.version IS '乐观锁版本号';

COMMENT ON COLUMN mcp_servers.deleted_at IS '软删除时间，NULL表示未删除';
COMMENT ON COLUMN mcp_servers.deleted_by IS '执行删除操作的用户ID';
COMMENT ON COLUMN mcp_servers.version IS '乐观锁版本号';

COMMENT ON COLUMN memory_collections.deleted_at IS '软删除时间，NULL表示未删除';
COMMENT ON COLUMN memory_collections.deleted_by IS '执行删除操作的用户ID';

COMMENT ON COLUMN memory_documents.deleted_at IS '软删除时间，NULL表示未删除';
COMMENT ON COLUMN memory_documents.deleted_by IS '执行删除操作的用户ID';

COMMENT ON COLUMN api_keys.deleted_at IS '软删除时间，NULL表示未删除';
COMMENT ON COLUMN api_keys.deleted_by IS '执行删除操作的用户ID';

-- ============================================================================
-- 6. 验证字段添加成功
-- ============================================================================
-- 可通过以下查询验证：
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'agents' AND column_name IN ('deleted_at', 'deleted_by', 'version');
