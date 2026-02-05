/**
 * Agent Repository
 *
 * 处理 Agent 的数据库 CRUD 操作
 */

import { sql } from '../lib/db'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/config'

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
      ${JSON.stringify(data.config)},
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
 */
export async function findById(id: string): Promise<AgentRow | null> {
  const result = await sql`
    SELECT * FROM agents WHERE id = ${id}
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
    SELECT * FROM agents WHERE id = ${id} AND org_id = ${orgId}
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

  // 构建 WHERE 条件
  let whereClause = sql`org_id = ${orgId}`

  if (isActive !== undefined) {
    whereClause = sql`${whereClause} AND is_active = ${isActive}`
  }

  if (search) {
    const searchPattern = `%${search}%`
    whereClause = sql`${whereClause} AND (name ILIKE ${searchPattern} OR description ILIKE ${searchPattern})`
  }

  // 获取总数
  const countResult = await sql`
    SELECT COUNT(*) as total FROM agents WHERE ${whereClause}
  `
  const total = parseInt((countResult[0] as { total: string }).total, 10)

  // 获取分页数据
  const dataResult = await sql`
    SELECT * FROM agents
    WHERE ${whereClause}
    ORDER BY updated_at DESC
    LIMIT ${actualLimit} OFFSET ${offset}
  `

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
    SELECT COUNT(*) as count FROM agents WHERE org_id = ${orgId}
  `

  return parseInt((result[0] as { count: string }).count, 10)
}

/**
 * 更新 Agent
 */
export async function update(id: string, orgId: string, data: UpdateAgentData): Promise<AgentRow | null> {
  // 构建动态更新字段
  const updates: string[] = []
  const values: unknown[] = []

  if (data.name !== undefined) {
    updates.push('name')
    values.push(data.name)
  }
  if (data.description !== undefined) {
    updates.push('description')
    values.push(data.description)
  }
  if (data.systemPrompt !== undefined) {
    updates.push('system_prompt')
    values.push(data.systemPrompt)
  }
  if (data.config !== undefined) {
    updates.push('config')
    values.push(JSON.stringify(data.config))
  }
  if (data.skills !== undefined) {
    updates.push('skills')
    values.push(data.skills)
  }
  if (data.subAgents !== undefined) {
    updates.push('sub_agents')
    values.push(data.subAgents)
  }
  if (data.isActive !== undefined) {
    updates.push('is_active')
    values.push(data.isActive)
  }
  if (data.isPublic !== undefined) {
    updates.push('is_public')
    values.push(data.isPublic)
  }

  if (updates.length === 0) {
    return findByIdAndOrg(id, orgId)
  }

  // 使用单独的 UPDATE 语句处理各字段
  let result

  if (data.name !== undefined && data.description !== undefined && data.systemPrompt !== undefined) {
    result = await sql`
      UPDATE agents
      SET name = ${data.name},
          description = ${data.description},
          system_prompt = ${data.systemPrompt},
          version = version + 1,
          updated_at = NOW()
      WHERE id = ${id} AND org_id = ${orgId}
      RETURNING *
    `
  } else if (data.name !== undefined) {
    result = await sql`
      UPDATE agents
      SET name = ${data.name},
          version = version + 1,
          updated_at = NOW()
      WHERE id = ${id} AND org_id = ${orgId}
      RETURNING *
    `
  } else if (data.isActive !== undefined) {
    result = await sql`
      UPDATE agents
      SET is_active = ${data.isActive},
          version = version + 1,
          updated_at = NOW()
      WHERE id = ${id} AND org_id = ${orgId}
      RETURNING *
    `
  } else {
    // 通用更新：使用完整的字段更新
    const agent = await findByIdAndOrg(id, orgId)
    if (!agent) return null

    result = await sql`
      UPDATE agents
      SET name = ${data.name ?? agent.name},
          description = ${data.description ?? agent.description},
          system_prompt = ${data.systemPrompt ?? agent.system_prompt},
          config = ${JSON.stringify(data.config ?? agent.config)},
          skills = ${data.skills ?? agent.skills},
          sub_agents = ${data.subAgents ?? agent.sub_agents},
          is_active = ${data.isActive ?? agent.is_active},
          is_public = ${data.isPublic ?? agent.is_public},
          version = version + 1,
          updated_at = NOW()
      WHERE id = ${id} AND org_id = ${orgId}
      RETURNING *
    `
  }

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as AgentRow
}

/**
 * 软删除 Agent
 */
export async function softDelete(id: string, orgId: string): Promise<boolean> {
  const result = await sql`
    UPDATE agents
    SET is_active = false, updated_at = NOW()
    WHERE id = ${id} AND org_id = ${orgId}
    RETURNING id
  `

  return result.length > 0
}
