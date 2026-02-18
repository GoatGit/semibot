-- ============================================================================
-- 009_add_missing_indexes.sql
-- 添加数据库缺失索引
-- ============================================================================

-- ============================================================================
-- 1. messages 表
-- ============================================================================

-- 按角色筛选消息（用于提取 assistant/user 消息）
CREATE INDEX IF NOT EXISTS idx_messages_session_role
    ON messages(session_id, role);

-- ============================================================================
-- 2. execution_logs 表
-- ============================================================================

-- 组织级日志分页查询
CREATE INDEX IF NOT EXISTS idx_execution_logs_org_created
    ON execution_logs(org_id, created_at DESC);

-- 按 Agent 和时间查询
CREATE INDEX IF NOT EXISTS idx_execution_logs_agent_created
    ON execution_logs(agent_id, created_at DESC);

-- ============================================================================
-- 3. api_key_logs 表
-- ============================================================================

-- Key 使用历史分页查询
CREATE INDEX IF NOT EXISTS idx_api_key_logs_key_created
    ON api_key_logs(api_key_id, created_at DESC);

-- ============================================================================
-- 4. memories 表
-- ============================================================================

-- 记忆列表查询（按组织、Agent、时间）
CREATE INDEX IF NOT EXISTS idx_memories_org_agent_created
    ON memories(org_id, agent_id, created_at DESC);

-- ============================================================================
-- 5. sessions 表
-- ============================================================================

-- 组织级会话列表（按状态和时间过滤）
CREATE INDEX IF NOT EXISTS idx_sessions_org_status_created
    ON sessions(org_id, status, created_at DESC);

-- 用户会话列表
CREATE INDEX IF NOT EXISTS idx_sessions_user_created
    ON sessions(user_id, created_at DESC);

-- ============================================================================
-- 6. agents 表
-- ============================================================================

-- 按名称模糊搜索（大小写不敏感）
CREATE INDEX IF NOT EXISTS idx_agents_org_name_lower
    ON agents(org_id, LOWER(name));

-- ============================================================================
-- 7. skills 表
-- ============================================================================

-- 按名称模糊搜索
CREATE INDEX IF NOT EXISTS idx_skills_org_name_lower
    ON skills(COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), LOWER(name));

-- ============================================================================
-- 8. usage_records 表
-- ============================================================================

-- 组织使用量统计查询（按周期类型和时间）
CREATE INDEX IF NOT EXISTS idx_usage_records_org_period_created
    ON usage_records(org_id, period_type, period_start DESC);

-- ============================================================================
-- 9. memory_chunks 表
-- ============================================================================

-- 按组织和集合查询
CREATE INDEX IF NOT EXISTS idx_memory_chunks_org_collection
    ON memory_chunks(org_id, collection_id);

-- ============================================================================
-- 10. 验证索引创建成功
-- ============================================================================
-- 可通过以下查询验证：
-- SELECT indexname, indexdef FROM pg_indexes
-- WHERE tablename IN ('messages', 'execution_logs', 'api_key_logs', 'memories', 'sessions');
