/**
 * Memory API 路由
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import * as memoryService from '../../services/memory.service'

const router: Router = Router()

// ═══════════════════════════════════════════════════════════════
// Schema 定义
// ═══════════════════════════════════════════════════════════════

const createMemorySchema = z.object({
  agentId: z.string().uuid(),
  sessionId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  content: z.string().min(1).max(50000),
  embedding: z.array(z.number()).length(1536).optional(),
  memoryType: z.enum(['episodic', 'semantic', 'procedural']).optional(),
  importance: z.number().min(0).max(1).optional(),
  metadata: z.record(z.unknown()).optional(),
  expiresAt: z.string().datetime().optional(),
})

const searchMemoriesSchema = z.object({
  agentId: z.string().uuid(),
  embedding: z.array(z.number()).length(1536),
  limit: z.number().min(1).max(100).optional(),
  minSimilarity: z.number().min(0).max(1).optional(),
})

const listMemoriesQuerySchema = z.object({
  agentId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  memoryType: z.enum(['episodic', 'semantic', 'procedural']).optional(),
  page: z.coerce.number().min(1).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
})

// ═══════════════════════════════════════════════════════════════
// 路由
// ═══════════════════════════════════════════════════════════════

/**
 * POST /memory - 创建 Memory
 */
router.post(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('memory:write'),
  validate(createMemorySchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const input = req.body

    const memory = await memoryService.createMemory(orgId, input)

    res.status(201).json({
      success: true,
      data: memory,
    })
  })
)

/**
 * GET /memory - 列出 Memories
 */
router.get(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('memory:read'),
  validate(listMemoriesQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const options = req.query

    const result = await memoryService.listMemories(orgId, options)

    res.json({
      success: true,
      data: result.data,
      meta: result.meta,
    })
  })
)

/**
 * POST /memory/search - 向量搜索相似记忆
 */
router.post(
  '/search',
  authenticate,
  combinedRateLimit,
  requirePermission('memory:read'),
  validate(searchMemoriesSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const input = req.body

    const memories = await memoryService.searchSimilarMemories(orgId, input)

    res.json({
      success: true,
      data: memories,
    })
  })
)

/**
 * GET /memory/:id - 获取 Memory 详情
 */
router.get(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('memory:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const memoryId = req.params.id

    const memory = await memoryService.getMemory(orgId, memoryId)

    res.json({
      success: true,
      data: memory,
    })
  })
)

/**
 * DELETE /memory/:id - 删除 Memory
 */
router.delete(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('memory:write'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const memoryId = req.params.id

    await memoryService.deleteMemory(orgId, memoryId)

    res.status(204).send()
  })
)

/**
 * POST /memory/cleanup - 清理过期记忆
 */
router.post(
  '/cleanup',
  authenticate,
  combinedRateLimit,
  requirePermission('memory:write'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId

    const count = await memoryService.cleanupExpiredMemories(orgId)

    res.json({
      success: true,
      data: {
        deletedCount: count,
      },
    })
  })
)

export default router
