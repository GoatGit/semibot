# 任务：统一 Repository 实现

**优先级**: 🟡 P1 - 高优先级
**类型**: 代码质量
**预估工时**: 3-4 小时
**影响范围**: 12 个 Repository 文件

---

## 问题描述

Repository 层实现风格不统一，部分使用类（Class），部分使用函数（Function）。这导致：
1. 代码风格不一致
2. 依赖注入困难
3. 单元测试 Mock 复杂
4. 维护成本高

---

## 当前状态

### 使用函数风格的 Repository
```typescript
// apps/api/src/repositories/agent.repository.ts
export async function findById(id: string): Promise<AgentRow | null> { ... }
export async function findByOrg(orgId: string): Promise<AgentRow[]> { ... }
export async function create(data: CreateAgentData): Promise<AgentRow> { ... }
```

### 使用类风格的 Repository
```typescript
// apps/api/src/repositories/some.repository.ts
export class SomeRepository {
  async findById(id: string): Promise<Row | null> { ... }
}
```

---

## 修复方案

### 推荐：统一使用函数风格

函数风格更适合 TypeScript 项目：
- 更简洁
- Tree-shaking 友好
- 类型推断更好

### 1. 标准 Repository 模板

```typescript
// apps/api/src/repositories/template.repository.ts

import { sql } from '../lib/db'
import { logger } from '../lib/logger'

// ============================================================
// 类型定义
// ============================================================

export interface EntityRow {
  id: string
  org_id: string
  name: string
  is_active: boolean
  version: number
  created_at: Date
  created_by: string
  updated_at: Date
  updated_by: string | null
  deleted_at: Date | null
  deleted_by: string | null
}

export interface CreateEntityData {
  orgId: string
  name: string
  createdBy: string
}

export interface UpdateEntityData {
  name?: string
}

export interface FindOptions {
  orgId: string
  page?: number
  limit?: number
  search?: string
  isActive?: boolean
}

// ============================================================
// 查询函数
// ============================================================

/**
 * 根据 ID 查询（不含租户隔离）
 */
export async function findById(id: string): Promise<EntityRow | null> {
  const result = await sql`
    SELECT * FROM entities
    WHERE id = ${id}
    AND deleted_at IS NULL
  `
  return result[0] || null
}

/**
 * 根据 ID 和组织查询（含租户隔离）
 */
export async function findByIdAndOrg(
  id: string,
  orgId: string
): Promise<EntityRow | null> {
  const result = await sql`
    SELECT * FROM entities
    WHERE id = ${id}
    AND org_id = ${orgId}
    AND deleted_at IS NULL
  `
  return result[0] || null
}

/**
 * 分页查询
 */
export async function findByOrg(options: FindOptions): Promise<{
  data: EntityRow[]
  meta: { total: number; page: number; limit: number; totalPages: number }
}> {
  const { orgId, page = 1, limit = 20, search, isActive } = options

  // 构建查询条件
  const conditions = [
    sql`org_id = ${orgId}`,
    sql`deleted_at IS NULL`
  ]

  if (search) {
    conditions.push(sql`name ILIKE ${'%' + search + '%'}`)
  }

  if (isActive !== undefined) {
    conditions.push(sql`is_active = ${isActive}`)
  }

  // 查询总数
  const countResult = await sql`
    SELECT COUNT(*) as total FROM entities
    WHERE ${sql.join(conditions, sql` AND `)}
  `
  const total = parseInt(countResult[0].total, 10)

  // 分页查询
  const offset = (page - 1) * limit
  const data = await sql`
    SELECT * FROM entities
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `

  return {
    data: data as EntityRow[],
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    }
  }
}

// ============================================================
// 写入函数
// ============================================================

/**
 * 创建实体
 */
export async function create(data: CreateEntityData): Promise<EntityRow> {
  const result = await sql`
    INSERT INTO entities (org_id, name, created_by)
    VALUES (${data.orgId}, ${data.name}, ${data.createdBy})
    RETURNING *
  `

  logger.info('[EntityRepository] 创建成功', {
    id: result[0].id,
    orgId: data.orgId
  })

  return result[0]
}

/**
 * 更新实体（带乐观锁）
 */
export async function update(
  id: string,
  orgId: string,
  data: UpdateEntityData,
  updatedBy: string,
  expectedVersion: number
): Promise<EntityRow | null> {
  const result = await sql`
    UPDATE entities
    SET name = COALESCE(${data.name}, name),
        version = version + 1,
        updated_at = NOW(),
        updated_by = ${updatedBy}
    WHERE id = ${id}
    AND org_id = ${orgId}
    AND version = ${expectedVersion}
    AND deleted_at IS NULL
    RETURNING *
  `

  if (result[0]) {
    logger.info('[EntityRepository] 更新成功', { id, orgId })
  }

  return result[0] || null
}

/**
 * 软删除
 */
export async function softDelete(
  id: string,
  orgId: string,
  deletedBy: string
): Promise<boolean> {
  const result = await sql`
    UPDATE entities
    SET deleted_at = NOW(),
        deleted_by = ${deletedBy}
    WHERE id = ${id}
    AND org_id = ${orgId}
    AND deleted_at IS NULL
  `

  const success = result.count > 0

  if (success) {
    logger.info('[EntityRepository] 软删除成功', { id, orgId, deletedBy })
  }

  return success
}

/**
 * 统计组织内实体数量
 */
export async function countByOrg(orgId: string): Promise<number> {
  const result = await sql`
    SELECT COUNT(*) as count FROM entities
    WHERE org_id = ${orgId}
    AND deleted_at IS NULL
  `
  return parseInt(result[0].count, 10)
}

// ============================================================
// 批量操作
// ============================================================

/**
 * 批量查询（避免 N+1）
 */
export async function findByIds(ids: string[]): Promise<EntityRow[]> {
  if (ids.length === 0) return []

  const result = await sql`
    SELECT * FROM entities
    WHERE id = ANY(${ids})
    AND deleted_at IS NULL
  `

  return result as EntityRow[]
}
```

---

## 修复清单

### Repository 文件（12 个）
- [ ] `agent.repository.ts` - 确认函数风格
- [ ] `session.repository.ts` - 确认函数风格
- [ ] `message.repository.ts` - 确认函数风格
- [ ] `memory.repository.ts` - 确认函数风格
- [ ] `skill.repository.ts` - 确认函数风格
- [ ] `skill-definition.repository.ts` - 确认函数风格
- [ ] `skill-package.repository.ts` - 确认函数风格
- [ ] `skill-install-log.repository.ts` - 确认函数风格
- [ ] `mcp.repository.ts` - 确认函数风格
- [ ] `tool.repository.ts` - 确认函数风格
- [ ] `logs.repository.ts` - 确认函数风格
- [ ] `llm.repository.ts` - 确认函数风格

### 统一实现
- [ ] 所有 Repository 使用相同的函数签名
- [ ] 所有 Repository 包含标准方法集
- [ ] 所有 Repository 添加日志记录
- [ ] 所有 Repository 支持乐观锁

---

## 标准方法集

每个 Repository 应实现以下方法：

| 方法 | 说明 |
|------|------|
| `findById` | 根据 ID 查询 |
| `findByIdAndOrg` | 根据 ID 和组织查询（租户隔离） |
| `findByOrg` | 分页查询 |
| `create` | 创建 |
| `update` | 更新（带乐观锁） |
| `softDelete` | 软删除 |
| `countByOrg` | 统计数量 |
| `findByIds` | 批量查询 |

---

## 完成标准

- [ ] 所有 Repository 使用函数风格
- [ ] 所有 Repository 实现标准方法集
- [ ] 所有 Repository 添加日志记录
- [ ] 所有 Repository 支持乐观锁
- [ ] 代码审查通过

---

## 相关文档

- [Repository 模式](docs/design/ARCHITECTURE.md)
- [数据库规范](.claude/rules/database.md)
