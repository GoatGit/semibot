-- 015_evolution_logs.sql
-- 进化日志表 — 记录进化流程每个阶段的执行情况

CREATE TABLE IF NOT EXISTS evolution_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    agent_id UUID NOT NULL,
    session_id UUID NOT NULL,

    -- 进化过程
    stage VARCHAR(20) NOT NULL
        CHECK (stage IN ('extract', 'validate', 'register', 'index')),
    status VARCHAR(20) NOT NULL
        CHECK (status IN ('started', 'completed', 'failed', 'skipped')),

    -- 结果
    evolved_skill_id UUID,                   -- 产生的技能ID（如有）
    input_data JSONB,                        -- 输入数据
    output_data JSONB,                       -- 输出数据
    error_message TEXT,                      -- 错误信息

    -- 指标
    duration_ms INTEGER,                     -- 耗时（毫秒）
    tokens_used INTEGER DEFAULT 0,           -- Token 消耗

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_evolution_logs_org ON evolution_logs(org_id);
CREATE INDEX IF NOT EXISTS idx_evolution_logs_agent ON evolution_logs(agent_id);
CREATE INDEX IF NOT EXISTS idx_evolution_logs_session ON evolution_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_evolution_logs_stage ON evolution_logs(stage);
CREATE INDEX IF NOT EXISTS idx_evolution_logs_skill ON evolution_logs(evolved_skill_id);
CREATE INDEX IF NOT EXISTS idx_evolution_logs_created ON evolution_logs(created_at DESC);

COMMENT ON TABLE evolution_logs IS '进化日志 — 记录 EXTRACT/VALIDATE/REGISTER/INDEX 各阶段执行情况';
