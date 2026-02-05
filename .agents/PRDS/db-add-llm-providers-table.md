# Semibot: Add LLM Providers Table

**Priority:** High
**Status:** Not Started
**Type:** Feature
**Created:** 2026-02-06
**Last Updated:** 2026-02-06

## Overview

添加 LLM Providers 表以支持多模型配置、模型路由和降级策略。

## Description

根据产品需求文档 (FR-MODEL)，系统需要支持：
- 统一适配层提供统一的 LLM Provider 接口
- 支持 OpenAI、Anthropic、Google、Ollama 等多个提供商
- 模型降级：主模型不可用时自动切换到备用模型
- 模型路由：根据任务类型自动选择最优模型

当前数据库缺少存储这些配置的表结构。

## Features / Requirements

### 1. llm_providers 表

存储 LLM 提供商配置：
- 支持多租户（org_id）
- 支持多个提供商类型
- 敏感信息（API Key）加密存储
- 支持自定义 endpoint（兼容 Ollama 等本地模型）

### 2. llm_models 表

存储具体模型配置：
- 关联到 provider
- 模型能力标签（chat/embedding/vision 等）
- 定价信息（用于成本计算）
- 上下文窗口大小

### 3. llm_fallback_rules 表

存储降级规则：
- 主模型 -> 备用模型映射
- 触发条件（错误类型、延迟阈值等）

## Database Schema

```sql
-- ============================================================================
-- 006_add_llm_providers.sql
-- ============================================================================

-- 1. LLM Providers 表
CREATE TABLE llm_providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID,                                              -- 逻辑外键，NULL 表示系统内置
    name VARCHAR(100) NOT NULL,                               -- 显示名称
    provider_type VARCHAR(50) NOT NULL                        -- 提供商类型
        CHECK (provider_type IN ('openai', 'anthropic', 'google', 'azure', 'ollama', 'custom')),
    endpoint VARCHAR(500),                                    -- API 端点（自定义或本地模型）
    api_key_encrypted TEXT,                                   -- 加密的 API Key
    default_headers JSONB DEFAULT '{}',                       -- 默认请求头
    is_default BOOLEAN DEFAULT false,                         -- 是否为默认提供商
    is_active BOOLEAN DEFAULT true,                           -- 是否启用
    created_by UUID,                                          -- 创建者
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_llm_providers_org ON llm_providers(org_id);
CREATE INDEX idx_llm_providers_type ON llm_providers(provider_type);
CREATE INDEX idx_llm_providers_active ON llm_providers(is_active) WHERE is_active = true;
CREATE UNIQUE INDEX idx_llm_providers_unique_name ON llm_providers(COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), name);

CREATE TRIGGER llm_providers_updated_at
    BEFORE UPDATE ON llm_providers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE llm_providers IS 'LLM 提供商配置表';

-- 2. LLM Models 表
CREATE TABLE llm_models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id UUID NOT NULL,                                -- 逻辑外键 -> llm_providers.id
    model_id VARCHAR(100) NOT NULL,                           -- 模型标识（如 gpt-4o）
    display_name VARCHAR(100),                                -- 显示名称
    capabilities TEXT[] DEFAULT '{}',                         -- 能力标签：chat/embedding/vision/function_calling
    context_window INTEGER,                                   -- 上下文窗口大小
    max_output_tokens INTEGER,                                -- 最大输出 token
    input_price_per_1k DECIMAL(10, 6),                        -- 输入价格 ($/1K tokens)
    output_price_per_1k DECIMAL(10, 6),                       -- 输出价格 ($/1K tokens)
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_llm_models_provider ON llm_models(provider_id);
CREATE INDEX idx_llm_models_model_id ON llm_models(model_id);
CREATE UNIQUE INDEX idx_llm_models_unique ON llm_models(provider_id, model_id);

CREATE TRIGGER llm_models_updated_at
    BEFORE UPDATE ON llm_models
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE llm_models IS 'LLM 模型配置表';

-- 3. LLM Fallback Rules 表
CREATE TABLE llm_fallback_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,                                     -- 逻辑外键 -> organizations.id
    primary_model_id UUID NOT NULL,                           -- 主模型（逻辑外键 -> llm_models.id）
    fallback_model_id UUID NOT NULL,                          -- 备用模型
    priority INTEGER DEFAULT 0,                               -- 优先级（多个备用时）
    trigger_conditions JSONB DEFAULT '{}',                    -- 触发条件
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_llm_fallback_org ON llm_fallback_rules(org_id);
CREATE INDEX idx_llm_fallback_primary ON llm_fallback_rules(primary_model_id);

COMMENT ON TABLE llm_fallback_rules IS 'LLM 模型降级规则表';
```

## Seed Data

```sql
-- 内置提供商
INSERT INTO llm_providers (id, org_id, name, provider_type, is_default) VALUES
('provider-openai-000000000001', NULL, 'OpenAI', 'openai', true),
('provider-anthropic-00000001', NULL, 'Anthropic', 'anthropic', false),
('provider-google-0000000001', NULL, 'Google AI', 'google', false);

-- 内置模型
INSERT INTO llm_models (provider_id, model_id, display_name, capabilities, context_window) VALUES
('provider-openai-000000000001', 'gpt-4o', 'GPT-4o', ARRAY['chat', 'vision', 'function_calling'], 128000),
('provider-openai-000000000001', 'gpt-4o-mini', 'GPT-4o Mini', ARRAY['chat', 'function_calling'], 128000),
('provider-anthropic-00000001', 'claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet', ARRAY['chat', 'vision', 'function_calling'], 200000);
```

## Files to Modify

- `database/migrations/006_add_llm_providers.sql` (新建)
- `database/seeds/dev/003_sample_llm_providers.sql` (新建)
- `apps/api/src/repositories/llm-provider.repository.ts` (新建)
- `apps/api/src/services/llm-provider.service.ts` (新建)

## Testing Requirements

### Unit Tests

- [ ] 提供商 CRUD 操作
- [ ] 模型配置查询
- [ ] 降级规则触发逻辑

## Acceptance Criteria

- [ ] 三个表创建成功
- [ ] 种子数据包含主流提供商和模型
- [ ] API Key 加密存储
- [ ] 支持自定义 endpoint
