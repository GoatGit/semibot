/**
 * Evolution Log Repository
 *
 * 处理进化日志的数据库操作
 */

import { sql } from '../lib/db'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/config'
import { logPaginationLimit } from '../lib/logger'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface EvolutionLogRow {
  id: string
  org_id: string
  agent_id: string
  session_id: string
  stage: string
  status: string
  evolved_skill_id: string | null
  input_data: Record<string, unknown> | null
  output_data: Record<string, unknown> | null
  error_message: string | null
  duration_ms: number | null
  tokens_used: number
  created_at: string
}

export interface CreateEvolutionLogData {
  orgId: string
  agentId: string
  sessionId: string
  stage: string
  status: string
  evolvedSkillId?: string
  inputData?: Record<string, unknown>
  outputData?: Record<string, unknown>
  errorMessage?: string
  durationMs?: number
  tokensUsed?: number
}

export interface ListEvolutionLogsParams {
  orgId: string
  agentId?: string
  sessionId?: string
  stage?: string
  page?: number
  limit?: number
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
 * 创建进化日志
 */
export async function create(data: CreateEvolutionLogData): Promise<EvolutionLogRow> {
  const result = await sql`
    INSERT INTO evolution_logs (
      org_id, agent_id, session_id, stage, status,
      evolved_skill_id, input_data, output_data,
      error_message, duration_ms, tokens_used
    )
    VALUES (
      ${data.orgId},
      ${data.agentId},
      ${data.sessionId},
      ${data.stage},
      ${data.status},
      ${data.evolvedSkillId ?? null},
      ${data.inputData ? sql.json(data.inputData as Parameters<typeof sql.json>[0]) : null},
      ${data.outputData ? sql.json(data.outputData as Parameters<typeof sql.json>[0]) : null},
      ${data.errorMessage ?? null},
      ${data.durationMs ?? null},
      ${data.tokensUsed ?? 0}
    )
    RETURNING *
  `

  return result[0] as unknown as EvolutionLogRow
}

/**
 * 列出进化日志（分页）
 */
export async function findByOrg(params: ListEvolutionLogsParams): Promise<PaginatedResult<EvolutionLogRow>> {
  const { orgId, agentId, sessionId, stage, page = 1, limit = DEFAULT_PAGE_SIZE } = params
  const actualLimit = Math.min(limit, MAX_PAGE_SIZE)
  const offset = (page - 1) * actualLimit

  logPaginationLimit('EvolutionLogRepository', limit, actualLimit, MAX_PAGE_SIZE)

  let whereClause = sql`org_id = ${orgId}`

  if (agentId) {
    whereClause = sql`${whereClause} AND agent_id = ${agentId}`
  }

  if (sessionId) {
    whereClause = sql`${whereClause} AND session_id = ${sessionId}`
  }

  if (stage) {
    whereClause = sql`${whereClause} AND stage = ${stage}`
  }

  const countResult = await sql`
    SELECT COUNT(*) as total FROM evolution_logs WHERE ${whereClause}
  `
  const total = parseInt((countResult[0] as { total: string }).total, 10)

  const dataResult = await sql`
    SELECT * FROM evolution_logs
    WHERE ${whereClause}
    ORDER BY created_at DESC
    LIMIT ${actualLimit} OFFSET ${offset}
  `

  return {
    data: dataResult as unknown as EvolutionLogRow[],
    meta: {
      total,
      page,
      limit: actualLimit,
      totalPages: Math.ceil(total / actualLimit),
    },
  }
}

/**
 * 根据会话 ID 获取进化日志
 */
export async function findBySession(sessionId: string, orgId: string): Promise<EvolutionLogRow[]> {
  const result = await sql`
    SELECT * FROM evolution_logs
    WHERE session_id = ${sessionId}
    AND org_id = ${orgId}
    ORDER BY created_at ASC
  `

  return result as unknown as EvolutionLogRow[]
}

/**
 * 根据进化技能 ID 获取日志
 */
export async function findByEvolvedSkillId(evolvedSkillId: string): Promise<EvolutionLogRow[]> {
  const result = await sql`
    SELECT * FROM evolution_logs
    WHERE evolved_skill_id = ${evolvedSkillId}
    ORDER BY created_at ASC
  `

  return result as unknown as EvolutionLogRow[]
}
