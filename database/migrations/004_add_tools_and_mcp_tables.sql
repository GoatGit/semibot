-- ============================================================================
-- 004_add_tools_and_mcp_tables.sql
-- 添加 Tools 和 MCP Servers 表
-- ============================================================================

-- ============================================================================
-- 1. tools - 工具定义表
-- ============================================================================
CREATE TABLE IF NOT EXISTS tools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- 工具唯一标识
    org_id UUID,                                                    -- 所属组织（逻辑外键 -> organizations.id，NULL表示系统内置）
    name VARCHAR(100) NOT NULL,                                     -- 工具名称
    description TEXT,                                               -- 工具描述
    type VARCHAR(50) NOT NULL,                                      -- 工具类型（function/http/mcp/browser等）
    schema JSONB DEFAULT '{}',                                      -- 工具参数Schema（JSON Schema格式）
    config JSONB DEFAULT '{}',                                      -- 工具配置
    is_builtin BOOLEAN DEFAULT false,                               -- 是否内置工具
    is_active BOOLEAN DEFAULT true,                                 -- 是否启用
    created_by UUID,                                                -- 创建者（逻辑外键 -> users.id）
    created_at TIMESTAMPTZ DEFAULT NOW(),                           -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW()                            -- 更新时间
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_tools_org ON tools(org_id);
CREATE INDEX IF NOT EXISTS idx_tools_name ON tools(org_id, name);
CREATE INDEX IF NOT EXISTS idx_tools_type ON tools(type);
CREATE INDEX IF NOT EXISTS idx_tools_builtin ON tools(is_builtin) WHERE is_builtin = true;
CREATE INDEX IF NOT EXISTS idx_tools_active ON tools(is_active) WHERE is_active = true;

-- 唯一约束：同一组织内工具名称唯一（内置工具 org_id 为 NULL 时全局唯一）
CREATE UNIQUE INDEX IF NOT EXISTS idx_tools_unique_name ON tools(COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), name);

-- 更新触发器
DROP TRIGGER IF EXISTS tools_updated_at ON tools;
CREATE TRIGGER tools_updated_at
    BEFORE UPDATE ON tools
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE tools IS '工具定义表，支持多租户隔离';
COMMENT ON COLUMN tools.id IS '工具唯一标识';
COMMENT ON COLUMN tools.org_id IS '逻辑外键，关联 organizations.id，NULL表示系统内置工具';
COMMENT ON COLUMN tools.name IS '工具名称';
COMMENT ON COLUMN tools.description IS '工具描述';
COMMENT ON COLUMN tools.type IS '工具类型：function/http/mcp/browser等';
COMMENT ON COLUMN tools.schema IS '工具参数Schema（JSON Schema格式）';
COMMENT ON COLUMN tools.config IS '工具配置 JSON';
COMMENT ON COLUMN tools.is_builtin IS '是否内置工具';
COMMENT ON COLUMN tools.is_active IS '是否启用';
COMMENT ON COLUMN tools.created_by IS '逻辑外键，关联 users.id';

-- ============================================================================
-- 2. mcp_servers - MCP Server 配置表
-- ============================================================================
CREATE TABLE IF NOT EXISTS mcp_servers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- MCP Server唯一标识
    org_id UUID NOT NULL,                                           -- 所属组织（逻辑外键 -> organizations.id）
    name VARCHAR(100) NOT NULL,                                     -- Server名称
    description TEXT,                                               -- Server描述
    endpoint VARCHAR(500) NOT NULL,                                 -- Server端点（URL或命令）
    transport VARCHAR(20) NOT NULL                                  -- 传输类型
        CHECK (transport IN ('stdio', 'http', 'websocket')),
    auth_type VARCHAR(20)                                           -- 认证类型
        CHECK (auth_type IN ('none', 'api_key', 'oauth')),
    auth_config JSONB,                                              -- 认证配置（加密存储敏感信息）
    tools JSONB DEFAULT '[]',                                       -- 可用工具列表
    resources JSONB DEFAULT '[]',                                   -- 可用资源列表
    status VARCHAR(20) DEFAULT 'disconnected'                       -- 连接状态
        CHECK (status IN ('disconnected', 'connecting', 'connected', 'error')),
    last_connected_at TIMESTAMPTZ,                                  -- 最后连接时间
    is_active BOOLEAN DEFAULT true,                                 -- 是否启用
    created_by UUID,                                                -- 创建者（逻辑外键 -> users.id）
    created_at TIMESTAMPTZ DEFAULT NOW(),                           -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW()                            -- 更新时间
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_mcp_servers_org ON mcp_servers(org_id);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_name ON mcp_servers(org_id, name);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_status ON mcp_servers(status);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_active ON mcp_servers(is_active) WHERE is_active = true;

-- 唯一约束：同一组织内 Server 名称唯一
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_unique_name ON mcp_servers(org_id, name);

-- 更新触发器
DROP TRIGGER IF EXISTS mcp_servers_updated_at ON mcp_servers;
CREATE TRIGGER mcp_servers_updated_at
    BEFORE UPDATE ON mcp_servers
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE mcp_servers IS 'MCP Server配置表';
COMMENT ON COLUMN mcp_servers.id IS 'MCP Server唯一标识';
COMMENT ON COLUMN mcp_servers.org_id IS '逻辑外键，关联 organizations.id';
COMMENT ON COLUMN mcp_servers.name IS 'Server名称';
COMMENT ON COLUMN mcp_servers.description IS 'Server描述';
COMMENT ON COLUMN mcp_servers.endpoint IS 'Server端点（URL或命令）';
COMMENT ON COLUMN mcp_servers.transport IS '传输类型：stdio/http/websocket';
COMMENT ON COLUMN mcp_servers.auth_type IS '认证类型：none/api_key/oauth';
COMMENT ON COLUMN mcp_servers.auth_config IS '认证配置 JSON（敏感信息应加密）';
COMMENT ON COLUMN mcp_servers.tools IS '可用工具列表 JSON';
COMMENT ON COLUMN mcp_servers.resources IS '可用资源列表 JSON';
COMMENT ON COLUMN mcp_servers.status IS '连接状态：disconnected/connecting/connected/error';
COMMENT ON COLUMN mcp_servers.last_connected_at IS '最后连接时间';
COMMENT ON COLUMN mcp_servers.is_active IS '是否启用';
COMMENT ON COLUMN mcp_servers.created_by IS '逻辑外键，关联 users.id';

-- ============================================================================
-- 3. agent_tools - Agent与Tool关联表
-- ============================================================================
CREATE TABLE IF NOT EXISTS agent_tools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- 关联记录唯一标识
    agent_id UUID NOT NULL,                                         -- Agent ID（逻辑外键 -> agents.id）
    tool_id UUID NOT NULL,                                          -- Tool ID（逻辑外键 -> tools.id）
    priority INTEGER DEFAULT 0,                                     -- 优先级（数值越大优先级越高）
    config_override JSONB DEFAULT '{}',                             -- 配置覆盖
    is_active BOOLEAN DEFAULT true,                                 -- 是否启用
    created_at TIMESTAMPTZ DEFAULT NOW(),                           -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW()                            -- 更新时间
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_agent_tools_agent ON agent_tools(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_tools_tool ON agent_tools(tool_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tools_unique ON agent_tools(agent_id, tool_id);

-- 更新触发器
DROP TRIGGER IF EXISTS agent_tools_updated_at ON agent_tools;
CREATE TRIGGER agent_tools_updated_at
    BEFORE UPDATE ON agent_tools
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE agent_tools IS 'Agent与Tool关联表';
COMMENT ON COLUMN agent_tools.id IS '关联记录唯一标识';
COMMENT ON COLUMN agent_tools.agent_id IS '逻辑外键，关联 agents.id';
COMMENT ON COLUMN agent_tools.tool_id IS '逻辑外键，关联 tools.id';
COMMENT ON COLUMN agent_tools.priority IS '优先级，数值越大优先级越高';
COMMENT ON COLUMN agent_tools.config_override IS '配置覆盖 JSON';
COMMENT ON COLUMN agent_tools.is_active IS '是否启用';

-- ============================================================================
-- 4. agent_mcp_servers - Agent与MCP Server关联表
-- ============================================================================
CREATE TABLE IF NOT EXISTS agent_mcp_servers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- 关联记录唯一标识
    agent_id UUID NOT NULL,                                         -- Agent ID（逻辑外键 -> agents.id）
    mcp_server_id UUID NOT NULL,                                    -- MCP Server ID（逻辑外键 -> mcp_servers.id）
    enabled_tools TEXT[] DEFAULT '{}',                              -- 启用的工具名称列表（空表示全部启用）
    enabled_resources TEXT[] DEFAULT '{}',                          -- 启用的资源URI列表（空表示全部启用）
    is_active BOOLEAN DEFAULT true,                                 -- 是否启用
    created_at TIMESTAMPTZ DEFAULT NOW(),                           -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW()                            -- 更新时间
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_agent_mcp_servers_agent ON agent_mcp_servers(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_mcp_servers_mcp ON agent_mcp_servers(mcp_server_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_mcp_servers_unique ON agent_mcp_servers(agent_id, mcp_server_id);

-- 更新触发器
DROP TRIGGER IF EXISTS agent_mcp_servers_updated_at ON agent_mcp_servers;
CREATE TRIGGER agent_mcp_servers_updated_at
    BEFORE UPDATE ON agent_mcp_servers
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE agent_mcp_servers IS 'Agent与MCP Server关联表';
COMMENT ON COLUMN agent_mcp_servers.id IS '关联记录唯一标识';
COMMENT ON COLUMN agent_mcp_servers.agent_id IS '逻辑外键，关联 agents.id';
COMMENT ON COLUMN agent_mcp_servers.mcp_server_id IS '逻辑外键，关联 mcp_servers.id';
COMMENT ON COLUMN agent_mcp_servers.enabled_tools IS '启用的工具名称列表';
COMMENT ON COLUMN agent_mcp_servers.enabled_resources IS '启用的资源URI列表';
COMMENT ON COLUMN agent_mcp_servers.is_active IS '是否启用';
