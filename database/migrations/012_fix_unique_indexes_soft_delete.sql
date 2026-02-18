-- 012_fix_unique_indexes_soft_delete.sql
-- 修复唯一索引与软删除的冲突：已删除的记录不应阻止创建同名新记录

-- mcp_servers: 允许已删除的 MCP 服务器名称被重新使用
DROP INDEX IF EXISTS idx_mcp_servers_unique_name;
CREATE UNIQUE INDEX idx_mcp_servers_unique_name ON mcp_servers(org_id, name) WHERE deleted_at IS NULL;

-- tools: 允许已删除的工具名称被重新使用
DROP INDEX IF EXISTS idx_tools_unique_name;
CREATE UNIQUE INDEX idx_tools_unique_name ON tools(COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), name) WHERE deleted_at IS NULL;

-- skills: 允许已删除的技能名称被重新使用
DROP INDEX IF EXISTS idx_skills_unique_name;
CREATE UNIQUE INDEX idx_skills_unique_name ON skills(COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), name) WHERE deleted_at IS NULL;
