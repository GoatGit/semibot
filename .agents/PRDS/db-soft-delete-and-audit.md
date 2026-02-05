# Semibot: Database Soft Delete and Audit Enhancement

**Priority:** Medium
**Status:** Not Started
**Type:** Enhancement
**Created:** 2026-02-06
**Last Updated:** 2026-02-06

## Overview

为核心表添加软删除机制和审计字段，提升数据追溯能力和安全性。

## Description

当前数据库设计存在以下问题：

1. **缺少软删除**：多数表只有 `is_active` 字段，无法追溯删除时间和操作者
2. **缺少审计字段**：无法追踪谁在何时修改了数据
3. **缺少乐观锁**：高并发场景下可能出现数据覆盖

## Features / Requirements

### 1. 软删除字段

为以下表添加 `deleted_at` 和 `deleted_by` 字段：
- organizations
- users
- agents
- skills
- tools
- mcp_servers
- memory_collections
- memory_documents

### 2. 审计字段

为核心表添加 `created_by` 和 `updated_by` 字段（部分表已有）

### 3. 乐观锁

为频繁更新的表添加 `version` 字段：
- agents
- skills
- tools
- mcp_servers

## Database Schema

```sql
-- ============================================================================
-- 007_add_soft_delete_and_audit.sql
-- ============================================================================

-- 1. 添加软删除字段
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deleted_by UUID;

ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_by UUID;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS deleted_by UUID;

ALTER TABLE skills ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS deleted_by UUID;

ALTER TABLE tools ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE tools ADD COLUMN IF NOT EXISTS deleted_by UUID;

ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS deleted_by UUID;

ALTER TABLE memory_collections ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE memory_collections ADD COLUMN IF NOT EXISTS deleted_by UUID;

ALTER TABLE memory_documents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE memory_documents ADD COLUMN IF NOT EXISTS deleted_by UUID;

-- 2. 添加软删除索引
CREATE INDEX IF NOT EXISTS idx_organizations_deleted ON organizations(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_deleted ON users(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agents_deleted ON agents(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_skills_deleted ON skills(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tools_deleted ON tools(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mcp_servers_deleted ON mcp_servers(deleted_at) WHERE deleted_at IS NOT NULL;

-- 3. 添加审计字段（部分表缺失）
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS created_by UUID;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS updated_by UUID;

ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_by UUID;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS created_by UUID;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS updated_by UUID;

-- 4. 添加乐观锁版本字段（agents 已有 version，其他表需添加）
ALTER TABLE skills ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;
ALTER TABLE tools ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;

-- 5. 添加注释
COMMENT ON COLUMN organizations.deleted_at IS '软删除时间，NULL表示未删除';
COMMENT ON COLUMN organizations.deleted_by IS '执行删除操作的用户ID';
COMMENT ON COLUMN agents.version IS '乐观锁版本号，每次更新自增';
```

## Code Changes

需要更新所有查询，添加 `WHERE deleted_at IS NULL` 条件：

```typescript
// 示例：agent.repository.ts
async findAll(orgId: string): Promise<Agent[]> {
  return this.db
    .selectFrom('agents')
    .where('org_id', '=', orgId)
    .where('deleted_at', 'is', null)  // 添加软删除过滤
    .selectAll()
    .execute();
}

// 软删除实现
async softDelete(id: string, deletedBy: string): Promise<void> {
  await this.db
    .updateTable('agents')
    .set({
      deleted_at: new Date(),
      deleted_by: deletedBy,
      is_active: false
    })
    .where('id', '=', id)
    .execute();
}
```

## Files to Modify

- `database/migrations/007_add_soft_delete_and_audit.sql` (新建)
- `apps/api/src/repositories/*.repository.ts` (所有涉及的 Repository)
- `apps/api/src/services/*.service.ts` (所有涉及的 Service)

## Testing Requirements

### Unit Tests

- [ ] 软删除后查询不返回已删除数据
- [ ] 可以查询包含已删除数据（管理员审计）
- [ ] 乐观锁冲突时抛出异常
- [ ] 审计字段正确记录操作者

## Acceptance Criteria

- [ ] 所有核心表支持软删除
- [ ] 默认查询排除已删除数据
- [ ] 审计字段正确填充
- [ ] 乐观锁机制生效
- [ ] 迁移脚本幂等可重复执行
