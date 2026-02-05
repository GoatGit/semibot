-- ============================================================================
-- 001_sample_org.sql
-- 开发环境示例组织和用户数据
-- ============================================================================

-- 注意：此脚本仅用于开发环境，切勿在生产环境执行

-- ----------------------------------------------------------------------------
-- 1. 创建示例组织
-- ----------------------------------------------------------------------------
INSERT INTO organizations (id, name, slug, owner_id, plan, quota, settings) VALUES
(
    '11111111-1111-1111-1111-111111111111',
    'Semibot Dev Team',
    'semibot-dev',
    '22222222-2222-2222-2222-222222222222',  -- 逻辑外键，指向下面创建的用户
    'pro',
    '{
        "max_agents": 50,
        "max_tokens_per_month": 10000000,
        "max_api_calls_per_day": 100000,
        "max_sessions_per_day": 10000,
        "max_memory_mb": 10240
    }',
    '{
        "theme": "dark",
        "language": "zh-CN",
        "timezone": "Asia/Shanghai"
    }'
),
(
    '33333333-3333-3333-3333-333333333333',
    'Demo Organization',
    'demo-org',
    '44444444-4444-4444-4444-444444444444',
    'free',
    '{
        "max_agents": 5,
        "max_tokens_per_month": 100000,
        "max_api_calls_per_day": 1000,
        "max_sessions_per_day": 100,
        "max_memory_mb": 1024
    }',
    '{
        "theme": "light",
        "language": "en-US",
        "timezone": "UTC"
    }'
);

-- ----------------------------------------------------------------------------
-- 2. 创建示例用户
-- ----------------------------------------------------------------------------
-- 密码哈希说明：以下哈希对应密码 "password123"（仅供开发测试）
-- 实际使用时应通过 bcrypt 或 argon2 生成

INSERT INTO users (id, email, password_hash, name, org_id, role, email_verified) VALUES
-- Semibot Dev Team 用户
(
    '22222222-2222-2222-2222-222222222222',
    'admin@semibot.dev',
    '$2b$10$rQZ8K.Xq5H8H8H8H8H8H8e8H8H8H8H8H8H8H8H8H8H8H8H8H8H8',
    'Admin User',
    '11111111-1111-1111-1111-111111111111',
    'owner',
    true
),
(
    '55555555-5555-5555-5555-555555555555',
    'developer@semibot.dev',
    '$2b$10$rQZ8K.Xq5H8H8H8H8H8H8e8H8H8H8H8H8H8H8H8H8H8H8H8H8H8',
    'Developer User',
    '11111111-1111-1111-1111-111111111111',
    'admin',
    true
),
(
    '66666666-6666-6666-6666-666666666666',
    'tester@semibot.dev',
    '$2b$10$rQZ8K.Xq5H8H8H8H8H8H8e8H8H8H8H8H8H8H8H8H8H8H8H8H8H8',
    'Tester User',
    '11111111-1111-1111-1111-111111111111',
    'member',
    true
),
-- Demo Organization 用户
(
    '44444444-4444-4444-4444-444444444444',
    'demo@example.com',
    '$2b$10$rQZ8K.Xq5H8H8H8H8H8H8e8H8H8H8H8H8H8H8H8H8H8H8H8H8H8',
    'Demo User',
    '33333333-3333-3333-3333-333333333333',
    'owner',
    true
);

-- ----------------------------------------------------------------------------
-- 3. 创建示例 API Keys
-- ----------------------------------------------------------------------------
-- key_hash 说明：以下为示例哈希，实际密钥应在创建时生成并安全存储

INSERT INTO api_keys (id, org_id, user_id, name, key_prefix, key_hash, permissions, rate_limit) VALUES
(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    'Development API Key',
    'sk-dev-',
    'sha256_hash_placeholder_dev_key_12345678901234567890',
    '["*"]',
    1000
),
(
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    '11111111-1111-1111-1111-111111111111',
    '55555555-5555-5555-5555-555555555555',
    'Testing API Key',
    'sk-test',
    'sha256_hash_placeholder_test_key_1234567890123456789',
    '["agents:read", "chat:*", "sessions:*"]',
    500
),
(
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
    'Demo API Key',
    'sk-demo',
    'sha256_hash_placeholder_demo_key_1234567890123456789',
    '["agents:read", "chat:*"]',
    60
);

-- ----------------------------------------------------------------------------
-- 4. 验证数据
-- ----------------------------------------------------------------------------
-- 可通过以下查询验证数据插入是否成功：
-- SELECT * FROM organizations;
-- SELECT * FROM users;
-- SELECT * FROM api_keys;
