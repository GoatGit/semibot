-- ============================================================================
-- 001_init_schema.sql
-- 初始化核心表结构
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 启用必要扩展
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ----------------------------------------------------------------------------
-- 通用触发器函数
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_updated_at() IS '自动更新 updated_at 字段的触发器函数';

-- ============================================================================
-- 1. organizations - 组织/租户表
-- ============================================================================
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- 组织唯一标识
    name VARCHAR(100) NOT NULL,                                     -- 组织名称
    slug VARCHAR(50) NOT NULL UNIQUE,                               -- URL友好标识（全局唯一）
    owner_id UUID NOT NULL,                                         -- 创建者用户ID（逻辑外键 -> users.id）
    plan VARCHAR(20) DEFAULT 'free'                                 -- 订阅计划
        CHECK (plan IN ('free', 'pro', 'enterprise')),
    quota JSONB DEFAULT '{
        "max_agents": 5,
        "max_tokens_per_month": 100000,
        "max_api_calls_per_day": 1000,
        "max_sessions_per_day": 100,
        "max_memory_mb": 1024
    }',                                                             -- 配额限制
    settings JSONB DEFAULT '{}',                                    -- 组织级设置
    is_active BOOLEAN DEFAULT true,                                 -- 是否启用
    created_at TIMESTAMPTZ DEFAULT NOW(),                           -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW()                            -- 更新时间
);

-- 索引
CREATE INDEX idx_organizations_slug ON organizations(slug);
CREATE INDEX idx_organizations_owner ON organizations(owner_id);
CREATE INDEX idx_organizations_active ON organizations(is_active) WHERE is_active = true;

-- 更新触发器
CREATE TRIGGER organizations_updated_at
    BEFORE UPDATE ON organizations
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE organizations IS '组织/租户表，支持多租户隔离';
COMMENT ON COLUMN organizations.id IS '组织唯一标识';
COMMENT ON COLUMN organizations.name IS '组织名称';
COMMENT ON COLUMN organizations.slug IS 'URL友好标识，用于路由';
COMMENT ON COLUMN organizations.owner_id IS '逻辑外键，关联 users.id';
COMMENT ON COLUMN organizations.plan IS '订阅计划：free/pro/enterprise';
COMMENT ON COLUMN organizations.quota IS '配额限制 JSON';
COMMENT ON COLUMN organizations.settings IS '组织级设置 JSON';
COMMENT ON COLUMN organizations.is_active IS '是否启用';

-- ============================================================================
-- 2. users - 用户表
-- ============================================================================
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- 用户唯一标识
    email VARCHAR(255) NOT NULL UNIQUE,                             -- 邮箱（登录账号，全局唯一）
    password_hash VARCHAR(255),                                     -- 密码哈希（OAuth用户可为空）
    name VARCHAR(100),                                              -- 显示名称
    avatar_url VARCHAR(500),                                        -- 头像URL
    org_id UUID NOT NULL,                                           -- 所属组织（逻辑外键 -> organizations.id）
    role VARCHAR(20) DEFAULT 'member'                               -- 组织内角色
        CHECK (role IN ('owner', 'admin', 'member')),
    auth_provider VARCHAR(20) DEFAULT 'email'                       -- 认证方式
        CHECK (auth_provider IN ('email', 'google', 'github')),
    auth_provider_id VARCHAR(255),                                  -- 第三方认证ID
    email_verified BOOLEAN DEFAULT false,                           -- 邮箱是否验证
    last_login_at TIMESTAMPTZ,                                      -- 最后登录时间
    is_active BOOLEAN DEFAULT true,                                 -- 是否启用
    created_at TIMESTAMPTZ DEFAULT NOW(),                           -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW()                            -- 更新时间
);

-- 索引
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_org ON users(org_id);
CREATE INDEX idx_users_auth ON users(auth_provider, auth_provider_id);
CREATE INDEX idx_users_active ON users(is_active) WHERE is_active = true;

-- 更新触发器
CREATE TRIGGER users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE users IS '用户账户表';
COMMENT ON COLUMN users.id IS '用户唯一标识';
COMMENT ON COLUMN users.email IS '邮箱，用于登录';
COMMENT ON COLUMN users.password_hash IS '密码哈希，OAuth用户可为空';
COMMENT ON COLUMN users.name IS '显示名称';
COMMENT ON COLUMN users.avatar_url IS '头像URL';
COMMENT ON COLUMN users.org_id IS '逻辑外键，关联 organizations.id';
COMMENT ON COLUMN users.role IS '组织内角色：owner/admin/member';
COMMENT ON COLUMN users.auth_provider IS '认证方式：email/google/github';
COMMENT ON COLUMN users.auth_provider_id IS '第三方认证ID';
COMMENT ON COLUMN users.email_verified IS '邮箱是否已验证';
COMMENT ON COLUMN users.last_login_at IS '最后登录时间';
COMMENT ON COLUMN users.is_active IS '是否启用';

-- ============================================================================
-- 3. agents - 智能体定义表
-- ============================================================================
CREATE TABLE agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- Agent唯一标识
    org_id UUID NOT NULL,                                           -- 所属组织（逻辑外键 -> organizations.id）
    name VARCHAR(100) NOT NULL,                                     -- Agent名称
    description TEXT,                                               -- 描述信息
    system_prompt TEXT NOT NULL,                                    -- 系统提示词
    config JSONB DEFAULT '{
        "model": "gpt-4o",
        "temperature": 0.7,
        "max_tokens": 4096,
        "timeout_seconds": 120,
        "retry_attempts": 3
    }',                                                             -- 模型配置
    skills TEXT[] DEFAULT '{}',                                     -- 关联技能ID列表
    sub_agents TEXT[] DEFAULT '{}',                                 -- 子Agent ID列表
    version INTEGER DEFAULT 1,                                      -- 当前版本号
    is_active BOOLEAN DEFAULT true,                                 -- 是否启用
    is_public BOOLEAN DEFAULT false,                                -- 是否公开（可被其他组织使用）
    created_at TIMESTAMPTZ DEFAULT NOW(),                           -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW()                            -- 更新时间
);

-- 索引
CREATE INDEX idx_agents_org ON agents(org_id);
CREATE INDEX idx_agents_name ON agents(org_id, name);
CREATE INDEX idx_agents_active ON agents(is_active) WHERE is_active = true;
CREATE INDEX idx_agents_public ON agents(is_public) WHERE is_public = true;

-- 更新触发器
CREATE TRIGGER agents_updated_at
    BEFORE UPDATE ON agents
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE agents IS '智能体定义表';
COMMENT ON COLUMN agents.id IS 'Agent唯一标识';
COMMENT ON COLUMN agents.org_id IS '逻辑外键，关联 organizations.id';
COMMENT ON COLUMN agents.name IS 'Agent名称';
COMMENT ON COLUMN agents.description IS '描述信息';
COMMENT ON COLUMN agents.system_prompt IS '系统提示词';
COMMENT ON COLUMN agents.config IS '模型配置 JSON';
COMMENT ON COLUMN agents.skills IS '关联技能ID列表';
COMMENT ON COLUMN agents.sub_agents IS '子Agent ID列表';
COMMENT ON COLUMN agents.version IS '当前版本号';
COMMENT ON COLUMN agents.is_active IS '是否启用';
COMMENT ON COLUMN agents.is_public IS '是否公开';

-- ============================================================================
-- 4. skills - 技能定义表
-- ============================================================================
CREATE TABLE skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- 技能唯一标识
    org_id UUID,                                                    -- 所属组织（逻辑外键 -> organizations.id，NULL表示系统内置）
    name VARCHAR(100) NOT NULL,                                     -- 技能名称
    description TEXT,                                               -- 技能描述
    trigger_keywords TEXT[] DEFAULT '{}',                           -- 触发关键词
    tools JSONB NOT NULL DEFAULT '[]',                              -- 工具配置列表
    config JSONB DEFAULT '{}',                                      -- 技能配置
    is_builtin BOOLEAN DEFAULT false,                               -- 是否内置技能
    is_active BOOLEAN DEFAULT true,                                 -- 是否启用
    created_by UUID,                                                -- 创建者（逻辑外键 -> users.id）
    created_at TIMESTAMPTZ DEFAULT NOW(),                           -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW()                            -- 更新时间
);

-- 索引
CREATE INDEX idx_skills_org ON skills(org_id);
CREATE INDEX idx_skills_name ON skills(org_id, name);
CREATE INDEX idx_skills_builtin ON skills(is_builtin) WHERE is_builtin = true;
CREATE INDEX idx_skills_active ON skills(is_active) WHERE is_active = true;

-- 唯一约束：同一组织内技能名称唯一（内置技能 org_id 为 NULL 时全局唯一）
CREATE UNIQUE INDEX idx_skills_unique_name ON skills(COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), name);

-- 更新触发器
CREATE TRIGGER skills_updated_at
    BEFORE UPDATE ON skills
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE skills IS '技能定义表，支持多租户隔离';
COMMENT ON COLUMN skills.id IS '技能唯一标识';
COMMENT ON COLUMN skills.org_id IS '逻辑外键，关联 organizations.id，NULL表示系统内置技能';
COMMENT ON COLUMN skills.name IS '技能名称';
COMMENT ON COLUMN skills.description IS '技能描述';
COMMENT ON COLUMN skills.trigger_keywords IS '触发关键词数组';
COMMENT ON COLUMN skills.tools IS '工具配置列表 JSON';
COMMENT ON COLUMN skills.config IS '技能配置 JSON';
COMMENT ON COLUMN skills.is_builtin IS '是否内置技能';
COMMENT ON COLUMN skills.is_active IS '是否启用';
COMMENT ON COLUMN skills.created_by IS '逻辑外键，关联 users.id';

-- ============================================================================
-- 5. agent_skills - Agent与Skill关联表（可选，用于更复杂的关联场景）
-- ============================================================================
CREATE TABLE agent_skills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- 关联记录唯一标识
    agent_id UUID NOT NULL,                                         -- Agent ID（逻辑外键 -> agents.id）
    skill_id UUID NOT NULL,                                         -- Skill ID（逻辑外键 -> skills.id）
    priority INTEGER DEFAULT 0,                                     -- 优先级（数值越大优先级越高）
    config_override JSONB DEFAULT '{}',                             -- 配置覆盖
    is_active BOOLEAN DEFAULT true,                                 -- 是否启用
    created_at TIMESTAMPTZ DEFAULT NOW(),                           -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW()                            -- 更新时间
);

-- 索引
CREATE INDEX idx_agent_skills_agent ON agent_skills(agent_id);
CREATE INDEX idx_agent_skills_skill ON agent_skills(skill_id);
CREATE UNIQUE INDEX idx_agent_skills_unique ON agent_skills(agent_id, skill_id);

-- 更新触发器
CREATE TRIGGER agent_skills_updated_at
    BEFORE UPDATE ON agent_skills
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE agent_skills IS 'Agent与Skill关联表';
COMMENT ON COLUMN agent_skills.id IS '关联记录唯一标识';
COMMENT ON COLUMN agent_skills.agent_id IS '逻辑外键，关联 agents.id';
COMMENT ON COLUMN agent_skills.skill_id IS '逻辑外键，关联 skills.id';
COMMENT ON COLUMN agent_skills.priority IS '优先级，数值越大优先级越高';
COMMENT ON COLUMN agent_skills.config_override IS '配置覆盖 JSON';
COMMENT ON COLUMN agent_skills.is_active IS '是否启用';

-- ============================================================================
-- 6. sessions - 会话表
-- ============================================================================
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- 会话唯一标识
    org_id UUID NOT NULL,                                           -- 所属组织（逻辑外键 -> organizations.id）
    agent_id UUID NOT NULL,                                         -- 关联的Agent（逻辑外键 -> agents.id）
    user_id UUID NOT NULL,                                          -- 用户标识（逻辑外键 -> users.id）
    status VARCHAR(20) DEFAULT 'active'                             -- 会话状态
        CHECK (status IN ('active', 'paused', 'completed', 'failed')),
    title VARCHAR(200),                                             -- 会话标题（自动生成）
    metadata JSONB DEFAULT '{}',                                    -- 元数据
    started_at TIMESTAMPTZ DEFAULT NOW(),                           -- 开始时间
    ended_at TIMESTAMPTZ,                                           -- 结束时间
    created_at TIMESTAMPTZ DEFAULT NOW()                            -- 创建时间
);

-- 索引
CREATE INDEX idx_sessions_org ON sessions(org_id);
CREATE INDEX idx_sessions_agent ON sessions(agent_id);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_org_user ON sessions(org_id, user_id);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_created ON sessions(created_at DESC);

COMMENT ON TABLE sessions IS '会话表，记录用户与Agent的交互会话';
COMMENT ON COLUMN sessions.id IS '会话唯一标识';
COMMENT ON COLUMN sessions.org_id IS '逻辑外键，关联 organizations.id';
COMMENT ON COLUMN sessions.agent_id IS '逻辑外键，关联 agents.id';
COMMENT ON COLUMN sessions.user_id IS '逻辑外键，关联 users.id';
COMMENT ON COLUMN sessions.status IS '会话状态：active/paused/completed/failed';
COMMENT ON COLUMN sessions.title IS '会话标题，可自动生成';
COMMENT ON COLUMN sessions.metadata IS '元数据 JSON';
COMMENT ON COLUMN sessions.started_at IS '会话开始时间';
COMMENT ON COLUMN sessions.ended_at IS '会话结束时间';

-- ============================================================================
-- 7. messages - 消息历史表
-- ============================================================================
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- 消息唯一标识
    session_id UUID NOT NULL,                                       -- 会话ID（逻辑外键 -> sessions.id）
    parent_id UUID,                                                 -- 父消息ID（逻辑外键 -> messages.id，用于分支对话）
    role VARCHAR(20) NOT NULL                                       -- 角色
        CHECK (role IN ('system', 'user', 'assistant', 'tool')),
    content TEXT NOT NULL,                                          -- 消息内容
    tool_calls JSONB,                                               -- 工具调用信息
    tool_call_id VARCHAR(100),                                      -- 工具调用ID（tool角色使用）
    tokens_used INTEGER,                                            -- 消耗的token数
    latency_ms INTEGER,                                             -- 响应延迟（毫秒）
    metadata JSONB DEFAULT '{}',                                    -- 扩展元数据
    created_at TIMESTAMPTZ DEFAULT NOW()                            -- 创建时间
);

-- 索引
CREATE INDEX idx_messages_session ON messages(session_id);
CREATE INDEX idx_messages_created ON messages(session_id, created_at);
CREATE INDEX idx_messages_role ON messages(role);
CREATE INDEX idx_messages_parent ON messages(parent_id) WHERE parent_id IS NOT NULL;

COMMENT ON TABLE messages IS '消息历史表';
COMMENT ON COLUMN messages.id IS '消息唯一标识';
COMMENT ON COLUMN messages.session_id IS '逻辑外键，关联 sessions.id';
COMMENT ON COLUMN messages.parent_id IS '逻辑外键，关联 messages.id，用于分支对话';
COMMENT ON COLUMN messages.role IS '角色：system/user/assistant/tool';
COMMENT ON COLUMN messages.content IS '消息内容';
COMMENT ON COLUMN messages.tool_calls IS '工具调用信息 JSON';
COMMENT ON COLUMN messages.tool_call_id IS '工具调用ID，tool角色使用';
COMMENT ON COLUMN messages.tokens_used IS '消耗的token数';
COMMENT ON COLUMN messages.latency_ms IS '响应延迟（毫秒）';
COMMENT ON COLUMN messages.metadata IS '扩展元数据 JSON';

-- ============================================================================
-- 8. execution_logs - 执行日志表
-- ============================================================================
CREATE TABLE execution_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- 日志唯一标识
    org_id UUID NOT NULL,                                           -- 所属组织（逻辑外键 -> organizations.id）
    agent_id UUID NOT NULL,                                         -- 执行的Agent（逻辑外键 -> agents.id）
    session_id UUID NOT NULL,                                       -- 会话ID（逻辑外键 -> sessions.id）
    request_id VARCHAR(100),                                        -- API请求追踪ID
    step_id VARCHAR(100),                                           -- 计划步骤ID（幂等）
    action_id VARCHAR(100),                                         -- 动作ID（tool/skill）
    state VARCHAR(50) NOT NULL,                                     -- 执行状态
    action_type VARCHAR(50),                                        -- 动作类型
    action_name VARCHAR(100),                                       -- 动作名称（tool/skill名）
    action_input JSONB,                                             -- 输入参数
    action_output JSONB,                                            -- 输出结果
    error_code VARCHAR(50),                                         -- 错误码（如有）
    error_message TEXT,                                             -- 错误信息（如有）
    retry_count INTEGER DEFAULT 0,                                  -- 重试次数
    duration_ms INTEGER,                                            -- 执行耗时（毫秒）
    tokens_input INTEGER DEFAULT 0,                                 -- 输入token数
    tokens_output INTEGER DEFAULT 0,                                -- 输出token数
    model VARCHAR(50),                                              -- 使用的模型
    metadata JSONB DEFAULT '{}',                                    -- 扩展元数据
    created_at TIMESTAMPTZ DEFAULT NOW()                            -- 创建时间
);

-- 索引
CREATE INDEX idx_execution_logs_org ON execution_logs(org_id);
CREATE INDEX idx_execution_logs_agent ON execution_logs(agent_id);
CREATE INDEX idx_execution_logs_session ON execution_logs(session_id);
CREATE INDEX idx_execution_logs_request ON execution_logs(request_id);
CREATE INDEX idx_execution_logs_step ON execution_logs(step_id);
CREATE INDEX idx_execution_logs_state ON execution_logs(state);
CREATE INDEX idx_execution_logs_created ON execution_logs(created_at DESC);
CREATE INDEX idx_execution_logs_error ON execution_logs(error_code) WHERE error_code IS NOT NULL;

COMMENT ON TABLE execution_logs IS 'Agent执行日志表，用于调试、审计和性能分析';
COMMENT ON COLUMN execution_logs.id IS '日志唯一标识';
COMMENT ON COLUMN execution_logs.org_id IS '逻辑外键，关联 organizations.id';
COMMENT ON COLUMN execution_logs.agent_id IS '逻辑外键，关联 agents.id';
COMMENT ON COLUMN execution_logs.session_id IS '逻辑外键，关联 sessions.id';
COMMENT ON COLUMN execution_logs.request_id IS 'API请求追踪ID';
COMMENT ON COLUMN execution_logs.step_id IS '计划步骤ID，用于幂等';
COMMENT ON COLUMN execution_logs.action_id IS '动作ID';
COMMENT ON COLUMN execution_logs.state IS '执行状态：START/PLAN/ACT/OBSERVE/REFLECT/RESPOND';
COMMENT ON COLUMN execution_logs.action_type IS '动作类型：tool_call/skill_call/delegate/llm_call';
COMMENT ON COLUMN execution_logs.action_name IS '动作名称';
COMMENT ON COLUMN execution_logs.action_input IS '输入参数 JSON';
COMMENT ON COLUMN execution_logs.action_output IS '输出结果 JSON';
COMMENT ON COLUMN execution_logs.error_code IS '错误码';
COMMENT ON COLUMN execution_logs.error_message IS '错误信息';
COMMENT ON COLUMN execution_logs.retry_count IS '重试次数';
COMMENT ON COLUMN execution_logs.duration_ms IS '执行耗时（毫秒）';
COMMENT ON COLUMN execution_logs.tokens_input IS '输入token数';
COMMENT ON COLUMN execution_logs.tokens_output IS '输出token数';
COMMENT ON COLUMN execution_logs.model IS '使用的模型';
COMMENT ON COLUMN execution_logs.metadata IS '扩展元数据 JSON';

-- ============================================================================
-- 9. usage_records - 使用量记录表
-- ============================================================================
CREATE TABLE usage_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- 记录唯一标识
    org_id UUID NOT NULL,                                           -- 所属组织（逻辑外键 -> organizations.id）
    user_id UUID,                                                   -- 用户ID（逻辑外键 -> users.id，可选）
    agent_id UUID,                                                  -- Agent ID（逻辑外键 -> agents.id，可选）
    period_start TIMESTAMPTZ NOT NULL,                              -- 统计周期开始
    period_end TIMESTAMPTZ NOT NULL,                                -- 统计周期结束
    period_type VARCHAR(20) NOT NULL                                -- 周期类型
        CHECK (period_type IN ('hourly', 'daily', 'monthly')),
    tokens_input INTEGER DEFAULT 0,                                 -- 输入token总数
    tokens_output INTEGER DEFAULT 0,                                -- 输出token总数
    api_calls INTEGER DEFAULT 0,                                    -- API调用次数
    tool_calls INTEGER DEFAULT 0,                                   -- Tool调用次数
    sessions_count INTEGER DEFAULT 0,                               -- 会话数
    messages_count INTEGER DEFAULT 0,                               -- 消息数
    errors_count INTEGER DEFAULT 0,                                 -- 错误数
    cost_usd DECIMAL(10, 4) DEFAULT 0,                              -- 估算成本（美元）
    metadata JSONB DEFAULT '{}',                                    -- 扩展元数据（按模型细分等）
    created_at TIMESTAMPTZ DEFAULT NOW(),                           -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW()                            -- 更新时间
);

-- 索引
CREATE INDEX idx_usage_records_org ON usage_records(org_id);
CREATE INDEX idx_usage_records_user ON usage_records(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_usage_records_agent ON usage_records(agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX idx_usage_records_period ON usage_records(period_start, period_end);
CREATE INDEX idx_usage_records_period_type ON usage_records(period_type);

-- 唯一约束：防止重复统计
-- 1) 组织级汇总（user_id 与 agent_id 均为 NULL）
CREATE UNIQUE INDEX idx_usage_records_unique_org
    ON usage_records(org_id, period_type, period_start)
    WHERE user_id IS NULL AND agent_id IS NULL;

-- 2) 用户级汇总（user_id 非 NULL，agent_id 为 NULL）
CREATE UNIQUE INDEX idx_usage_records_unique_user
    ON usage_records(org_id, user_id, period_type, period_start)
    WHERE user_id IS NOT NULL AND agent_id IS NULL;

-- 3) Agent 级汇总（agent_id 非 NULL）
CREATE UNIQUE INDEX idx_usage_records_unique_agent
    ON usage_records(org_id, agent_id, period_type, period_start)
    WHERE agent_id IS NOT NULL;

-- 更新触发器
CREATE TRIGGER usage_records_updated_at
    BEFORE UPDATE ON usage_records
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE usage_records IS '使用量统计表，用于配额管理和计费';
COMMENT ON COLUMN usage_records.id IS '记录唯一标识';
COMMENT ON COLUMN usage_records.org_id IS '逻辑外键，关联 organizations.id';
COMMENT ON COLUMN usage_records.user_id IS '逻辑外键，关联 users.id';
COMMENT ON COLUMN usage_records.agent_id IS '逻辑外键，关联 agents.id';
COMMENT ON COLUMN usage_records.period_start IS '统计周期开始时间';
COMMENT ON COLUMN usage_records.period_end IS '统计周期结束时间';
COMMENT ON COLUMN usage_records.period_type IS '周期类型：hourly/daily/monthly';
COMMENT ON COLUMN usage_records.tokens_input IS '输入token总数';
COMMENT ON COLUMN usage_records.tokens_output IS '输出token总数';
COMMENT ON COLUMN usage_records.api_calls IS 'API调用次数';
COMMENT ON COLUMN usage_records.tool_calls IS 'Tool调用次数';
COMMENT ON COLUMN usage_records.sessions_count IS '会话数';
COMMENT ON COLUMN usage_records.messages_count IS '消息数';
COMMENT ON COLUMN usage_records.errors_count IS '错误数';
COMMENT ON COLUMN usage_records.cost_usd IS '估算成本（美元）';
COMMENT ON COLUMN usage_records.metadata IS '扩展元数据 JSON';
