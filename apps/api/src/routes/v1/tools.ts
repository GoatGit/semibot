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

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

function getRuntimeBaseUrls(): string[] {
  const configured = (process.env.RUNTIME_URL || '')
    .split(',')
    .map((value) => normalizeBaseUrl(value))
    .filter(Boolean)
  if (configured.length > 0) return Array.from(new Set(configured))
  const defaultPort = String(process.env.RUNTIME_PORT || '8765').trim() || '8765'
  return [`http://127.0.0.1:${defaultPort}`]
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'runtime unreachable'
}

// ═══════════════════════════════════════════════════════════════
// Schema 定义
// ═══════════════════════════════════════════════════════════════

export const updateToolSchema = z.object({
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
      authType: z.enum(['none', 'bearer', 'basic', 'api_key']).optional(),
      authHeader: z.string().max(100).optional(),
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
      connections: z.record(z.string().max(200), z.string().max(4000)).optional(),
    })
    .passthrough()
    .optional(),
  isActive: z.boolean().optional(),
})

export const listToolsQuerySchema = z.object({
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
 * GET /tools/catalog - 读取 runtime 统一工具目录（只读）
 */
router.get(
  '/catalog',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:read'),
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    const baseUrls = getRuntimeBaseUrls()
    const errors: string[] = []

    for (const baseUrl of baseUrls) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 3000)
      try {
        const response = await fetch(`${baseUrl}/v1/tools/catalog`, {
          method: 'GET',
          signal: controller.signal,
        })
        clearTimeout(timeout)
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          const detail = (data as { detail?: string }).detail || `runtime returned ${response.status}`
          errors.push(`${baseUrl}: ${detail}`)
          continue
        }

        const items = Array.isArray((data as { items?: unknown[] }).items)
          ? (data as { items: unknown[] }).items
          : []
        const generatedAt =
          typeof (data as { generated_at?: unknown }).generated_at === 'string'
            ? (data as { generated_at: string }).generated_at
            : new Date().toISOString()

        res.json({
          success: true,
          data: {
            items,
            generatedAt,
            source: baseUrl,
          },
        })
        return
      } catch (error) {
        clearTimeout(timeout)
        errors.push(`${baseUrl}: ${stringifyError(error)}`)
      }
    }

    res.status(502).json({
      success: false,
      error: {
        code: 'RUNTIME_UNREACHABLE',
        message: errors.join('; ') || 'runtime unreachable',
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
    const options = req.query

    const result = await toolService.listTools(options)

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
    const toolId = req.params.id

    const tool = await toolService.getTool(toolId)

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
    const userId = req.user!.userId
    const toolName = req.params.name
    const input = req.body

    const tool = await toolService.upsertBuiltinToolConfig(userId, toolName, input)

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
    const userId = req.user!.userId
    const toolId = req.params.id
    const input = req.body

    const tool = await toolService.updateTool(toolId, input, userId)

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
