/**
 * Tools API 路由
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import * as toolService from '../../services/tool.service'

const router: Router = Router()

// ═══════════════════════════════════════════════════════════════
// Schema 定义
// ═══════════════════════════════════════════════════════════════

const createToolSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  type: z.string().min(1).max(50),
  schema: z
    .object({
      parameters: z.record(z.unknown()).optional(),
      returns: z.record(z.unknown()).optional(),
    })
    .optional(),
  config: z
    .object({
      timeout: z.number().min(1000).max(300000).optional(),
      retryAttempts: z.number().min(0).max(5).optional(),
      requiresApproval: z.boolean().optional(),
      rateLimit: z.number().min(1).max(1000).optional(),
    })
    .optional(),
})

const updateToolSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  type: z.string().min(1).max(50).optional(),
  schema: z
    .object({
      parameters: z.record(z.unknown()).optional(),
      returns: z.record(z.unknown()).optional(),
    })
    .optional(),
  config: z
    .object({
      timeout: z.number().min(1000).max(300000).optional(),
      retryAttempts: z.number().min(0).max(5).optional(),
      requiresApproval: z.boolean().optional(),
      rateLimit: z.number().min(1).max(1000).optional(),
    })
    .optional(),
  isActive: z.boolean().optional(),
})

const listToolsQuerySchema = z.object({
  page: z.coerce.number().min(1).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  search: z.string().max(100).optional(),
  type: z.string().max(50).optional(),
  includeBuiltin: z
    .enum(['true', 'false'])
    .optional()
    .transform((val) => val !== 'false'),
})

// ═══════════════════════════════════════════════════════════════
// 路由
// ═══════════════════════════════════════════════════════════════

/**
 * POST /tools - 创建 Tool
 */
router.post(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:write'),
  validate(createToolSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const userId = req.user!.userId
    const input = req.body

    const tool = await toolService.createTool(orgId, userId, input)

    res.status(201).json({
      success: true,
      data: tool,
    })
  })
)

/**
 * GET /tools - 列出 Tools
 */
router.get(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:read'),
  validate(listToolsQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const options = req.query

    const result = await toolService.listTools(orgId, options)

    res.json({
      success: true,
      data: result.data,
      meta: result.meta,
    })
  })
)

/**
 * GET /tools/:id - 获取 Tool 详情
 */
router.get(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const toolId = req.params.id

    const tool = await toolService.getTool(orgId, toolId)

    res.json({
      success: true,
      data: tool,
    })
  })
)

/**
 * PUT /tools/:id - 更新 Tool
 */
router.put(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:write'),
  validate(updateToolSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const toolId = req.params.id
    const input = req.body

    const tool = await toolService.updateTool(orgId, toolId, input)

    res.json({
      success: true,
      data: tool,
    })
  })
)

/**
 * DELETE /tools/:id - 删除 Tool
 */
router.delete(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:write'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const toolId = req.params.id

    await toolService.deleteTool(orgId, toolId)

    res.status(204).send()
  })
)

export default router
