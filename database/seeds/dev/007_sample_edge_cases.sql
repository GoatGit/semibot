-- ============================================================================
-- 007_sample_edge_cases.sql
-- 开发环境边界测试和异常场景种子数据
-- ============================================================================

-- 注意：此脚本仅用于开发/测试环境，用于验证边界处理

-- ============================================================================
-- 1. 边界值测试 - 超长字段
-- ============================================================================

-- 最大长度名称的 Agent
INSERT INTO agents (id, org_id, name, description, system_prompt, config) VALUES
(
    'agent-edge-0001-0001-000000000001',
    '11111111-1111-1111-1111-111111111111',
    REPEAT('A', 100),  -- 100 字符名称
    REPEAT('这是一段很长的描述文本。', 500),  -- 长描述
    '测试 Agent - 边界值测试',
    '{}'
)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 2. 特殊字符测试
-- ============================================================================

-- 包含特殊字符的 Agent
INSERT INTO agents (id, org_id, name, description, system_prompt, config) VALUES
(
    'agent-edge-0001-0001-000000000002',
    '11111111-1111-1111-1111-111111111111',
    'Test <script>alert(1)</script>',  -- XSS 测试
    'Unicode: 中文 日本語 한국어 العربية 🎉🚀💡',
    E'引号测试: "double" \'single\' `backtick`\n换行测试\n\t制表符',
    '{"special": "value with \"quotes\" and \\backslash"}'
)
ON CONFLICT DO NOTHING;

-- 包含 SQL 注入尝试的技能
INSERT INTO skills (id, org_id, name, description, trigger_keywords, tools, config, is_builtin, created_by) VALUES
(
    'skill-edge-0001-0001-000000000001',
    '11111111-1111-1111-1111-111111111111',
    'SQL Injection Test''; DROP TABLE users; --',
    'Description with SQL: SELECT * FROM users WHERE 1=1',
    ARRAY['test', 'injection'],
    '[]',
    '{}',
    false,
    '22222222-2222-2222-2222-222222222222'
)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 3. 异常状态测试
-- ============================================================================

-- 失败的会话
INSERT INTO sessions (id, org_id, agent_id, user_id, status, title, metadata, ended_at) VALUES
(
    'session-edge-0001-0001-000000000001',
    '11111111-1111-1111-1111-111111111111',
    'agent-1111-1111-1111-111111111111',
    '55555555-5555-5555-5555-555555555555',
    'failed',
    '失败的会话 - 超时',
    '{"error": "timeout", "error_message": "处理超时"}',
    NOW() - INTERVAL '1 hour'
)
ON CONFLICT DO NOTHING;

-- 暂停的会话
INSERT INTO sessions (id, org_id, agent_id, user_id, status, title, metadata) VALUES
(
    'session-edge-0001-0001-000000000002',
    '11111111-1111-1111-1111-111111111111',
    'agent-1111-1111-1111-111111111111',
    '55555555-5555-5555-5555-555555555555',
    'paused',
    '暂停的会话 - 等待用户确认',
    '{"paused_reason": "awaiting_confirmation"}'
)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 4. 过期数据测试
-- ============================================================================

-- 已过期的 API Key
INSERT INTO api_keys (id, org_id, user_id, name, key_prefix, key_hash, expires_at, is_active) VALUES
(
    'apikey-edge-0001-0001-000000000001',
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    'Expired Key',
    'sk-exp-',
    'sha256_expired_key_hash_placeholder_12345678901234',
    '2025-01-01 00:00:00+00',  -- 已过期
    false
)
ON CONFLICT DO NOTHING;

-- 已过期的记忆
INSERT INTO memories (id, org_id, agent_id, content, memory_type, importance, expires_at) VALUES
(
    'memory-edge-0001-0001-000000000001',
    '11111111-1111-1111-1111-111111111111',
    'agent-1111-1111-1111-111111111111',
    '这是一条已过期的记忆',
    'episodic',
    0.3,
    '2025-01-01 00:00:00+00'  -- 已过期
)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 5. 禁用状态测试
-- ============================================================================

-- 禁用的 Agent
INSERT INTO agents (id, org_id, name, description, system_prompt, config, is_active) VALUES
(
    'agent-edge-0001-0001-000000000003',
    '11111111-1111-1111-1111-111111111111',
    'Disabled Agent',
    '这是一个被禁用的 Agent',
    '禁用测试',
    '{}',
    false
)
ON CONFLICT DO NOTHING;

-- 禁用的技能
INSERT INTO skills (id, org_id, name, description, trigger_keywords, tools, config, is_builtin, is_active, created_by) VALUES
(
    'skill-edge-0001-0001-000000000002',
    '11111111-1111-1111-1111-111111111111',
    'Disabled Skill',
    '这是一个被禁用的技能',
    ARRAY['disabled'],
    '[]',
    '{}',
    false,
    false,
    '22222222-2222-2222-2222-222222222222'
)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 6. 空值和边界数值测试
-- ============================================================================

-- 最小 importance 记忆
INSERT INTO memories (id, org_id, agent_id, content, memory_type, importance) VALUES
(
    'memory-edge-0001-0001-000000000002',
    '11111111-1111-1111-1111-111111111111',
    'agent-1111-1111-1111-111111111111',
    '最低重要性记忆',
    'episodic',
    0.0
)
ON CONFLICT DO NOTHING;

-- 最大 importance 记忆
INSERT INTO memories (id, org_id, agent_id, content, memory_type, importance) VALUES
(
    'memory-edge-0001-0001-000000000003',
    '11111111-1111-1111-1111-111111111111',
    'agent-1111-1111-1111-111111111111',
    '最高重要性记忆',
    'episodic',
    1.0
)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 7. 验证数据
-- ============================================================================
-- SELECT * FROM agents WHERE id LIKE 'agent-edge%';
-- SELECT * FROM sessions WHERE status IN ('failed', 'paused');
-- SELECT * FROM api_keys WHERE expires_at < NOW();
-- SELECT * FROM memories WHERE expires_at < NOW();
