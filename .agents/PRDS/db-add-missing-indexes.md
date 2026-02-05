# Semibot: Database Missing Indexes

**Priority:** Medium
**Status:** Not Started
**Type:** Enhancement
**Created:** 2026-02-06
**Last Updated:** 2026-02-06

## Overview

添加数据库缺失的复合索引，优化查询性能。

## Description

数据库审查发现以下常用查询场景缺少索引：

| 表 | 缺失索引 | 影响场景 |
|---|---------|---------|
| messages | (session_id, role) | 按角色筛选消息 |
| execution_logs | (org_id, created_at DESC) | 组织级日志分页查询 |
| api_key_logs | (api_key_id, created_at DESC) | Key 使用历史分页 |
| memories | (org_id, agent_id, created_at DESC) | 记忆列表查询 |

## Database Schema

```sql
-- ============================================================================
-- 008_add_missing_indexes.sql
-- ============================================================================

-- 1. messages 表
CREATE INDEX IF NOT EXISTS idx_messages_session_role
    ON messages(session_id, role);

-- 2. execution_logs 表
CREATE INDEX IF NOT EXISTS idx_execution_logs_org_created
    ON execution_logs(org_id, created_at DESC);

-- 3. api_key_logs 表
CREATE INDEX IF NOT EXISTS idx_api_key_logs_key_created
    ON api_key_logs(api_key_id, created_at DESC);

-- 4. memories 表
CREATE INDEX IF NOT EXISTS idx_memories_org_agent_created
    ON memories(org_id, agent_id, created_at DESC);

-- 5. sessions 表（补充常用查询索引）
CREATE INDEX IF NOT EXISTS idx_sessions_org_status_created
    ON sessions(org_id, status, created_at DESC);

-- 6. agents 表（按名称搜索）
CREATE INDEX IF NOT EXISTS idx_agents_org_name_lower
    ON agents(org_id, LOWER(name));
```

## Files to Modify

- `database/migrations/008_add_missing_indexes.sql` (新建)

## Testing Requirements

### Performance Tests

- [ ] 验证 messages 按角色查询使用索引
- [ ] 验证 execution_logs 分页查询性能
- [ ] 验证 api_key_logs 历史查询性能
- [ ] 使用 EXPLAIN ANALYZE 确认索引命中

## Acceptance Criteria

- [ ] 所有索引创建成功
- [ ] 常用查询使用正确索引
- [ ] 无明显写入性能下降
