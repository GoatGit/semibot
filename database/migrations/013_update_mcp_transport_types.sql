-- 013_update_mcp_transport_types.sql
-- 将 MCP 传输类型对齐 MCP SDK 规范：http -> sse, websocket -> streamable_http

-- 1. 先删除旧的 CHECK 约束（否则 UPDATE 会违反约束）
ALTER TABLE mcp_servers DROP CONSTRAINT IF EXISTS mcp_servers_transport_check;

-- 2. 迁移现有数据
UPDATE mcp_servers SET transport = 'sse' WHERE transport = 'http';
UPDATE mcp_servers SET transport = 'streamable_http' WHERE transport = 'websocket';

-- 3. 添加新的 CHECK 约束
ALTER TABLE mcp_servers ADD CONSTRAINT mcp_servers_transport_check
    CHECK (transport IN ('stdio', 'sse', 'streamable_http'));

-- 4. 更新列注释
COMMENT ON COLUMN mcp_servers.transport IS '传输类型：stdio/sse/streamable_http';
