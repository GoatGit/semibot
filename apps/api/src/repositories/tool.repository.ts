/**
 * Tool Repository
 *
 * 处理 Tool 的数据库 CRUD 操作
 */

import { sql } from '../lib/db'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/config'
import { logPaginationLimit, createLogger } from '../lib/logger'

const toolLogger = createLogger('tool-repository')

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface ToolRow {
  id: string
  org_id: string | null
  name: string
  description: string | null
  type: string
  schema: Record<string, unknown>
  config: Record<string, unknown>
  is_builtin: boolean
  is_active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface CreateToolData {
  orgId: string | null
  name: string
  description?: string
  type: string
  schema?: Record<string, unknown>
  config?: Record<string, unknown>
  isBuiltin?: boolean
  createdBy?: string
}

export interface UpdateToolData {
  name?: string
  description?: string
  type?: string
  schema?: Record<string, unknown>
  config?: Record<string, unknown>
  isActive?: boolean
}

export interface ListToolsParams {
  orgId?: string | null
  includeBuiltin?: boolean
  page?: number
  limit?: number
  search?: string
  type?: string
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

// ═══════════════════════════════════════════════════════════════
// Repository 方法
// ═══════════════════════════════════════════════════════════════

/**
 * 创建 Tool
 */
export async function create(data: CreateToolData): Promise<ToolRow> {
  const result = await sql`
    INSERT INTO tools (
      org_id, name, description, type,
      schema, config, is_builtin, created_by
    )
    VALUES (
      ${data.orgId},
      ${data.name},
      ${data.description ?? null},
      ${data.type},
      ${JSON.stringify(data.schema ?? {})},
      ${JSON.stringify(data.config ?? {})},
      ${data.isBuiltin ?? false},
      ${data.createdBy ?? null}
    )
    RETURNING *
  `

  return result[0] as unknown as ToolRow
}

/**
 * 根据 ID 获取 Tool
 * @deprecated 使用 findByIdAndOrg 代替，以确保多租户隔离
 * @internal 仅供内部使用
 */
export async function findById(id: string): Promise<ToolRow | null> {
  toolLogger.warn('[Security] findById 被调用，请确认是否需要租户隔离', { id })

  const result = await sql`
    SELECT * FROM tools WHERE id = ${id} AND deleted_at IS NULL
  `

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as ToolRow
}

/**
 * 根据 ID 和组织 ID 获取 Tool（支持内置工具跨组织访问）
 */
export async function findByIdAndOrg(id: string, orgId: string): Promise<ToolRow | null> {
  const result = await sql`
    SELECT * FROM tools
    WHERE id = ${id}
    AND (org_id = ${orgId} OR is_builtin = true)
    AND deleted_at IS NULL
  `

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as ToolRow
}

/**
 * 列出 Tools（分页）
 */
export async function findAll(params: ListToolsParams): Promise<PaginatedResult<ToolRow>> {
  const { orgId, includeBuiltin = true, page = 1, limit = DEFAULT_PAGE_SIZE, search, type } = params
  const actualLimit = Math.min(limit, MAX_PAGE_SIZE)
  const offset = (page - 1) * actualLimit

  // 记录分页限制日志
  logPaginationLimit('ToolRepository', limit, actualLimit, MAX_PAGE_SIZE)

  // 构建 WHERE 条件
  let whereClause = sql`is_active = true`

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

  if (type) {
    whereClause = sql`${whereClause} AND type = ${type}`
  }

  // 获取总数
  const countResult = await sql`
    SELECT COUNT(*) as total FROM tools WHERE ${whereClause}
  `
  const total = parseInt((countResult[0] as { total: string }).total, 10)

  // 获取分页数据
  const dataResult = await sql`
    SELECT * FROM tools
    WHERE ${whereClause}
    ORDER BY is_builtin DESC, name ASC
    LIMIT ${actualLimit} OFFSET ${offset}
  `

  const data = dataResult as unknown as ToolRow[]

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
 * 更新 Tool（带审计字段和租户隔离）
 * @param id Tool ID
 * @param orgId 组织 ID
 * @param data 更新数据
 * @param updatedBy 更新者用户 ID
 */
export async function updateByOrg(
  id: string,
  orgId: string,
  data: UpdateToolData,
  updatedBy?: string
): Promise<ToolRow | null> {
  const tool = await findByIdAndOrg(id, orgId)
  if (!tool) return null

  // 内置工具不允许修改
  if (tool.is_builtin) {
    toolLogger.warn('[Security] 尝试修改内置 Tool', { id, orgId })
    return null
  }

  const result = await sql`
    UPDATE tools
    SET name = ${data.name ?? tool.name},
        description = ${data.description ?? tool.description},
        type = ${data.type ?? tool.type},
        schema = ${JSON.stringify(data.schema ?? tool.schema)},
        config = ${JSON.stringify(data.config ?? tool.config)},
        is_active = ${data.isActive ?? tool.is_active},
        updated_at = NOW(),
        updated_by = ${updatedBy ?? null}
    WHERE id = ${id} AND org_id = ${orgId} AND deleted_at IS NULL
    RETURNING *
  `

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as ToolRow
}

/**
 * 更新 Tool（带审计字段）
 * @deprecated 使用 updateByOrg 代替，以确保多租户隔离
 * @param id Tool ID
 * @param data 更新数据
 * @param updatedBy 更新者用户 ID
 */
export async function update(id: string, data: UpdateToolData, updatedBy?: string): Promise<ToolRow | null> {
  toolLogger.warn('[Security] update 被调用，请使用 updateByOrg 确保租户隔离', { id })

  const tool = await findById(id)
  if (!tool) return null

  const result = await sql`
    UPDATE tools
    SET name = ${data.name ?? tool.name},
        description = ${data.description ?? tool.description},
        type = ${data.type ?? tool.type},
        schema = ${JSON.stringify(data.schema ?? tool.schema)},
        config = ${JSON.stringify(data.config ?? tool.config)},
        is_active = ${data.isActive ?? tool.is_active},
        updated_at = NOW(),
        updated_by = ${updatedBy ?? null}
    WHERE id = ${id}
    RETURNING *
  `

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as ToolRow
}

/**
 * 软删除 Tool（带审计字段和租户隔离）
 * @param id Tool ID
 * @param orgId 组织 ID
 * @param deletedBy 删除者用户 ID
 */
export async function softDeleteByOrg(id: string, orgId: string, deletedBy?: string): Promise<boolean> {
  const tool = await findByIdAndOrg(id, orgId)
  if (!tool) return false

  // 内置工具不允许删除
  if (tool.is_builtin) {
    toolLogger.warn('[Security] 尝试删除内置 Tool', { id, orgId })
    return false
  }

  const result = await sql`
    UPDATE tools
    SET deleted_at = NOW(),
        deleted_by = ${deletedBy ?? null},
        is_active = false,
        updated_at = NOW(),
        updated_by = ${deletedBy ?? null}
    WHERE id = ${id} AND org_id = ${orgId} AND deleted_at IS NULL
    RETURNING id
  `

  return result.length > 0
}

/**
 * 软删除 Tool（带审计字段）
 * @deprecated 使用 softDeleteByOrg 代替，以确保多租户隔离
 * @param id Tool ID
 * @param deletedBy 删除者用户 ID
 */
export async function softDelete(id: string, deletedBy?: string): Promise<boolean> {
  const result = await sql`
    UPDATE tools
    SET deleted_at = NOW(),
        deleted_by = ${deletedBy ?? null},
        is_active = false,
        updated_at = NOW(),
        updated_by = ${deletedBy ?? null}
    WHERE id = ${id} AND deleted_at IS NULL
    RETURNING id
  `

  return result.length > 0
}
