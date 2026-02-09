/**
 * Session Repository
 *
 * 处理 Session 的数据库 CRUD 操作
 */

import { sql } from '../lib/db'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/config'
import { logPaginationLimit } from '../lib/logger'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export type SessionStatus = 'active' | 'paused' | 'completed' | 'failed'

export interface SessionRow {
  id: string
  org_id: string
  agent_id: string
  user_id: string
  status: SessionStatus
  title: string | null
  metadata: Record<string, unknown> | null
  started_at: string
  ended_at: string | null
  created_at: string
}

export interface CreateSessionData {
  orgId: string
  agentId: string
  userId: string
  title?: string
  metadata?: Record<string, unknown>
}

export interface ListSessionsParams {
  orgId: string
  userId: string
  page?: number
  limit?: number
  agentId?: string
  status?: SessionStatus
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
 * 创建 Session
 */
export async function create(data: CreateSessionData): Promise<SessionRow> {
  const result = await sql`
    INSERT INTO sessions (org_id, agent_id, user_id, title, metadata)
    VALUES (
      ${data.orgId},
      ${data.agentId},
      ${data.userId},
      ${data.title ?? null},
      ${data.metadata ? JSON.stringify(data.metadata) : null}
    )
    RETURNING *
  `

  return result[0] as unknown as SessionRow
}

/**
 * 根据 ID 获取 Session
 */
export async function findById(id: string): Promise<SessionRow | null> {
  const result = await sql`
    SELECT * FROM sessions WHERE id = ${id} AND deleted_at IS NULL
  `

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as SessionRow
}

/**
 * 根据 ID 和组织 ID 获取 Session
 */
export async function findByIdAndOrg(id: string, orgId: string): Promise<SessionRow | null> {
  const result = await sql`
    SELECT * FROM sessions WHERE id = ${id} AND org_id = ${orgId} AND deleted_at IS NULL
  `

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as SessionRow
}

/**
 * 列出用户的 Sessions（分页）
 */
export async function findByUserAndOrg(params: ListSessionsParams): Promise<PaginatedResult<SessionRow>> {
  const { orgId, userId, page = 1, limit = DEFAULT_PAGE_SIZE, agentId, status } = params
  const actualLimit = Math.min(limit, MAX_PAGE_SIZE)
  const offset = (page - 1) * actualLimit

  // 记录分页限制日志
  logPaginationLimit('SessionRepository', limit, actualLimit, MAX_PAGE_SIZE)

  // 构建基础条件
  let whereClause = sql`org_id = ${orgId} AND user_id = ${userId}`

  if (agentId) {
    whereClause = sql`${whereClause} AND agent_id = ${agentId}`
  }

  if (status) {
    whereClause = sql`${whereClause} AND status = ${status}`
  }

  // 获取总数
  const countResult = await sql`
    SELECT COUNT(*) as total FROM sessions WHERE ${whereClause}
  `
  const total = parseInt((countResult[0] as { total: string }).total, 10)

  // 获取分页数据
  const dataResult = await sql`
    SELECT * FROM sessions
    WHERE ${whereClause}
    ORDER BY created_at DESC
    LIMIT ${actualLimit} OFFSET ${offset}
  `

  const data = dataResult as unknown as SessionRow[]

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
 * 更新 Session 状态
 */
export async function updateStatus(
  id: string,
  orgId: string,
  status: SessionStatus
): Promise<SessionRow | null> {
  const isEnded = status === 'completed' || status === 'failed'

  const result = await sql`
    UPDATE sessions
    SET status = ${status},
        ended_at = ${isEnded ? sql`NOW()` : sql`ended_at`}
    WHERE id = ${id} AND org_id = ${orgId}
    RETURNING *
  `

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as SessionRow
}

/**
 * 更新 Session 标题
 */
export async function updateTitle(
  id: string,
  orgId: string,
  title: string
): Promise<SessionRow | null> {
  const result = await sql`
    UPDATE sessions
    SET title = ${title}
    WHERE id = ${id} AND org_id = ${orgId}
    RETURNING *
  `

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as SessionRow
}

/**
 * 软删除 Session
 */
export async function softDelete(id: string, orgId: string, deletedBy?: string): Promise<boolean> {
  const result = await sql`
    UPDATE sessions
    SET deleted_at = NOW(),
        deleted_by = ${deletedBy ?? null},
        status = 'completed',
        ended_at = COALESCE(ended_at, NOW())
    WHERE id = ${id} AND org_id = ${orgId} AND deleted_at IS NULL
    RETURNING id
  `

  return result.length > 0
}
