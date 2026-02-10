/**
 * Skill Repository
 *
 * 处理 Skill 的数据库 CRUD 操作
 */

import { sql } from '../lib/db'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/config'
import { logPaginationLimit, createLogger } from '../lib/logger'

const skillLogger = createLogger('skill-repository')

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface SkillRow {
  id: string
  org_id: string | null
  name: string
  description: string | null
  trigger_keywords: string[]
  tools: unknown[]
  config: Record<string, unknown>
  is_builtin: boolean
  is_active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
  deleted_at?: string | null
  deleted_by?: string | null
}

export interface CreateSkillData {
  orgId: string | null
  name: string
  description?: string
  triggerKeywords?: string[]
  tools?: unknown[]
  config?: Record<string, unknown>
  isBuiltin?: boolean
  createdBy?: string
}

export interface UpdateSkillData {
  name?: string
  description?: string
  triggerKeywords?: string[]
  tools?: unknown[]
  config?: Record<string, unknown>
  isActive?: boolean
}

export interface ListSkillsParams {
  orgId?: string | null
  includeBuiltin?: boolean
  page?: number
  limit?: number
  search?: string
}

export interface PaginatedResult<T> {
  data: T[]
  meta: {
    total: number
    page: number
    limit: number
    totalPages: number
  }
}

let skillsDeletedAtColumnExists: boolean | null = null

async function hasSkillsDeletedAtColumn(): Promise<boolean> {
  if (skillsDeletedAtColumnExists !== null) {
    return skillsDeletedAtColumnExists
  }

  const result = await sql`
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'skills'
      AND column_name = 'deleted_at'
    LIMIT 1
  `

  skillsDeletedAtColumnExists = result.length > 0
  return skillsDeletedAtColumnExists
}

// ═══════════════════════════════════════════════════════════════
// Repository 方法
// ═══════════════════════════════════════════════════════════════

/**
 * 创建 Skill
 */
export async function create(data: CreateSkillData): Promise<SkillRow> {
  const result = await sql`
    INSERT INTO skills (
      org_id, name, description, trigger_keywords,
      tools, config, is_builtin, created_by
    )
    VALUES (
      ${data.orgId},
      ${data.name},
      ${data.description ?? null},
      ${data.triggerKeywords ?? []},
      ${sql.json((data.tools ?? []) as Parameters<typeof sql.json>[0])},
      ${sql.json((data.config ?? {}) as Parameters<typeof sql.json>[0])},
      ${data.isBuiltin ?? false},
      ${data.createdBy ?? null}
    )
    RETURNING *
  `

  return result[0] as unknown as SkillRow
}

/**
 * 根据 ID 获取 Skill
 * @deprecated 使用 findByIdAndOrg 代替，以确保多租户隔离
 * @internal 仅供内部使用
 */
export async function findById(id: string): Promise<SkillRow | null> {
  skillLogger.warn('[Security] findById 被调用，请确认是否需要租户隔离', { id })

  const useDeletedAt = await hasSkillsDeletedAtColumn()
  const result = useDeletedAt
    ? await sql`SELECT * FROM skills WHERE id = ${id} AND deleted_at IS NULL`
    : await sql`SELECT * FROM skills WHERE id = ${id}`

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as SkillRow
}

/**
 * 根据 ID 和组织 ID 获取 Skill（支持内置 Skill 跨组织访问）
 */
export async function findByIdAndOrg(id: string, orgId: string): Promise<SkillRow | null> {
  const useDeletedAt = await hasSkillsDeletedAtColumn()
  const result = useDeletedAt
    ? await sql`
        SELECT * FROM skills
        WHERE id = ${id}
        AND (org_id = ${orgId} OR is_builtin = true)
        AND deleted_at IS NULL
      `
    : await sql`
        SELECT * FROM skills
        WHERE id = ${id}
        AND (org_id = ${orgId} OR is_builtin = true)
      `

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as SkillRow
}

/**
 * 列出 Skills（分页）
 */
export async function findAll(params: ListSkillsParams): Promise<PaginatedResult<SkillRow>> {
  const { orgId, includeBuiltin = true, page = 1, limit = DEFAULT_PAGE_SIZE, search } = params
  const actualLimit = Math.min(limit, MAX_PAGE_SIZE)
  const offset = (page - 1) * actualLimit

  // 记录分页限制日志
  logPaginationLimit('SkillRepository', limit, actualLimit, MAX_PAGE_SIZE)

  // 构建 WHERE 条件
  const useDeletedAt = await hasSkillsDeletedAtColumn()
  let whereClause = useDeletedAt ? sql`deleted_at IS NULL` : sql`1 = 1`

  if (orgId !== undefined) {
    if (includeBuiltin) {
      whereClause = sql`${whereClause} AND (org_id = ${orgId} OR is_builtin = true)`
    } else {
      whereClause = sql`${whereClause} AND org_id = ${orgId}`
    }
  }

  if (search) {
    const searchPattern = `%${search}%`
    whereClause = sql`${whereClause} AND (name ILIKE ${searchPattern} OR description ILIKE ${searchPattern})`
  }

  // 获取总数
  const countResult = await sql`
    SELECT COUNT(*) as total FROM skills WHERE ${whereClause}
  `
  const total = parseInt((countResult[0] as { total: string }).total, 10)

  // 获取分页数据
  const dataResult = await sql`
    SELECT * FROM skills
    WHERE ${whereClause}
    ORDER BY is_builtin DESC, name ASC
    LIMIT ${actualLimit} OFFSET ${offset}
  `

  const data = dataResult as unknown as SkillRow[]

  return {
    data,
    meta: {
      total,
      page,
      limit: actualLimit,
      totalPages: Math.ceil(total / actualLimit),
    },
  }
}

/**
 * 更新 Skill（带审计字段和租户隔离）
 * @param id Skill ID
 * @param orgId 组织 ID
 * @param data 更新数据
 * @param updatedBy 更新者用户 ID
 */
export async function updateByOrg(
  id: string,
  orgId: string,
  data: UpdateSkillData,
  updatedBy?: string
): Promise<SkillRow | null> {
  const skill = await findByIdAndOrg(id, orgId)
  if (!skill) return null

  // 内置 Skill 不允许修改
  if (skill.is_builtin) {
    skillLogger.warn('[Security] 尝试修改内置 Skill', { id, orgId })
    return null
  }

  const result = await sql`
    UPDATE skills
    SET name = ${data.name ?? skill.name},
        description = ${data.description ?? skill.description},
        trigger_keywords = ${data.triggerKeywords ?? skill.trigger_keywords},
        tools = ${sql.json((data.tools ?? skill.tools) as Parameters<typeof sql.json>[0])},
        config = ${sql.json((data.config ?? skill.config) as Parameters<typeof sql.json>[0])},
        is_active = ${data.isActive ?? skill.is_active},
        updated_at = NOW(),
        updated_by = ${updatedBy ?? null}
    WHERE id = ${id} AND org_id = ${orgId}
    RETURNING *
  `

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as SkillRow
}

/**
 * 更新 Skill（带审计字段）
 * @deprecated 使用 updateByOrg 代替，以确保多租户隔离
 * @param id Skill ID
 * @param data 更新数据
 * @param updatedBy 更新者用户 ID
 */
export async function update(id: string, data: UpdateSkillData, updatedBy?: string): Promise<SkillRow | null> {
  skillLogger.warn('[Security] update 被调用，请使用 updateByOrg 确保租户隔离', { id })

  const skill = await findById(id)
  if (!skill) return null

  const result = await sql`
    UPDATE skills
    SET name = ${data.name ?? skill.name},
        description = ${data.description ?? skill.description},
        trigger_keywords = ${data.triggerKeywords ?? skill.trigger_keywords},
        tools = ${sql.json((data.tools ?? skill.tools) as Parameters<typeof sql.json>[0])},
        config = ${sql.json((data.config ?? skill.config) as Parameters<typeof sql.json>[0])},
        is_active = ${data.isActive ?? skill.is_active},
        updated_at = NOW(),
        updated_by = ${updatedBy ?? null}
    WHERE id = ${id}
    RETURNING *
  `

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as SkillRow
}

/**
 * 软删除 Skill（带审计字段和租户隔离）
 * @param id Skill ID
 * @param orgId 组织 ID
 * @param deletedBy 删除者用户 ID
 */
export async function softDeleteByOrg(id: string, orgId: string, deletedBy?: string): Promise<boolean> {
  const skill = await findByIdAndOrg(id, orgId)
  if (!skill) return false

  // 内置 Skill 不允许删除
  if (skill.is_builtin) {
    skillLogger.warn('[Security] 尝试删除内置 Skill', { id, orgId })
    return false
  }

  const useDeletedAt = await hasSkillsDeletedAtColumn()
  const result = useDeletedAt
    ? await sql`
      UPDATE skills
      SET deleted_at = NOW(),
          deleted_by = ${deletedBy ?? null},
          is_active = false,
          updated_at = NOW(),
          updated_by = ${deletedBy ?? null}
      WHERE id = ${id} AND org_id = ${orgId} AND deleted_at IS NULL
      RETURNING id
    `
    : await sql`
      DELETE FROM skills
      WHERE id = ${id} AND org_id = ${orgId}
      RETURNING id
    `

  return result.length > 0
}

/**
 * 软删除 Skill（带审计字段）
 * @deprecated 使用 softDeleteByOrg 代替，以确保多租户隔离
 * @param id Skill ID
 * @param deletedBy 删除者用户 ID
 */
export async function softDelete(id: string, deletedBy?: string): Promise<boolean> {
  skillLogger.warn('[Security] softDelete 被调用，请使用 softDeleteByOrg 确保租户隔离', { id })

  const useDeletedAt = await hasSkillsDeletedAtColumn()
  const result = useDeletedAt
    ? await sql`
      UPDATE skills
      SET deleted_at = NOW(),
          deleted_by = ${deletedBy ?? null},
          is_active = false,
          updated_at = NOW(),
          updated_by = ${deletedBy ?? null}
      WHERE id = ${id} AND deleted_at IS NULL
      RETURNING id
    `
    : await sql`
      DELETE FROM skills
      WHERE id = ${id}
      RETURNING id
    `

  return result.length > 0
}

/**
 * 批量查询 Skill（避免 N+1 问题）
 * @param ids Skill ID 数组
 * @returns Skill 数组
 */
export async function findByIds(ids: string[]): Promise<SkillRow[]> {
  if (ids.length === 0) {
    return []
  }

  const useDeletedAt = await hasSkillsDeletedAtColumn()
  const result = useDeletedAt
    ? await sql`
        SELECT * FROM skills
        WHERE id = ANY(${ids})
        AND deleted_at IS NULL
      `
    : await sql`
        SELECT * FROM skills
        WHERE id = ANY(${ids})
      `

  return result as unknown as SkillRow[]
}

/**
 * 批量查询指定组织的活跃 Skill（包括内置）
 * @param ids Skill ID 数组
 * @param orgId 组织 ID
 * @returns 活跃的 Skill 数组
 */
export async function findActiveByIdsAndOrg(
  ids: string[],
  orgId: string
): Promise<SkillRow[]> {
  if (ids.length === 0) {
    return []
  }

  const useDeletedAt = await hasSkillsDeletedAtColumn()
  const result = useDeletedAt
    ? await sql`
        SELECT * FROM skills
        WHERE id = ANY(${ids})
        AND is_active = true
        AND (org_id = ${orgId} OR is_builtin = true)
        AND deleted_at IS NULL
      `
    : await sql`
        SELECT * FROM skills
        WHERE id = ANY(${ids})
        AND is_active = true
        AND (org_id = ${orgId} OR is_builtin = true)
      `

  return result as unknown as SkillRow[]
}
