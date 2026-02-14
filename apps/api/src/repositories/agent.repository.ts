/**
 * Agent Repository
 *
 * 处理 Agent 的数据库 CRUD 操作
 */

import { sql } from '../lib/db'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/config'
import { logPaginationLimit } from '../lib/logger'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface AgentRow {
  id: string
  org_id: string
  name: string
  description: string | null
  system_prompt: string
  config: Record<string, unknown>
  skills: string[]
  sub_agents: string[]
  version: number
  is_active: boolean
  is_public: boolean
  created_at: string
  updated_at: string
}

export interface CreateAgentData {
  orgId: string
  name: string
  description?: string
  systemPrompt: string
  config: Record<string, unknown>
  skills?: string[]
  subAgents?: string[]
  isPublic?: boolean
}

export interface UpdateAgentData {
  name?: string
  description?: string
  systemPrompt?: string
  config?: Record<string, unknown>
  skills?: string[]
  subAgents?: string[]
  isActive?: boolean
  isPublic?: boolean
}

export interface ListAgentsParams {
  orgId: string
  page?: number
  limit?: number
  isActive?: boolean
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

// ═══════════════════════════════════════════════════════════════
// Repository 方法
// ═══════════════════════════════════════════════════════════════

/**
 * 创建 Agent
 */
export async function create(data: CreateAgentData): Promise<AgentRow> {
  const result = await sql`
    INSERT INTO agents (
      org_id, name, description, system_prompt, config,
      skills, sub_agents, is_public
    )
    VALUES (
      ${data.orgId},
      ${data.name},
      ${data.description ?? null},
      ${data.systemPrompt},
      ${sql.json(data.config as Parameters<typeof sql.json>[0])},
      ${data.skills ?? []},
      ${data.subAgents ?? []},
      ${data.isPublic ?? false}
    )
    RETURNING *
  `

  return result[0] as unknown as AgentRow
}

/**
 * 根据 ID 获取 Agent
 * @deprecated 使用 findByIdAndOrg 代替，以确保多租户隔离
 */
export async function findById(id: string): Promise<AgentRow | null> {
  const result = await sql`
    SELECT * FROM agents WHERE id = ${id} AND deleted_at IS NULL
  `

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as AgentRow
}

/**
 * 根据 ID 和组织 ID 获取 Agent
 */
export async function findByIdAndOrg(id: string, orgId: string): Promise<AgentRow | null> {
  const result = await sql`
    SELECT * FROM agents WHERE id = ${id} AND org_id = ${orgId} AND deleted_at IS NULL
  `

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as AgentRow
}

/**
 * 列出组织的 Agents（分页）
 */
export async function findByOrg(params: ListAgentsParams): Promise<PaginatedResult<AgentRow>> {
  const { orgId, page = 1, limit = DEFAULT_PAGE_SIZE, isActive, search } = params
  const actualLimit = Math.min(limit, MAX_PAGE_SIZE)
  const offset = (page - 1) * actualLimit

  // 记录分页限制日志
  logPaginationLimit('AgentRepository', limit, actualLimit, MAX_PAGE_SIZE)

  // 根据条件选择不同的查询
  let countResult
  let dataResult

  if (search && isActive !== undefined) {
    const searchPattern = `%${search}%`
    countResult = await sql`
      SELECT COUNT(*) as total FROM agents
      WHERE org_id = ${orgId} AND is_active = ${isActive} AND deleted_at IS NULL
      AND (name ILIKE ${searchPattern} OR description ILIKE ${searchPattern})
    `
    dataResult = await sql`
      SELECT * FROM agents
      WHERE org_id = ${orgId} AND is_active = ${isActive} AND deleted_at IS NULL
      AND (name ILIKE ${searchPattern} OR description ILIKE ${searchPattern})
      ORDER BY updated_at DESC
      LIMIT ${actualLimit} OFFSET ${offset}
    `
  } else if (search) {
    const searchPattern = `%${search}%`
    countResult = await sql`
      SELECT COUNT(*) as total FROM agents
      WHERE org_id = ${orgId} AND deleted_at IS NULL
      AND (name ILIKE ${searchPattern} OR description ILIKE ${searchPattern})
    `
    dataResult = await sql`
      SELECT * FROM agents
      WHERE org_id = ${orgId} AND deleted_at IS NULL
      AND (name ILIKE ${searchPattern} OR description ILIKE ${searchPattern})
      ORDER BY updated_at DESC
      LIMIT ${actualLimit} OFFSET ${offset}
    `
  } else if (isActive !== undefined) {
    countResult = await sql`
      SELECT COUNT(*) as total FROM agents
      WHERE org_id = ${orgId} AND is_active = ${isActive} AND deleted_at IS NULL
    `
    dataResult = await sql`
      SELECT * FROM agents
      WHERE org_id = ${orgId} AND is_active = ${isActive} AND deleted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT ${actualLimit} OFFSET ${offset}
    `
  } else {
    countResult = await sql`
      SELECT COUNT(*) as total FROM agents WHERE org_id = ${orgId} AND deleted_at IS NULL
    `
    dataResult = await sql`
      SELECT * FROM agents
      WHERE org_id = ${orgId} AND deleted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT ${actualLimit} OFFSET ${offset}
    `
  }

  const total = parseInt((countResult[0] as { total: string }).total, 10)
  const data = dataResult as unknown as AgentRow[]

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
 * 统计组织的 Agent 数量
 */
export async function countByOrg(orgId: string): Promise<number> {
  const result = await sql`
    SELECT COUNT(*) as count FROM agents WHERE org_id = ${orgId} AND deleted_at IS NULL
  `

  return parseInt((result[0] as { count: string }).count, 10)
}

/**
 * 更新 Agent（带审计字段和乐观锁）
 * @param id Agent ID
 * @param orgId 组织 ID
 * @param data 更新数据
 * @param updatedBy 更新者用户 ID
 * @param expectedVersion 期望的版本号（用于乐观锁检查，可选）
 */
export async function update(
  id: string,
  orgId: string,
  data: UpdateAgentData,
  updatedBy?: string,
  expectedVersion?: number
): Promise<AgentRow | null> {
  // 获取当前 Agent
  const agent = await findByIdAndOrg(id, orgId)
  if (!agent) return null

  // 如果提供了期望版本，检查版本冲突
  if (expectedVersion !== undefined && agent.version !== expectedVersion) {
    return null // 版本冲突
  }

  const result = await sql`
    UPDATE agents
    SET name = ${data.name ?? agent.name},
        description = ${data.description ?? agent.description},
        system_prompt = ${data.systemPrompt ?? agent.system_prompt},
        config = ${sql.json((data.config ?? agent.config) as Parameters<typeof sql.json>[0])},
        skills = ${data.skills ?? agent.skills},
        sub_agents = ${data.subAgents ?? agent.sub_agents},
        is_active = ${data.isActive ?? agent.is_active},
        is_public = ${data.isPublic ?? agent.is_public},
        version = version + 1,
        updated_at = NOW(),
        updated_by = ${updatedBy ?? null}
    WHERE id = ${id} AND org_id = ${orgId} AND deleted_at IS NULL
    RETURNING *
  `

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as AgentRow
}

/**
 * 查询同组织下除当前 Agent 外的所有活跃 Agent（用于 SubAgent 委派候选池）
 */
export async function findOtherActiveByOrg(
  orgId: string,
  excludeAgentId: string,
  limit: number = 20
): Promise<AgentRow[]> {
  const result = await sql`
    SELECT * FROM agents
    WHERE org_id = ${orgId}
      AND id != ${excludeAgentId}
      AND is_active = true
      AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT ${limit}
  `

  return result as unknown as AgentRow[]
}

/**
 * 软删除 Agent
 */
export async function softDelete(id: string, orgId: string, deletedBy?: string): Promise<boolean> {
  const result = await sql`
    UPDATE agents
    SET deleted_at = NOW(),
        deleted_by = ${deletedBy ?? null},
        is_active = false,
        updated_at = NOW()
    WHERE id = ${id} AND org_id = ${orgId} AND deleted_at IS NULL
    RETURNING id
  `

  return result.length > 0
}
