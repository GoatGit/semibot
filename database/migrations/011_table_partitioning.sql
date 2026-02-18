-- ============================================================================
-- 011_table_partitioning.sql
-- 大表分区策略设计
-- ============================================================================

-- 注意：此迁移为分区表结构准备，不影响现有数据
-- 分区迁移需要在低峰期执行，建议先在测试环境验证

-- ============================================================================
-- 1. 自动分区管理函数
-- ============================================================================

-- 创建月度分区函数
CREATE OR REPLACE FUNCTION create_monthly_partition(
    p_table_name TEXT,
    p_year INTEGER,
    p_month INTEGER
) RETURNS TEXT AS $$
DECLARE
    v_partition_name TEXT;
    v_start_date DATE;
    v_end_date DATE;
BEGIN
    v_partition_name := p_table_name || '_y' || p_year || 'm' || LPAD(p_month::TEXT, 2, '0');
    v_start_date := make_date(p_year, p_month, 1);
    v_end_date := v_start_date + INTERVAL '1 month';

    -- 检查分区是否已存在
    IF EXISTS (
        SELECT 1 FROM pg_tables
        WHERE tablename = v_partition_name AND schemaname = 'public'
    ) THEN
        RAISE NOTICE '[create_monthly_partition] 分区已存在: %', v_partition_name;
        RETURN v_partition_name;
    END IF;

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        v_partition_name, p_table_name, v_start_date, v_end_date
    );

    RAISE NOTICE '[create_monthly_partition] 创建分区成功: %', v_partition_name;
    RETURN v_partition_name;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION create_monthly_partition(TEXT, INTEGER, INTEGER)
    IS '创建指定表的月度分区';

-- 批量创建未来 N 个月分区
CREATE OR REPLACE FUNCTION create_future_partitions(
    p_table_name TEXT,
    p_months_ahead INTEGER DEFAULT 3
) RETURNS INTEGER AS $$
DECLARE
    v_current_date DATE := CURRENT_DATE;
    v_target_date DATE;
    v_count INTEGER := 0;
    i INTEGER;
BEGIN
    FOR i IN 0..p_months_ahead LOOP
        v_target_date := v_current_date + (i || ' months')::INTERVAL;
        PERFORM create_monthly_partition(
            p_table_name,
            EXTRACT(YEAR FROM v_target_date)::INTEGER,
            EXTRACT(MONTH FROM v_target_date)::INTEGER
        );
        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION create_future_partitions(TEXT, INTEGER)
    IS '批量创建未来 N 个月的分区';

-- 删除旧分区（归档后）
CREATE OR REPLACE FUNCTION drop_old_partition(
    p_table_name TEXT,
    p_year INTEGER,
    p_month INTEGER
) RETURNS BOOLEAN AS $$
DECLARE
    v_partition_name TEXT;
BEGIN
    v_partition_name := p_table_name || '_y' || p_year || 'm' || LPAD(p_month::TEXT, 2, '0');

    IF NOT EXISTS (
        SELECT 1 FROM pg_tables
        WHERE tablename = v_partition_name AND schemaname = 'public'
    ) THEN
        RAISE NOTICE '[drop_old_partition] 分区不存在: %', v_partition_name;
        RETURN FALSE;
    END IF;

    EXECUTE format('DROP TABLE IF EXISTS %I', v_partition_name);
    RAISE NOTICE '[drop_old_partition] 删除分区成功: %', v_partition_name;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION drop_old_partition(TEXT, INTEGER, INTEGER)
    IS '删除指定的旧分区';

-- ============================================================================
-- 2. 分区表结构定义（仅定义，不迁移数据）
-- ============================================================================

-- 注意：以下为分区表结构定义，实际迁移需要：
-- 1. 创建分区表
-- 2. 迁移历史数据
-- 3. 重命名表
-- 4. 更新应用配置

-- messages_partitioned 分区表结构
-- CREATE TABLE messages_partitioned (
--     id UUID NOT NULL DEFAULT gen_random_uuid(),
--     session_id UUID NOT NULL,
--     parent_id UUID,
--     role VARCHAR(20) NOT NULL,
--     content TEXT NOT NULL,
--     tool_calls JSONB,
--     tool_call_id VARCHAR(100),
--     tokens_used INTEGER,
--     latency_ms INTEGER,
--     metadata JSONB DEFAULT '{}',
--     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
--     PRIMARY KEY (id, created_at)
-- ) PARTITION BY RANGE (created_at);

-- execution_logs_partitioned 分区表结构
-- CREATE TABLE execution_logs_partitioned (
--     id UUID NOT NULL DEFAULT gen_random_uuid(),
--     org_id UUID NOT NULL,
--     agent_id UUID NOT NULL,
--     session_id UUID NOT NULL,
--     request_id VARCHAR(100),
--     step_id VARCHAR(100),
--     action_id VARCHAR(100),
--     state VARCHAR(50) NOT NULL,
--     action_type VARCHAR(50),
--     action_name VARCHAR(100),
--     action_input JSONB,
--     action_output JSONB,
--     error_code VARCHAR(50),
--     error_message TEXT,
--     retry_count INTEGER DEFAULT 0,
--     duration_ms INTEGER,
--     tokens_input INTEGER DEFAULT 0,
--     tokens_output INTEGER DEFAULT 0,
--     model VARCHAR(50),
--     metadata JSONB DEFAULT '{}',
--     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
--     PRIMARY KEY (id, created_at)
-- ) PARTITION BY RANGE (created_at);

-- api_key_logs_partitioned 分区表结构
-- CREATE TABLE api_key_logs_partitioned (
--     id UUID NOT NULL DEFAULT gen_random_uuid(),
--     api_key_id UUID NOT NULL,
--     org_id UUID NOT NULL,
--     endpoint VARCHAR(200) NOT NULL,
--     method VARCHAR(10) NOT NULL,
--     status_code INTEGER,
--     ip_address VARCHAR(45),
--     user_agent TEXT,
--     request_id VARCHAR(100),
--     latency_ms INTEGER,
--     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
--     PRIMARY KEY (id, created_at)
-- ) PARTITION BY RANGE (created_at);

-- ============================================================================
-- 3. 分区维护视图
-- ============================================================================

-- 查看所有分区表及其大小
CREATE OR REPLACE VIEW v_partition_stats AS
SELECT
    parent.relname AS parent_table,
    child.relname AS partition_name,
    pg_size_pretty(pg_relation_size(child.oid)) AS partition_size,
    pg_relation_size(child.oid) AS partition_size_bytes
FROM pg_inherits
JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
JOIN pg_class child ON pg_inherits.inhrelid = child.oid
WHERE parent.relname IN ('messages_partitioned', 'execution_logs_partitioned', 'api_key_logs_partitioned')
ORDER BY parent.relname, child.relname;

COMMENT ON VIEW v_partition_stats IS '分区表大小统计视图';

-- ============================================================================
-- 4. 验证函数创建成功
-- ============================================================================
-- 可通过以下查询验证：
-- SELECT proname FROM pg_proc WHERE proname LIKE '%partition%';
-- SELECT * FROM v_partition_stats;
