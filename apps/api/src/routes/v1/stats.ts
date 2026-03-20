/**
 * Stats API 路由 - Token 使用统计
 *
 * 优先从 runtime 获取数据（runtime EventStore 数据更全），
 * runtime 不可用时回退到本地 SQLite 聚合
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import { runtimeRequest } from '../../lib/runtime-client'
import * as logsService from '../../services/logs.service'
import { createLogger } from '../../lib/logger'

const logger = createLogger('stats-route')
const router: Router = Router()

const tokenUsageQuerySchema = z.object({
  since: z.string().optional(),
  until: z.string().optional(),
  group_by: z.enum(['node', 'model', 'session', 'agent']).optional(),
  granularity: z.enum(['hour', 'day']).optional(),
})

router.get(
  '/token-usage',
  authenticate,
  combinedRateLimit,
  requirePermission('events:read'),
  validate(tokenUsageQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { since, until, group_by, granularity } = req.query as z.infer<typeof tokenUsageQuerySchema>

    // 优先尝试 runtime（EventStore 数据更全，支持 granularity + segments）
    try {
      const runtimePayload = await runtimeRequest('/v1/stats/token-usage', {
        method: 'GET',
        query: { since, until, group_by, granularity },
      })
      res.json(runtimePayload)
      return
    } catch (err) {
      logger.debug('Runtime 不可用，回退到本地聚合', { error: (err as Error).message })
    }

    // 回退：本地 SQLite 聚合
    const result = await logsService.getTokenUsage({ since, until, groupBy: group_by, granularity })
    res.json(result)
  })
)

export default router
