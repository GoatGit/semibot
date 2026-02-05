# Semibot: Database Seed Data Completion

**Priority:** Medium
**Status:** Not Started
**Type:** Enhancement
**Created:** 2026-02-06
**Last Updated:** 2026-02-06

## Overview

补充数据库种子数据，覆盖所有表和边界场景，支持开发和测试。

## Description

当前种子数据缺失以下内容：

### 缺失表数据
- tools（工具定义）
- mcp_servers（MCP 服务器）
- usage_records（使用量记录）
- execution_logs（执行日志）
- memories/memory_chunks（向量数据）

### 缺失测试场景
- 边界值测试数据（超长字段、特殊字符）
- 异常状态数据（expired、failed、error）
- 大数据量性能测试数据

## Features / Requirements

### 1. 003_sample_tools.sql

```sql
-- 系统内置工具
INSERT INTO tools (id, org_id, name, description, type, schema, is_builtin) VALUES
(
    'tool-0001-0001-0001-000000000001',
    NULL,
    'web_search',
    '搜索互联网获取信息',
    'http',
    '{
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "搜索关键词"},
            "limit": {"type": "integer", "default": 10}
        },
        "required": ["query"]
    }',
    true
),
(
    'tool-0001-0001-0001-000000000002',
    NULL,
    'code_interpreter',
    '执行 Python 代码',
    'function',
    '{
        "type": "object",
        "properties": {
            "code": {"type": "string", "description": "Python 代码"},
            "timeout": {"type": "integer", "default": 30}
        },
        "required": ["code"]
    }',
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
            "path": {"type": "string"},
            "encoding": {"type": "string", "default": "utf-8"}
        },
        "required": ["path"]
    }',
    true
);
```

### 2. 004_sample_mcp_servers.sql

```sql
INSERT INTO mcp_servers (id, org_id, name, description, endpoint, transport, auth_type, status, created_by) VALUES
(
    'mcp-1111-1111-1111-111111111111',
    '11111111-1111-1111-1111-111111111111',
    'Filesystem MCP',
    '本地文件系统访问',
    'npx -y @anthropic/mcp-server-filesystem',
    'stdio',
    'none',
    'disconnected',
    '22222222-2222-2222-2222-222222222222'
),
(
    'mcp-1111-1111-1111-222222222222',
    '11111111-1111-1111-1111-111111111111',
    'GitHub MCP',
    'GitHub 仓库访问',
    'npx -y @anthropic/mcp-server-github',
    'stdio',
    'api_key',
    'disconnected',
    '22222222-2222-2222-2222-222222222222'
);
```

### 3. 005_sample_usage_records.sql

```sql
-- 模拟使用量数据
INSERT INTO usage_records (org_id, user_id, agent_id, period_start, period_end, period_type, tokens_input, tokens_output, api_calls, sessions_count) VALUES
(
    '11111111-1111-1111-1111-111111111111',
    NULL,
    NULL,
    '2026-02-01 00:00:00+00',
    '2026-02-01 23:59:59+00',
    'daily',
    50000,
    25000,
    150,
    30
);
```

### 4. 006_sample_edge_cases.sql

```sql
-- 边界测试数据
-- 超长名称
INSERT INTO agents (org_id, name, description, system_prompt, config) VALUES
(
    '11111111-1111-1111-1111-111111111111',
    REPEAT('A', 100),  -- 最大长度名称
    REPEAT('B', 10000),  -- 长描述
    '测试 Agent',
    '{}'
);

-- 特殊字符
INSERT INTO agents (org_id, name, description, system_prompt, config) VALUES
(
    '11111111-1111-1111-1111-111111111111',
    'Test <script>alert(1)</script>',  -- XSS 测试
    'Unicode: 中文 日本語 한국어 🎉',
    '引号测试: "double" ''single''',
    '{}'
);

-- 异常状态
INSERT INTO sessions (id, org_id, agent_id, user_id, status, title) VALUES
(
    'session-fail-0000-0000-000000000001',
    '11111111-1111-1111-1111-111111111111',
    'agent-1111-1111-1111-111111111111',
    '55555555-5555-5555-5555-555555555555',
    'failed',
    '失败的会话'
);

-- 已过期 API Key
INSERT INTO api_keys (id, org_id, user_id, name, key_prefix, key_hash, expires_at) VALUES
(
    'expired-key-0000-0000-000000000001',
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    'Expired Key',
    'sk-exp-',
    'sha256_expired_key_hash',
    '2025-01-01 00:00:00+00'  -- 已过期
);
```

## Files to Create

- `database/seeds/dev/003_sample_tools.sql`
- `database/seeds/dev/004_sample_mcp_servers.sql`
- `database/seeds/dev/005_sample_usage_records.sql`
- `database/seeds/dev/006_sample_edge_cases.sql`

## Acceptance Criteria

- [ ] 所有表都有种子数据
- [ ] 边界值场景覆盖
- [ ] 异常状态数据可用于测试
- [ ] 种子数据脚本可重复执行
