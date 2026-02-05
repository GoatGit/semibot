-- ============================================================================
-- 002_add_api_keys.sql
-- API Key 管理表
-- ============================================================================

-- ============================================================================
-- api_keys - API密钥表
-- ============================================================================
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- 密钥唯一标识
    org_id UUID NOT NULL,                                           -- 所属组织（逻辑外键 -> organizations.id）
    user_id UUID NOT NULL,                                          -- 创建者（逻辑外键 -> users.id）
    name VARCHAR(100) NOT NULL,                                     -- 密钥名称（便于识别）
    key_prefix VARCHAR(10) NOT NULL,                                -- 密钥前缀（用于显示，如 sk-abc...）
    key_hash VARCHAR(255) NOT NULL,                                 -- 密钥哈希（SHA256）
    permissions JSONB DEFAULT '["*"]',                              -- 权限列表
    rate_limit INTEGER DEFAULT 60,                                  -- 每分钟请求限制
    expires_at TIMESTAMPTZ,                                         -- 过期时间（可选）
    last_used_at TIMESTAMPTZ,                                       -- 最后使用时间
    last_used_ip VARCHAR(45),                                       -- 最后使用IP地址
    usage_count INTEGER DEFAULT 0,                                  -- 使用次数
    is_active BOOLEAN DEFAULT true,                                 -- 是否启用
    created_at TIMESTAMPTZ DEFAULT NOW(),                           -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW()                            -- 更新时间
);

-- 索引
CREATE INDEX idx_api_keys_org ON api_keys(org_id);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);
CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix);
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_active ON api_keys(is_active) WHERE is_active = true;
CREATE INDEX idx_api_keys_expires ON api_keys(expires_at) WHERE expires_at IS NOT NULL;

-- 更新触发器
CREATE TRIGGER api_keys_updated_at
    BEFORE UPDATE ON api_keys
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE api_keys IS 'API密钥管理表';
COMMENT ON COLUMN api_keys.id IS '密钥唯一标识';
COMMENT ON COLUMN api_keys.org_id IS '逻辑外键，关联 organizations.id';
COMMENT ON COLUMN api_keys.user_id IS '逻辑外键，关联 users.id';
COMMENT ON COLUMN api_keys.name IS '密钥名称，便于用户识别';
COMMENT ON COLUMN api_keys.key_prefix IS '密钥前缀，用于显示（如 sk-abc...）';
COMMENT ON COLUMN api_keys.key_hash IS '密钥哈希值（SHA256），用于验证';
COMMENT ON COLUMN api_keys.permissions IS '权限列表 JSON，如 ["*"] 或 ["agents:read", "chat:*"]';
COMMENT ON COLUMN api_keys.rate_limit IS '每分钟请求限制';
COMMENT ON COLUMN api_keys.expires_at IS '过期时间，NULL表示永不过期';
COMMENT ON COLUMN api_keys.last_used_at IS '最后使用时间';
COMMENT ON COLUMN api_keys.last_used_ip IS '最后使用IP地址';
COMMENT ON COLUMN api_keys.usage_count IS '累计使用次数';
COMMENT ON COLUMN api_keys.is_active IS '是否启用';

-- ============================================================================
-- api_key_logs - API密钥使用日志表（可选，用于审计）
-- ============================================================================
CREATE TABLE api_key_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- 日志唯一标识
    api_key_id UUID NOT NULL,                                       -- API密钥ID（逻辑外键 -> api_keys.id）
    org_id UUID NOT NULL,                                           -- 组织ID（逻辑外键 -> organizations.id）
    endpoint VARCHAR(200) NOT NULL,                                 -- 请求端点
    method VARCHAR(10) NOT NULL,                                    -- HTTP方法
    status_code INTEGER,                                            -- 响应状态码
    ip_address VARCHAR(45),                                         -- 请求IP地址
    user_agent TEXT,                                                -- User-Agent
    request_id VARCHAR(100),                                        -- 请求追踪ID
    latency_ms INTEGER,                                             -- 响应延迟（毫秒）
    created_at TIMESTAMPTZ DEFAULT NOW()                            -- 创建时间
);

-- 索引
CREATE INDEX idx_api_key_logs_key ON api_key_logs(api_key_id);
CREATE INDEX idx_api_key_logs_org ON api_key_logs(org_id);
CREATE INDEX idx_api_key_logs_created ON api_key_logs(created_at DESC);
CREATE INDEX idx_api_key_logs_endpoint ON api_key_logs(endpoint);
CREATE INDEX idx_api_key_logs_status ON api_key_logs(status_code);

COMMENT ON TABLE api_key_logs IS 'API密钥使用日志表，用于审计和监控';
COMMENT ON COLUMN api_key_logs.id IS '日志唯一标识';
COMMENT ON COLUMN api_key_logs.api_key_id IS '逻辑外键，关联 api_keys.id';
COMMENT ON COLUMN api_key_logs.org_id IS '逻辑外键，关联 organizations.id';
COMMENT ON COLUMN api_key_logs.endpoint IS '请求端点路径';
COMMENT ON COLUMN api_key_logs.method IS 'HTTP方法（GET/POST/PUT/DELETE等）';
COMMENT ON COLUMN api_key_logs.status_code IS 'HTTP响应状态码';
COMMENT ON COLUMN api_key_logs.ip_address IS '请求来源IP地址';
COMMENT ON COLUMN api_key_logs.user_agent IS '请求User-Agent';
COMMENT ON COLUMN api_key_logs.request_id IS '请求追踪ID';
COMMENT ON COLUMN api_key_logs.latency_ms IS '响应延迟（毫秒）';
