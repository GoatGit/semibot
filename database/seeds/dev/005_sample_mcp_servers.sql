-- ============================================================================
-- 005_sample_mcp_servers.sql
-- 开发环境 MCP Servers 种子数据
-- ============================================================================

-- 注意：此脚本仅用于开发环境，切勿在生产环境执行

-- ============================================================================
-- 1. 开发环境 MCP Servers
-- ============================================================================
INSERT INTO mcp_servers (id, org_id, name, description, endpoint, transport, auth_type, tools, resources, status, created_by) VALUES
(
    'mcp-1111-1111-1111-111111111111',
    '11111111-1111-1111-1111-111111111111',
    'Filesystem MCP',
    '本地文件系统访问',
    'npx -y @modelcontextprotocol/server-filesystem /tmp/workspace',
    'stdio',
    'none',
    '[
        {"name": "read_file", "description": "读取文件内容"},
        {"name": "write_file", "description": "写入文件内容"},
        {"name": "list_directory", "description": "列出目录内容"}
    ]',
    '[
        {"uri": "file:///tmp/workspace", "name": "Workspace", "description": "工作目录"}
    ]',
    'disconnected',
    '22222222-2222-2222-2222-222222222222'
),
(
    'mcp-1111-1111-1111-222222222222',
    '11111111-1111-1111-1111-111111111111',
    'GitHub MCP',
    'GitHub 仓库访问',
    'npx -y @modelcontextprotocol/server-github',
    'stdio',
    'api_key',
    '[
        {"name": "search_repositories", "description": "搜索仓库"},
        {"name": "get_file_contents", "description": "获取文件内容"},
        {"name": "create_issue", "description": "创建 Issue"},
        {"name": "create_pull_request", "description": "创建 PR"}
    ]',
    '[]',
    'disconnected',
    '22222222-2222-2222-2222-222222222222'
),
(
    'mcp-1111-1111-1111-333333333333',
    '11111111-1111-1111-1111-111111111111',
    'Postgres MCP',
    'PostgreSQL 数据库访问',
    'npx -y @modelcontextprotocol/server-postgres postgresql://localhost/semibot',
    'stdio',
    'none',
    '[
        {"name": "query", "description": "执行 SQL 查询"},
        {"name": "list_tables", "description": "列出所有表"},
        {"name": "describe_table", "description": "描述表结构"}
    ]',
    '[
        {"uri": "postgres://localhost/semibot", "name": "Semibot DB", "description": "本地开发数据库"}
    ]',
    'disconnected',
    '22222222-2222-2222-2222-222222222222'
),
(
    'mcp-1111-1111-1111-444444444444',
    '11111111-1111-1111-1111-111111111111',
    'Brave Search MCP',
    'Brave 搜索引擎',
    'npx -y @modelcontextprotocol/server-brave-search',
    'stdio',
    'api_key',
    '[
        {"name": "brave_web_search", "description": "网页搜索"},
        {"name": "brave_local_search", "description": "本地搜索"}
    ]',
    '[]',
    'disconnected',
    '22222222-2222-2222-2222-222222222222'
),
(
    'mcp-1111-1111-1111-555555555555',
    '11111111-1111-1111-1111-111111111111',
    'Memory MCP',
    '知识图谱记忆',
    'npx -y @modelcontextprotocol/server-memory',
    'stdio',
    'none',
    '[
        {"name": "create_entities", "description": "创建实体"},
        {"name": "create_relations", "description": "创建关系"},
        {"name": "search_nodes", "description": "搜索节点"}
    ]',
    '[]',
    'disconnected',
    '22222222-2222-2222-2222-222222222222'
)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 2. Agent-MCP 关联
-- ============================================================================
INSERT INTO agent_mcp_servers (id, agent_id, mcp_server_id, enabled_tools, is_active) VALUES
(
    'agent-mcp-1111-1111-111111111111',
    'agent-1111-1111-1111-111111111111',  -- General Assistant
    'mcp-1111-1111-1111-111111111111',    -- Filesystem MCP
    ARRAY['read_file', 'list_directory'],
    true
),
(
    'agent-mcp-1111-1111-222222222222',
    'agent-1111-1111-1111-222222222222',  -- Code Assistant
    'mcp-1111-1111-1111-111111111111',    -- Filesystem MCP
    ARRAY[]::TEXT[],  -- 全部启用
    true
),
(
    'agent-mcp-1111-1111-333333333333',
    'agent-1111-1111-1111-222222222222',  -- Code Assistant
    'mcp-1111-1111-1111-222222222222',    -- GitHub MCP
    ARRAY[]::TEXT[],
    true
),
(
    'agent-mcp-1111-1111-444444444444',
    'agent-1111-1111-1111-444444444444',  -- Research Assistant
    'mcp-1111-1111-1111-444444444444',    -- Brave Search MCP
    ARRAY[]::TEXT[],
    true
)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 3. 验证数据
-- ============================================================================
-- SELECT * FROM mcp_servers;
-- SELECT * FROM agent_mcp_servers;
