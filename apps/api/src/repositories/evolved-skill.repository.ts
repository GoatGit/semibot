/**
 * Evolved Skill Repository
 *
 * 处理进化技能的数据库 CRUD 操作
 */

import { sql } from '../lib/db'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/config'
import { logPaginationLimit } from '../lib/logger'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface EvolvedSkillRow {
  id: string
  org_id: string
  agent_id: string
  session_id: string
  name: string
  description: string
  trigger_keywords: string[]
  steps: unknown[]
  tools_used: string[]
  parameters: Record<string, unknown>
  preconditions: Record<string, unknown>
  expected_outcome: string | null
  embedding: number[] | null
  quality_score: number
  reusability_score: number
  status: string
  use_count: number
  success_count: number
  last_used_at: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  review_comment: string | null
  version: number
  created_at: string
  updated_at: string
  deleted_at: string | null
  deleted_by: string | null
}

export interface CreateEvolvedSkillData {
  orgId: string
  agentId: string
  sessionId: string
  name: string
  description: string
  triggerKeywords?: string[]
  steps: unknown[]
  toolsUsed: string[]
  parameters?: Record<string, unknown>
  preconditions?: Record<string, unknown>
  expectedOutcome?: string
  qualityScore: number
  reusabilityScore: number
  status: string
}

export interface ListEvolvedSkillsParams {
  orgId: string
  status?: string
  agentId?: string
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

export interface EvolvedSkillWithScore extends EvolvedSkillRow {
  similarity: number
}

// ═══════════════════════════════════════════════════════════════
// Repository 方法
// ═══════════════════════════════════════════════════════════════

/**
 * 创建进化技能
 */
export async function create(data: CreateEvolvedSkillData): Promise<EvolvedSkillRow> {
  const result = await sql`
    INSERT INTO evolved_skills (
      org_id, agent_id, session_id, name, description,
      trigger_keywords, steps, tools_used, parameters,
      preconditions, expected_outcome, quality_score,
      reusability_score, status
    )
    VALUES (
      ${data.orgId},
      ${data.agentId},
      ${data.sessionId},
      ${data.name},
      ${data.description},
      ${data.triggerKeywords ?? []},
      ${sql.json(data.steps as Parameters<typeof sql.json>[0])},
      ${data.toolsUsed},
      ${sql.json((data.parameters ?? {}) as Parameters<typeof sql.json>[0])},
      ${sql.json((data.preconditions ?? {}) as Parameters<typeof sql.json>[0])},
      ${data.expectedOutcome ?? null},
      ${data.qualityScore},
      ${data.reusabilityScore},
      ${data.status}
    )
    RETURNING *
  `

  return result[0] as unknown as EvolvedSkillRow
}

/**
 * 根据 ID 和组织 ID 获取进化技能
 */
export async function findByIdAndOrg(id: string, orgId: string): Promise<EvolvedSkillRow | null> {
  const result = await sql`
    SELECT * FROM evolved_skills
    WHERE id = ${id}
    AND org_id = ${orgId}
    AND deleted_at IS NULL
  `

  if (result.length === 0) return null
  return result[0] as unknown as EvolvedSkillRow
}

/**
 * 列出进化技能（分页）
 */
export async function findByOrg(params: ListEvolvedSkillsParams): Promise<PaginatedResult<EvolvedSkillRow>> {
  const { orgId, status, agentId, page = 1, limit = DEFAULT_PAGE_SIZE } = params
  const actualLimit = Math.min(limit, MAX_PAGE_SIZE)
  const offset = (page - 1) * actualLimit

  logPaginationLimit('EvolvedSkillRepository', limit, actualLimit, MAX_PAGE_SIZE)

  let whereClause = sql`org_id = ${orgId} AND deleted_at IS NULL`

  if (status) {
    whereClause = sql`${whereClause} AND status = ${status}`
  }

  if (agentId) {
    whereClause = sql`${whereClause} AND agent_id = ${agentId}`
  }

  const countResult = await sql`
    SELECT COUNT(*) as total FROM evolved_skills WHERE ${whereClause}
  `
  const total = parseInt((countResult[0] as { total: string }).total, 10)

  const dataResult = await sql`
    SELECT * FROM evolved_skills
    WHERE ${whereClause}
    ORDER BY created_at DESC
    LIMIT ${actualLimit} OFFSET ${offset}
  `

  return {
    data: dataResult as unknown as EvolvedSkillRow[],
    meta: {
      total,
      page,
      limit: actualLimit,
      totalPages: Math.ceil(total / actualLimit),
    },
  }
}

/**
 * 更新审核状态
 */
export async function updateReviewStatus(
  id: string,
  action: 'approve' | 'reject',
  reviewedBy: string,
  comment?: string
): Promise<EvolvedSkillRow | null> {
  const newStatus = action === 'approve' ? 'approved' : 'rejected'

  const result = await sql`
    UPDATE evolved_skills
    SET status = ${newStatus},
        reviewed_by = ${reviewedBy},
        reviewed_at = NOW(),
        review_comment = ${comment ?? null},
        version = version + 1,
        updated_at = NOW()
    WHERE id = ${id}
    AND status = 'pending_review'
    AND deleted_at IS NULL
    RETURNING *
  `

  if (result.length === 0) return null
  return result[0] as unknown as EvolvedSkillRow
}

/**
 * 软删除（废弃）
 */
export async function softDelete(id: string, deletedBy: string): Promise<boolean> {
  const result = await sql`
    UPDATE evolved_skills
    SET deleted_at = NOW(),
        deleted_by = ${deletedBy},
        status = 'deprecated',
        version = version + 1,
        updated_at = NOW()
    WHERE id = ${id} AND deleted_at IS NULL
    RETURNING id
  `

  return result.length > 0
}

/**
 * 更新状态
 */
export async function updateStatus(id: string, status: string): Promise<boolean> {
  const result = await sql`
    UPDATE evolved_skills
    SET status = ${status},
        version = version + 1,
        updated_at = NOW()
    WHERE id = ${id} AND deleted_at IS NULL
    RETURNING id
  `

  return result.length > 0
}

/**
 * 原子递增使用计数
 */
export async function incrementUseCount(id: string): Promise<void> {
  await sql`
    UPDATE evolved_skills
    SET use_count = use_count + 1,
        last_used_at = NOW(),
        updated_at = NOW()
    WHERE id = ${id}
  `
}

/**
 * 原子递增成功计数
 */
export async function incrementSuccessCount(id: string): Promise<void> {
  await sql`
    UPDATE evolved_skills
    SET success_count = success_count + 1,
        updated_at = NOW()
    WHERE id = ${id}
  `
}

/**
 * 更新 embedding 向量
 */
export async function updateEmbedding(id: string, embedding: number[]): Promise<void> {
  await sql`
    UPDATE evolved_skills
    SET embedding = ${JSON.stringify(embedding)}::vector,
        updated_at = NOW()
    WHERE id = ${id}
  `
}

/**
 * 向量相似度检索
 */
export async function findByEmbedding(
  embedding: number[],
  orgId: string,
  limit: number = 5,
  threshold: number = 0.6,
  statusFilter: string[] = ['approved', 'auto_approved']
): Promise<EvolvedSkillWithScore[]> {
  const result = await sql`
    SELECT *,
           1 - (embedding <=> ${JSON.stringify(embedding)}::vector) AS similarity
    FROM evolved_skills
    WHERE org_id = ${orgId}
      AND status = ANY(${statusFilter})
      AND deleted_at IS NULL
      AND embedding IS NOT NULL
      AND 1 - (embedding <=> ${JSON.stringify(embedding)}::vector) >= ${threshold}
    ORDER BY similarity DESC
    LIMIT ${limit}
  `

  return result as unknown as EvolvedSkillWithScore[]
}

/**
 * 获取 Agent 进化统计
 */
export async function getStatsByAgent(
  agentId: string,
  orgId: string
): Promise<{
  total: number
  approved: number
  rejected: number
  pending: number
  autoApproved: number
  totalReuse: number
  avgQuality: number
}> {
  const result = await sql`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'approved') as approved,
      COUNT(*) FILTER (WHERE status = 'rejected') as rejected,
      COUNT(*) FILTER (WHERE status = 'pending_review') as pending,
      COUNT(*) FILTER (WHERE status = 'auto_approved') as auto_approved,
      COALESCE(SUM(use_count), 0) as total_reuse,
      COALESCE(AVG(quality_score), 0) as avg_quality
    FROM evolved_skills
    WHERE agent_id = ${agentId}
      AND org_id = ${orgId}
      AND deleted_at IS NULL
  `

  const row = result[0] as Record<string, string>
  return {
    total: parseInt(row.total, 10),
    approved: parseInt(row.approved, 10),
    rejected: parseInt(row.rejected, 10),
    pending: parseInt(row.pending, 10),
    autoApproved: parseInt(row.auto_approved, 10),
    totalReuse: parseInt(row.total_reuse, 10),
    avgQuality: parseFloat(row.avg_quality),
  }
}

/**
 * 获取 Top 技能（按使用次数排序）
 */
export async function getTopSkills(
  agentId: string,
  orgId: string,
  limit: number = 5
): Promise<Array<{ id: string; name: string; use_count: number; success_count: number }>> {
  const result = await sql`
    SELECT id, name, use_count, success_count
    FROM evolved_skills
    WHERE agent_id = ${agentId}
      AND org_id = ${orgId}
      AND status IN ('approved', 'auto_approved')
      AND deleted_at IS NULL
      AND use_count > 0
    ORDER BY use_count DESC
    LIMIT ${limit}
  `

  return result as unknown as Array<{ id: string; name: string; use_count: number; success_count: number }>
}

/**
 * 查找低成功率技能（用于质量退化检查）
 */
export async function findLowSuccessRate(
  orgId: string,
  maxSuccessRate: number,
  minUseCount: number
): Promise<EvolvedSkillRow[]> {
  const result = await sql`
    SELECT * FROM evolved_skills
    WHERE org_id = ${orgId}
      AND status IN ('approved', 'auto_approved')
      AND use_count >= ${minUseCount}
      AND deleted_at IS NULL
      AND (success_count::float / use_count) < ${maxSuccessRate}
  `

  return result as unknown as EvolvedSkillRow[]
}

/**
 * 查找长期未使用技能
 */
export async function findStaleSkills(
  orgId: string,
  staleDays: number
): Promise<EvolvedSkillRow[]> {
  const result = await sql`
    SELECT * FROM evolved_skills
    WHERE org_id = ${orgId}
      AND status IN ('approved', 'auto_approved')
      AND use_count = 0
      AND deleted_at IS NULL
      AND created_at < NOW() - ${staleDays + ' days'}::interval
  `

  return result as unknown as EvolvedSkillRow[]
}

/**
 * 批量查询
 */
export async function findByIds(ids: string[]): Promise<EvolvedSkillRow[]> {
  if (ids.length === 0) return []

  const result = await sql`
    SELECT * FROM evolved_skills
    WHERE id = ANY(${ids})
    AND deleted_at IS NULL
  `

  return result as unknown as EvolvedSkillRow[]
}
