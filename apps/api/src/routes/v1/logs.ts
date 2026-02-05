/**
 * Logs API 路由
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import * as logsService from '../../services/logs.service'

const router: Router = Router()

// ═══════════════════════════════════════════════════════════════
// Schema 定义
// ═══════════════════════════════════════════════════════════════

const listExecutionLogsQuerySchema = z.object({
  agentId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
  requestId: z.string().max(100).optional(),
  state: z.string().max(50).optional(),
  errorCode: z.string().max(50).optional(),
  page: z.coerce.number().min(1).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
})

const listUsageRecordsQuerySchema = z.object({
  userId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
  periodType: z.enum(['hourly', 'daily', 'monthly']).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  page: z.coerce.number().min(1).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
})

const getUsageSummaryQuerySchema = z.object({
  periodType: z.enum(['hourly', 'daily', 'monthly']),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
})

// ═══════════════════════════════════════════════════════════════
// 路由
// ═══════════════════════════════════════════════════════════════

/**
 * GET /logs/executions - 列出执行日志
 */
router.get(
  '/executions',
  authenticate,
  combinedRateLimit,
  requirePermission('logs:read'),
  validate(listExecutionLogsQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const options = req.query

    const result = await logsService.listExecutionLogs(orgId, options)

    res.json({
      success: true,
      data: result.data,
      meta: result.meta,
    })
  })
)

/**
 * GET /logs/usage - 列出使用量记录
 */
router.get(
  '/usage',
  authenticate,
  combinedRateLimit,
  requirePermission('logs:read'),
  validate(listUsageRecordsQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const options = req.query

    const result = await logsService.listUsageRecords(orgId, options)

    res.json({
      success: true,
      data: result.data,
      meta: result.meta,
    })
  })
)

/**
 * GET /logs/usage/summary - 获取使用量汇总
 */
router.get(
  '/usage/summary',
  authenticate,
  combinedRateLimit,
  requirePermission('logs:read'),
  validate(getUsageSummaryQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const { periodType, startDate, endDate } = req.query as {
      periodType: 'hourly' | 'daily' | 'monthly'
      startDate: string
      endDate: string
    }

    const summary = await logsService.getUsageSummary(orgId, periodType, startDate, endDate)

    res.json({
      success: true,
      data: summary,
    })
  })
)

export default router
