-- ============================================================================
-- 006_add_llm_providers.sql
-- 添加 LLM Providers 多模型支持表
-- ============================================================================

-- ============================================================================
-- 1. llm_providers - LLM 提供商配置表
-- ============================================================================
CREATE TABLE IF NOT EXISTS llm_providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- 提供商唯一标识
    org_id UUID,                                                    -- 所属组织（逻辑外键 -> organizations.id，NULL表示系统内置）
    name VARCHAR(100) NOT NULL,                                     -- 显示名称
    provider_type VARCHAR(50) NOT NULL                              -- 提供商类型
        CHECK (provider_type IN ('openai', 'anthropic', 'google', 'azure', 'ollama', 'deepseek', 'custom')),
    endpoint VARCHAR(500),                                          -- API 端点（自定义或本地模型）
    api_key_encrypted TEXT,                                         -- 加密的 API Key（AES-256-GCM）
    default_headers JSONB DEFAULT '{}',                             -- 默认请求头
    config JSONB DEFAULT '{}',                                      -- 额外配置（超时、重试等）
    is_default BOOLEAN DEFAULT false,                               -- 是否为默认提供商
    is_active BOOLEAN DEFAULT true,                                 -- 是否启用
    created_by UUID,                                                -- 创建者（逻辑外键 -> users.id）
    created_at TIMESTAMPTZ DEFAULT NOW(),                           -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW()                            -- 更新时间
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_llm_providers_org ON llm_providers(org_id);
CREATE INDEX IF NOT EXISTS idx_llm_providers_type ON llm_providers(provider_type);
CREATE INDEX IF NOT EXISTS idx_llm_providers_active ON llm_providers(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_llm_providers_default ON llm_providers(org_id, is_default) WHERE is_default = true;

-- 唯一约束：同一组织内提供商名称唯一
CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_providers_unique_name
    ON llm_providers(COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), name);

-- 更新触发器
DROP TRIGGER IF EXISTS llm_providers_updated_at ON llm_providers;
CREATE TRIGGER llm_providers_updated_at
    BEFORE UPDATE ON llm_providers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE llm_providers IS 'LLM 提供商配置表';
COMMENT ON COLUMN llm_providers.id IS '提供商唯一标识';
COMMENT ON COLUMN llm_providers.org_id IS '逻辑外键，关联 organizations.id，NULL表示系统内置';
COMMENT ON COLUMN llm_providers.name IS '显示名称';
COMMENT ON COLUMN llm_providers.provider_type IS '提供商类型：openai/anthropic/google/azure/ollama/deepseek/custom';
COMMENT ON COLUMN llm_providers.endpoint IS 'API 端点，自定义或本地模型时使用';
COMMENT ON COLUMN llm_providers.api_key_encrypted IS '加密的 API Key（AES-256-GCM）';
COMMENT ON COLUMN llm_providers.default_headers IS '默认请求头 JSON';
COMMENT ON COLUMN llm_providers.config IS '额外配置 JSON（超时、重试等）';
COMMENT ON COLUMN llm_providers.is_default IS '是否为默认提供商';
COMMENT ON COLUMN llm_providers.is_active IS '是否启用';
COMMENT ON COLUMN llm_providers.created_by IS '逻辑外键，关联 users.id';

-- ============================================================================
-- 2. llm_models - LLM 模型配置表
-- ============================================================================
CREATE TABLE IF NOT EXISTS llm_models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- 模型唯一标识
    provider_id UUID NOT NULL,                                      -- 所属提供商（逻辑外键 -> llm_providers.id）
    model_id VARCHAR(100) NOT NULL,                                 -- 模型标识（如 gpt-4o）
    display_name VARCHAR(100),                                      -- 显示名称
    capabilities TEXT[] DEFAULT '{}',                               -- 能力标签：chat/embedding/vision/function_calling/reasoning
    context_window INTEGER,                                         -- 上下文窗口大小
    max_output_tokens INTEGER,                                      -- 最大输出 token
    input_price_per_1k DECIMAL(10, 6),                              -- 输入价格 ($/1K tokens)
    output_price_per_1k DECIMAL(10, 6),                             -- 输出价格 ($/1K tokens)
    config JSONB DEFAULT '{}',                                      -- 模型特定配置
    is_active BOOLEAN DEFAULT true,                                 -- 是否启用
    created_at TIMESTAMPTZ DEFAULT NOW(),                           -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW()                            -- 更新时间
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_llm_models_provider ON llm_models(provider_id);
CREATE INDEX IF NOT EXISTS idx_llm_models_model_id ON llm_models(model_id);
CREATE INDEX IF NOT EXISTS idx_llm_models_active ON llm_models(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_llm_models_capabilities ON llm_models USING GIN(capabilities);

-- 唯一约束：同一提供商内模型标识唯一
CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_models_unique ON llm_models(provider_id, model_id);

-- 更新触发器
DROP TRIGGER IF EXISTS llm_models_updated_at ON llm_models;
CREATE TRIGGER llm_models_updated_at
    BEFORE UPDATE ON llm_models
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE llm_models IS 'LLM 模型配置表';
COMMENT ON COLUMN llm_models.id IS '模型唯一标识';
COMMENT ON COLUMN llm_models.provider_id IS '逻辑外键，关联 llm_providers.id';
COMMENT ON COLUMN llm_models.model_id IS '模型标识（如 gpt-4o、claude-3-5-sonnet）';
COMMENT ON COLUMN llm_models.display_name IS '显示名称';
COMMENT ON COLUMN llm_models.capabilities IS '能力标签数组：chat/embedding/vision/function_calling/reasoning';
COMMENT ON COLUMN llm_models.context_window IS '上下文窗口大小（tokens）';
COMMENT ON COLUMN llm_models.max_output_tokens IS '最大输出 token 数';
COMMENT ON COLUMN llm_models.input_price_per_1k IS '输入价格（美元/1K tokens）';
COMMENT ON COLUMN llm_models.output_price_per_1k IS '输出价格（美元/1K tokens）';
COMMENT ON COLUMN llm_models.config IS '模型特定配置 JSON';
COMMENT ON COLUMN llm_models.is_active IS '是否启用';

-- ============================================================================
-- 3. llm_fallback_rules - LLM 模型降级规则表
-- ============================================================================
CREATE TABLE IF NOT EXISTS llm_fallback_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- 规则唯一标识
    org_id UUID NOT NULL,                                           -- 所属组织（逻辑外键 -> organizations.id）
    name VARCHAR(100),                                              -- 规则名称
    primary_model_id UUID NOT NULL,                                 -- 主模型（逻辑外键 -> llm_models.id）
    fallback_model_id UUID NOT NULL,                                -- 备用模型（逻辑外键 -> llm_models.id）
    priority INTEGER DEFAULT 0,                                     -- 优先级（数值越大优先级越高）
    trigger_conditions JSONB DEFAULT '{
        "error_codes": ["rate_limit", "service_unavailable", "timeout"],
        "max_latency_ms": 30000,
        "max_retries": 3
    }',                                                            -- 触发条件
    is_active BOOLEAN DEFAULT true,                                 -- 是否启用
    created_by UUID,                                                -- 创建者
    created_at TIMESTAMPTZ DEFAULT NOW(),                           -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW()                            -- 更新时间
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_llm_fallback_org ON llm_fallback_rules(org_id);
CREATE INDEX IF NOT EXISTS idx_llm_fallback_primary ON llm_fallback_rules(primary_model_id);
CREATE INDEX IF NOT EXISTS idx_llm_fallback_active ON llm_fallback_rules(is_active) WHERE is_active = true;

-- 唯一约束：同一组织内主模型+备用模型组合唯一
CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_fallback_unique
    ON llm_fallback_rules(org_id, primary_model_id, fallback_model_id);

-- 更新触发器
DROP TRIGGER IF EXISTS llm_fallback_rules_updated_at ON llm_fallback_rules;
CREATE TRIGGER llm_fallback_rules_updated_at
    BEFORE UPDATE ON llm_fallback_rules
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE llm_fallback_rules IS 'LLM 模型降级规则表';
COMMENT ON COLUMN llm_fallback_rules.id IS '规则唯一标识';
COMMENT ON COLUMN llm_fallback_rules.org_id IS '逻辑外键，关联 organizations.id';
COMMENT ON COLUMN llm_fallback_rules.name IS '规则名称';
COMMENT ON COLUMN llm_fallback_rules.primary_model_id IS '逻辑外键，关联 llm_models.id，主模型';
COMMENT ON COLUMN llm_fallback_rules.fallback_model_id IS '逻辑外键，关联 llm_models.id，备用模型';
COMMENT ON COLUMN llm_fallback_rules.priority IS '优先级，数值越大优先级越高';
COMMENT ON COLUMN llm_fallback_rules.trigger_conditions IS '触发条件 JSON（错误码、延迟阈值等）';
COMMENT ON COLUMN llm_fallback_rules.is_active IS '是否启用';
COMMENT ON COLUMN llm_fallback_rules.created_by IS '逻辑外键，关联 users.id';

-- ============================================================================
-- 4. 验证表创建成功
-- ============================================================================
-- 可通过以下查询验证：
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public' AND table_name LIKE 'llm_%';
