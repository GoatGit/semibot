-- ============================================================================
-- 003_sample_llm_providers.sql
-- 开发环境 LLM 提供商和模型种子数据
-- ============================================================================

-- 注意：此脚本仅用于开发环境，切勿在生产环境执行
-- 依赖：需要先执行 006_add_llm_providers.sql

-- ============================================================================
-- 1. 系统内置提供商（org_id 为 NULL）
-- ============================================================================
INSERT INTO llm_providers (id, org_id, name, provider_type, endpoint, is_default, config) VALUES
(
    'provider-0001-0001-0001-000000000001',
    NULL,
    'OpenAI',
    'openai',
    'https://api.openai.com/v1',
    true,
    '{"timeout_ms": 120000, "max_retries": 3}'
),
(
    'provider-0001-0001-0001-000000000002',
    NULL,
    'Anthropic',
    'anthropic',
    'https://api.anthropic.com',
    false,
    '{"timeout_ms": 120000, "max_retries": 3}'
),
(
    'provider-0001-0001-0001-000000000003',
    NULL,
    'Google AI',
    'google',
    'https://generativelanguage.googleapis.com',
    false,
    '{"timeout_ms": 120000, "max_retries": 3}'
),
(
    'provider-0001-0001-0001-000000000004',
    NULL,
    'Azure OpenAI',
    'azure',
    NULL,  -- 需要用户配置具体端点
    false,
    '{"timeout_ms": 120000, "max_retries": 3}'
),
(
    'provider-0001-0001-0001-000000000005',
    NULL,
    'DeepSeek',
    'deepseek',
    'https://api.deepseek.com',
    false,
    '{"timeout_ms": 180000, "max_retries": 3}'
),
(
    'provider-0001-0001-0001-000000000006',
    NULL,
    'Ollama (Local)',
    'ollama',
    'http://localhost:11434',
    false,
    '{"timeout_ms": 300000, "max_retries": 1}'
)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 2. 系统内置模型
-- ============================================================================

-- OpenAI 模型
INSERT INTO llm_models (id, provider_id, model_id, display_name, capabilities, context_window, max_output_tokens, input_price_per_1k, output_price_per_1k) VALUES
(
    'model-0001-0001-0001-000000000001',
    'provider-0001-0001-0001-000000000001',
    'gpt-4o',
    'GPT-4o',
    ARRAY['chat', 'vision', 'function_calling'],
    128000,
    16384,
    0.0025,
    0.01
),
(
    'model-0001-0001-0001-000000000002',
    'provider-0001-0001-0001-000000000001',
    'gpt-4o-mini',
    'GPT-4o Mini',
    ARRAY['chat', 'vision', 'function_calling'],
    128000,
    16384,
    0.00015,
    0.0006
),
(
    'model-0001-0001-0001-000000000003',
    'provider-0001-0001-0001-000000000001',
    'o1',
    'o1 (Reasoning)',
    ARRAY['chat', 'reasoning'],
    200000,
    100000,
    0.015,
    0.06
),
(
    'model-0001-0001-0001-000000000004',
    'provider-0001-0001-0001-000000000001',
    'o1-mini',
    'o1 Mini (Reasoning)',
    ARRAY['chat', 'reasoning'],
    128000,
    65536,
    0.003,
    0.012
),
(
    'model-0001-0001-0001-000000000005',
    'provider-0001-0001-0001-000000000001',
    'text-embedding-3-small',
    'Embedding 3 Small',
    ARRAY['embedding'],
    8191,
    NULL,
    0.00002,
    NULL
),
(
    'model-0001-0001-0001-000000000006',
    'provider-0001-0001-0001-000000000001',
    'text-embedding-3-large',
    'Embedding 3 Large',
    ARRAY['embedding'],
    8191,
    NULL,
    0.00013,
    NULL
)
ON CONFLICT DO NOTHING;

-- Anthropic 模型
INSERT INTO llm_models (id, provider_id, model_id, display_name, capabilities, context_window, max_output_tokens, input_price_per_1k, output_price_per_1k) VALUES
(
    'model-0001-0001-0001-000000000010',
    'provider-0001-0001-0001-000000000002',
    'claude-3-5-sonnet-20241022',
    'Claude 3.5 Sonnet',
    ARRAY['chat', 'vision', 'function_calling'],
    200000,
    8192,
    0.003,
    0.015
),
(
    'model-0001-0001-0001-000000000011',
    'provider-0001-0001-0001-000000000002',
    'claude-3-5-haiku-20241022',
    'Claude 3.5 Haiku',
    ARRAY['chat', 'vision', 'function_calling'],
    200000,
    8192,
    0.0008,
    0.004
),
(
    'model-0001-0001-0001-000000000012',
    'provider-0001-0001-0001-000000000002',
    'claude-3-opus-20240229',
    'Claude 3 Opus',
    ARRAY['chat', 'vision', 'function_calling'],
    200000,
    4096,
    0.015,
    0.075
)
ON CONFLICT DO NOTHING;

-- Google 模型
INSERT INTO llm_models (id, provider_id, model_id, display_name, capabilities, context_window, max_output_tokens, input_price_per_1k, output_price_per_1k) VALUES
(
    'model-0001-0001-0001-000000000020',
    'provider-0001-0001-0001-000000000003',
    'gemini-2.0-flash',
    'Gemini 2.0 Flash',
    ARRAY['chat', 'vision', 'function_calling'],
    1000000,
    8192,
    0.00015,
    0.0006
),
(
    'model-0001-0001-0001-000000000021',
    'provider-0001-0001-0001-000000000003',
    'gemini-1.5-pro',
    'Gemini 1.5 Pro',
    ARRAY['chat', 'vision', 'function_calling'],
    2000000,
    8192,
    0.00125,
    0.005
)
ON CONFLICT DO NOTHING;

-- DeepSeek 模型
INSERT INTO llm_models (id, provider_id, model_id, display_name, capabilities, context_window, max_output_tokens, input_price_per_1k, output_price_per_1k) VALUES
(
    'model-0001-0001-0001-000000000030',
    'provider-0001-0001-0001-000000000005',
    'deepseek-chat',
    'DeepSeek Chat',
    ARRAY['chat', 'function_calling'],
    64000,
    8192,
    0.00014,
    0.00028
),
(
    'model-0001-0001-0001-000000000031',
    'provider-0001-0001-0001-000000000005',
    'deepseek-reasoner',
    'DeepSeek Reasoner (R1)',
    ARRAY['chat', 'reasoning'],
    64000,
    8192,
    0.00055,
    0.00219
)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 3. 开发环境组织自定义提供商
-- ============================================================================
INSERT INTO llm_providers (id, org_id, name, provider_type, endpoint, api_key_encrypted, is_default, created_by) VALUES
(
    'provider-1111-1111-1111-111111111111',
    '11111111-1111-1111-1111-111111111111',
    'Dev Ollama',
    'ollama',
    'http://localhost:11434',
    NULL,
    false,
    '22222222-2222-2222-2222-222222222222'
)
ON CONFLICT DO NOTHING;

-- 本地 Ollama 模型
INSERT INTO llm_models (id, provider_id, model_id, display_name, capabilities, context_window, max_output_tokens) VALUES
(
    'model-1111-1111-1111-111111111111',
    'provider-1111-1111-1111-111111111111',
    'qwen2.5:14b',
    'Qwen 2.5 14B (Local)',
    ARRAY['chat', 'function_calling'],
    32768,
    8192
),
(
    'model-1111-1111-1111-222222222222',
    'provider-1111-1111-1111-111111111111',
    'llama3.2:latest',
    'Llama 3.2 (Local)',
    ARRAY['chat'],
    131072,
    8192
)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 4. 示例降级规则
-- ============================================================================
INSERT INTO llm_fallback_rules (id, org_id, name, primary_model_id, fallback_model_id, priority, trigger_conditions, created_by) VALUES
(
    'fallback-1111-1111-1111-111111111111',
    '11111111-1111-1111-1111-111111111111',
    'GPT-4o 降级到 GPT-4o-mini',
    'model-0001-0001-0001-000000000001',  -- gpt-4o
    'model-0001-0001-0001-000000000002',  -- gpt-4o-mini
    10,
    '{"error_codes": ["rate_limit", "service_unavailable"], "max_latency_ms": 30000, "max_retries": 2}',
    '22222222-2222-2222-2222-222222222222'
),
(
    'fallback-1111-1111-1111-222222222222',
    '11111111-1111-1111-1111-111111111111',
    'Claude 3.5 Sonnet 降级到 Haiku',
    'model-0001-0001-0001-000000000010',  -- claude-3-5-sonnet
    'model-0001-0001-0001-000000000011',  -- claude-3-5-haiku
    10,
    '{"error_codes": ["rate_limit", "overloaded"], "max_latency_ms": 60000, "max_retries": 2}',
    '22222222-2222-2222-2222-222222222222'
)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- 5. 验证数据
-- ============================================================================
-- 可通过以下查询验证数据插入是否成功：
-- SELECT * FROM llm_providers;
-- SELECT * FROM llm_models;
-- SELECT * FROM llm_fallback_rules;
