-- ============================================================================
-- 004_sample_tools.sql
-- 开发环境 Tools 工具种子数据
-- ============================================================================

-- 注意：此脚本仅用于开发环境，切勿在生产环境执行

-- ============================================================================
-- 1. 系统内置工具（org_id 为 NULL）
-- ============================================================================
INSERT INTO tools (id, org_id, name, description, type, schema, config, is_builtin) VALUES
(
    'tool-0001-0001-0001-000000000001',
    NULL,
    'web_search',
    '搜索互联网获取最新信息',
    'http',
    '{
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "搜索关键词"},
            "limit": {"type": "integer", "default": 10, "minimum": 1, "maximum": 50}
        },
        "required": ["query"]
    }',
    '{"endpoint": "https://api.search.example.com/v1/search", "timeout_ms": 10000}',
    true
),
(
    'tool-0001-0001-0001-000000000002',
    NULL,
    'code_interpreter',
    '执行 Python 代码进行计算和数据处理',
    'function',
    '{
        "type": "object",
        "properties": {
            "code": {"type": "string", "description": "Python 代码"},
            "timeout": {"type": "integer", "default": 30, "maximum": 300}
        },
        "required": ["code"]
    }',
    '{"sandbox": true, "max_memory_mb": 512}',
    true
),
(
    'tool-0001-0001-0001-000000000003',
    NULL,
    'file_reader',
    '读取文件内容',
    'function',
    '{
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "文件路径"},
            "encoding": {"type": "string", "default": "utf-8"}
        },
        "required": ["path"]
    }',
    '{"allowed_extensions": ["txt", "json", "csv", "md", "yaml"], "max_size_mb": 10}',
    true
),
(
    'tool-0001-0001-0001-000000000004',
    NULL,
    'http_request',
    '发送 HTTP 请求',
    'http',
    '{
        "type": "object",
        "properties": {
            "url": {"type": "string", "format": "uri"},
            "method": {"type": "string", "enum": ["GET", "POST", "PUT", "DELETE"], "default": "GET"},
            "headers": {"type": "object"},
            "body": {"type": "object"}
        },
        "required": ["url"]
    }',
    '{"timeout_ms": 30000, "max_redirects": 5}',
    true
),
(
    'tool-0001-0001-0001-000000000005',
    NULL,
    'database_query',
    '执行数据库查询（只读）',
    'function',
    '{
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "SQL 查询语句"},
            "params": {"type": "array", "description": "查询参数"}
        },
        "required": ["query"]
    }',
    '{"read_only": true, "timeout_ms": 30000, "max_rows": 1000}',
    true
),
(
    'tool-0001-0001-0001-000000000006',
    NULL,
    'image_analysis',
    '分析图片内容',
    'function',
    '{
        "type": "object",
        "properties": {
            "image_url": {"type": "string", "format": "uri"},
            "prompt": {"type": "string", "description": "分析提示"}
        },
        "required": ["image_url"]
    }',
    '{"max_image_size_mb": 20}',
    true
)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 2. 组织自定义工具
-- ============================================================================
INSERT INTO tools (id, org_id, name, description, type, schema, config, is_builtin, created_by) VALUES
(
    'tool-1111-1111-1111-111111111111',
    '11111111-1111-1111-1111-111111111111',
    'internal_api',
    '内部 API 调用工具',
    'http',
    '{
        "type": "object",
        "properties": {
            "endpoint": {"type": "string"},
            "method": {"type": "string", "default": "GET"},
            "data": {"type": "object"}
        },
        "required": ["endpoint"]
    }',
    '{"base_url": "https://api.internal.example.com"}',
    false,
    '22222222-2222-2222-2222-222222222222'
)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 3. 验证数据
-- ============================================================================
-- SELECT * FROM tools WHERE is_builtin = true;
-- SELECT * FROM tools WHERE org_id IS NOT NULL;
