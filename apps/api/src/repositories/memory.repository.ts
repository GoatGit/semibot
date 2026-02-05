/**
 * Memory Repository
 *
 * 处理 Memory 的数据库 CRUD 操作
 */

import { sql } from '../lib/db'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/config'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface MemoryRow {
  id: string
  org_id: string
  agent_id: string
  session_id: string | null
  user_id: string | null
  content: string
  embedding: number[] | null
  memory_type: string
  importance: number
  access_count: number
  last_accessed_at: string | null
  metadata: Record<string, unknown>
  expires_at: string | null
  created_at: string
}

export interface CreateMemoryData {
  orgId: string
  agentId: string
  sessionId?: string
  userId?: string
  content: string
  embedding?: number[]
  memoryType?: string
  importance?: number
  metadata?: Record<string, unknown>
  expiresAt?: string
}

export interface ListMemoriesParams {
  orgId: string
  agentId?: string
  sessionId?: string
  userId?: string
  memoryType?: string
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
 * 创建 Memory
 */
export async function create(data: CreateMemoryData): Promise<MemoryRow> {
  const result = await sql`
    INSERT INTO memories (
      org_id, agent_id, session_id, user_id, content,
      embedding, memory_type, importance, metadata, expires_at
    )
    VALUES (
      ${data.orgId},
      ${data.agentId},
      ${data.sessionId ?? null},
      ${data.userId ?? null},
      ${data.content},
      ${data.embedding ? JSON.stringify(data.embedding) : null}::vector,
      ${data.memoryType ?? 'episodic'},
      ${data.importance ?? 0.5},
      ${JSON.stringify(data.metadata ?? {})},
      ${data.expiresAt ?? null}
    )
    RETURNING *
  `

  return result[0] as unknown as MemoryRow
}

/**
 * 根据 ID 获取 Memory
 */
export async function findById(id: string): Promise<MemoryRow | null> {
  const result = await sql`
    SELECT * FROM memories WHERE id = ${id}
  `

  if (result.length === 0) {
    return null
  }

  return result[0] as unknown as MemoryRow
}

/**
 * 列出 Memories（分页）
 */
export async function findAll(params: ListMemoriesParams): Promise<PaginatedResult<MemoryRow>> {
  const { orgId, agentId, sessionId, userId, memoryType, page = 1, limit = DEFAULT_PAGE_SIZE } = params
  const actualLimit = Math.min(limit, MAX_PAGE_SIZE)
  const offset = (page - 1) * actualLimit

  // 构建 WHERE 条件
  let whereClause = sql`org_id = ${orgId} AND (expires_at IS NULL OR expires_at > NOW())`

  if (agentId) {
    whereClause = sql`${whereClause} AND agent_id = ${agentId}`
  }

  if (sessionId) {
    whereClause = sql`${whereClause} AND session_id = ${sessionId}`
  }

  if (userId) {
    whereClause = sql`${whereClause} AND user_id = ${userId}`
  }

  if (memoryType) {
    whereClause = sql`${whereClause} AND memory_type = ${memoryType}`
  }

  // 获取总数
  const countResult = await sql`
    SELECT COUNT(*) as total FROM memories WHERE ${whereClause}
  `
  const total = parseInt((countResult[0] as { total: string }).total, 10)

  // 获取分页数据
  const dataResult = await sql`
    SELECT * FROM memories
    WHERE ${whereClause}
    ORDER BY importance DESC, created_at DESC
    LIMIT ${actualLimit} OFFSET ${offset}
  `

  const data = dataResult as unknown as MemoryRow[]

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
 * 搜索相似记忆（向量检索）
 */
export async function searchSimilar(
  agentId: string,
  embedding: number[],
  limit: number = 10,
  minSimilarity: number = 0.7
): Promise<Array<MemoryRow & { similarity: number }>> {
  const result = await sql`
    SELECT *, (1 - (embedding <=> ${JSON.stringify(embedding)}::vector))::FLOAT as similarity
    FROM memories
    WHERE agent_id = ${agentId}
      AND (expires_at IS NULL OR expires_at > NOW())
      AND embedding IS NOT NULL
      AND (1 - (embedding <=> ${JSON.stringify(embedding)}::vector)) >= ${minSimilarity}
    ORDER BY embedding <=> ${JSON.stringify(embedding)}::vector
    LIMIT ${limit}
  `

  return result as unknown as Array<MemoryRow & { similarity: number }>
}

/**
 * 更新记忆访问统计
 */
export async function updateAccessStats(id: string): Promise<void> {
  await sql`
    UPDATE memories
    SET access_count = access_count + 1,
        last_accessed_at = NOW()
    WHERE id = ${id}
  `
}

/**
 * 删除 Memory
 */
export async function deleteById(id: string): Promise<boolean> {
  const result = await sql`
    DELETE FROM memories WHERE id = ${id} RETURNING id
  `

  return result.length > 0
}

/**
 * 批量删除过期记忆
 */
export async function deleteExpired(orgId: string): Promise<number> {
  const result = await sql`
    DELETE FROM memories
    WHERE org_id = ${orgId} AND expires_at IS NOT NULL AND expires_at < NOW()
    RETURNING id
  `

  return result.length
}
