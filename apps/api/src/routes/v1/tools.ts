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

const updateToolSchema = z.object({
  config: z
    .object({
      timeout: z.number().min(1000).max(300000).optional(),
      retryAttempts: z.number().min(0).max(5).optional(),
      requiresApproval: z.boolean().optional(),
      riskLevel: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      approvalScope: z
        .enum(['call', 'action', 'target', 'session', 'session_action', 'tool'])
        .optional(),
      approvalDedupeKeys: z.array(z.string().min(1).max(64)).max(20).optional(),
      rateLimit: z.number().min(1).max(1000).optional(),
      apiEndpoint: z.string().url().optional(),
      apiKey: z.string().max(500).optional(),
      rootPath: z.string().max(1000).optional(),
      maxReadBytes: z.number().int().min(1).max(10_000_000).optional(),
      headless: z.boolean().optional(),
      browserType: z.enum(['chromium', 'firefox', 'webkit']).optional(),
      allowLocalhost: z.boolean().optional(),
      allowedDomains: z.array(z.string().min(1).max(255)).max(100).optional(),
      blockedDomains: z.array(z.string().min(1).max(255)).max(100).optional(),
      maxTextLength: z.number().int().min(100).max(500_000).optional(),
      maxResponseChars: z.number().int().min(100).max(500_000).optional(),
      maxRows: z.number().int().min(1).max(5_000).optional(),
      defaultDatabase: z.string().max(200).optional(),
      allowedDatabases: z.array(z.string().min(1).max(200)).max(100).optional(),
    })
    .passthrough()
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
 * POST /tools - 禁止创建 Tool（V2: tools 仅支持内建）
 */
router.post(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:write'),
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    res.status(405).json({
      success: false,
      error: {
        code: 'TOOL_CREATE_DISABLED',
        message: 'V2 不支持新增 Tool。Tools 为内建能力，仅支持配置与启停。',
      },
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
  '/by-name/:name',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:write'),
  validate(updateToolSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const userId = req.user!.userId
    const toolName = req.params.name
    const input = req.body

    const tool = await toolService.upsertBuiltinToolConfig(orgId, userId, toolName, input)

    res.json({
      success: true,
      data: tool,
    })
  })
)

/**
 * PUT /tools/:id - 更新 Tool 配置
 */
router.put(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:write'),
  validate(updateToolSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const userId = req.user!.userId
    const toolId = req.params.id
    const input = req.body

    const tool = await toolService.updateTool(orgId, toolId, input, userId)

    res.json({
      success: true,
      data: tool,
    })
  })
)

/**
 * DELETE /tools/:id - 禁止删除 Tool（V2: tools 仅支持内建）
 */
router.delete(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:write'),
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    res.status(405).json({
      success: false,
      error: {
        code: 'TOOL_DELETE_DISABLED',
        message: 'V2 不支持删除 Tool。Tools 为内建能力，仅支持配置与启停。',
      },
    })
  })
)

export default router
