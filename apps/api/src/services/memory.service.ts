/**
 * Memory 服务层
 *
 * 使用数据库持久化实现 Memory CRUD 和向量检索
 */

import { createError } from '../middleware/errorHandler'
import { RESOURCE_NOT_FOUND } from '../constants/errorCodes'
import * as memoryRepository from '../repositories/memory.repository'
import { createLogger } from '../lib/logger'

const memoryLogger = createLogger('memory')

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface Memory {
  id: string
  orgId: string
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
  meta: {
    total: number
    page: number
    limit: number
    totalPages: number
  }
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 将数据库行转换为 Memory 对象
 */
function rowToMemory(row: memoryRepository.MemoryRow): Memory {
  return {
    id: row.id,
    orgId: row.org_id,
    agentId: row.agent_id,
    sessionId: row.session_id ?? undefined,
    userId: row.user_id ?? undefined,
    content: row.content,
    embedding: row.embedding ?? undefined,
    memoryType: row.memory_type as Memory['memoryType'],
    importance: row.importance,
    accessCount: row.access_count,
    lastAccessedAt: row.last_accessed_at ?? undefined,
    metadata: row.metadata,
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
  }
}

// ═══════════════════════════════════════════════════════════════
// 服务方法
// ═══════════════════════════════════════════════════════════════

/**
 * 创建 Memory
 */
export async function createMemory(
  orgId: string,
  input: CreateMemoryInput
): Promise<Memory> {
  const row = await memoryRepository.create({
    orgId,
    agentId: input.agentId,
    sessionId: input.sessionId,
    userId: input.userId,
    content: input.content,
    embedding: input.embedding,
    memoryType: input.memoryType,
    importance: input.importance,
    metadata: input.metadata,
    expiresAt: input.expiresAt,
  })

  return rowToMemory(row)
}

/**
 * 获取 Memory
 */
export async function getMemory(orgId: string, memoryId: string): Promise<Memory> {
  const row = await memoryRepository.findById(memoryId)

  if (!row || row.org_id !== orgId) {
    throw createError(RESOURCE_NOT_FOUND)
  }

  // 更新访问统计
  await memoryRepository.updateAccessStats(memoryId)

  return rowToMemory(row)
}

/**
 * 列出 Memories
 */
export async function listMemories(
  orgId: string,
  options: ListMemoriesOptions = {}
): Promise<PaginatedResult<Memory>> {
  const result = await memoryRepository.findAll({
    orgId,
    agentId: options.agentId,
    sessionId: options.sessionId,
    userId: options.userId,
    memoryType: options.memoryType,
    page: options.page,
    limit: options.limit,
  })

  return {
    data: result.data.map(rowToMemory),
    meta: result.meta,
  }
}

/**
 * 搜索相似记忆
 */
export async function searchSimilarMemories(
  orgId: string,
  input: SearchMemoryInput
): Promise<Array<Memory & { similarity: number }>> {
  const results = await memoryRepository.searchSimilar(
    orgId,
    input.agentId,
    input.embedding,
    input.limit ?? 10,
    input.minSimilarity ?? 0.7
  )

  // 更新访问统计
  for (const row of results) {
    await memoryRepository.updateAccessStats(row.id)
  }

  return results.map((row) => ({
    ...rowToMemory(row),
    similarity: row.similarity,
  }))
}

/**
 * 删除 Memory
 */
export async function deleteMemory(orgId: string, memoryId: string): Promise<void> {
  const row = await memoryRepository.findById(memoryId)

  if (!row || row.org_id !== orgId) {
    throw createError(RESOURCE_NOT_FOUND)
  }

  const deleted = await memoryRepository.deleteById(memoryId)

  if (!deleted) {
    throw createError(RESOURCE_NOT_FOUND)
  }
}

/**
 * 清理过期记忆
 */
export async function cleanupExpiredMemories(orgId: string): Promise<number> {
  const count = await memoryRepository.deleteExpired(orgId)

  if (count > 0) {
    memoryLogger.info('已清理过期记忆', { orgId, count })
  }

  return count
}
