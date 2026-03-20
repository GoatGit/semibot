/**
 * Memory 服务层
 *
 * 单用户模式：数据持久化到 ~/.semibot/memory/memories.json
 * 向量相似度搜索使用 JS 余弦相似度
 */

import { createError } from '../middleware/errorHandler'
import { RESOURCE_NOT_FOUND } from '../constants/errorCodes'
import * as local from '../lib/memory-local-store'
import { createLogger } from '../lib/logger'

const memoryLogger = createLogger('memory')

export interface Memory {
  id: string
  agentId: string
  sessionId?: string
  userId?: string
  content: string
  embedding?: number[]
  memoryType: 'episodic' | 'semantic' | 'procedural'
  importance: number
  accessCount: number
  lastAccessedAt?: string
  metadata: Record<string, unknown>
  expiresAt?: string
  createdAt: string
}

export interface CreateMemoryInput {
  agentId: string
  sessionId?: string
  userId?: string
  content: string
  embedding?: number[]
  memoryType?: 'episodic' | 'semantic' | 'procedural'
  importance?: number
  metadata?: Record<string, unknown>
  expiresAt?: string
}

export interface SearchMemoryInput {
  agentId: string
  embedding: number[]
  limit?: number
  minSimilarity?: number
}

export interface ListMemoriesOptions {
  agentId?: string
  sessionId?: string
  userId?: string
  memoryType?: string
  page?: number
  limit?: number
}

export interface PaginatedResult<T> {
  data: T[]
  meta: { total: number; page: number; limit: number; totalPages: number }
}

function rowToMemory(row: local.LocalMemoryRow): Memory {
  return {
    id: row.id,
    agentId: row.agent_id,
    sessionId: row.session_id ?? undefined,
    userId: row.user_id ?? undefined,
    content: row.content,
    embedding: row.embedding ?? undefined,
    memoryType: row.memory_type,
    importance: row.importance,
    accessCount: row.access_count,
    lastAccessedAt: row.last_accessed_at ?? undefined,
    metadata: row.metadata,
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
  }
}

export async function createMemory(input: CreateMemoryInput): Promise<Memory> {
  const row = local.localCreateMemory({
    agentId: input.agentId,
    sessionId: input.sessionId,
    userId: input.userId,
    content: input.content,
    memoryType: input.memoryType,
    importance: input.importance,
    metadata: input.metadata,
    expiresAt: input.expiresAt,
  })
  if (input.embedding) {
    local.localUpdateMemoryEmbedding(row.id, input.embedding)
  }
  return rowToMemory(row)
}

export async function getMemory(memoryId: string): Promise<Memory> {
  const row = local.localFindMemoryById(memoryId)
  if (!row) throw createError(RESOURCE_NOT_FOUND)
  local.localIncrementMemoryAccess(memoryId)
  return rowToMemory(row)
}

export async function listMemories(
  options: ListMemoriesOptions = {}
): Promise<PaginatedResult<Memory>> {
  const agentId = options.agentId ?? ''
  const page = options.page ?? 1
  const limit = options.limit ?? 20
  const offset = (page - 1) * limit

  const allRows = local.localFindMemoriesByAgent(agentId, {
    memoryType: options.memoryType,
  })

  const total = allRows.length
  const filtered = allRows.slice(offset, offset + limit)

  return {
    data: filtered.map(rowToMemory),
    meta: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
  }
}

export async function searchSimilarMemories(
  input: SearchMemoryInput
): Promise<Array<Memory & { similarity: number }>> {
  const minSimilarity = input.minSimilarity ?? 0.7
  const results = local.localFindMemoriesByEmbedding(input.embedding, input.agentId, input.limit ?? 10, minSimilarity)

  for (const row of results) {
    local.localIncrementMemoryAccess(row.id)
  }

  return results.map((row) => ({ ...rowToMemory(row), similarity: row.similarity }))
}

export async function deleteMemory(memoryId: string): Promise<void> {
  const deleted = local.localDeleteMemory(memoryId)
  if (!deleted) throw createError(RESOURCE_NOT_FOUND)
}

export async function cleanupExpiredMemories(): Promise<number> {
  // 本地存储在读取时自动过滤过期记录，此处返回 0
  memoryLogger.debug('清理过期记忆（本地模式，无需操作）')
  return 0
}
