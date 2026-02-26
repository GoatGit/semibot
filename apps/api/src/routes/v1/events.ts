/**
 * Events API 路由
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import * as eventEngineService from '../../services/event-engine.service'

const router: Router = Router()

const listEventsQuerySchema = z.object({
  type: z.string().max(120).optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
})

const replaySchema = z.object({
  event_id: z.string().min(1),
})

router.get(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('events:read'),
  validate(listEventsQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { type, limit } = req.query as z.infer<typeof listEventsQuerySchema>
    const items = await eventEngineService.listEvents({ type, limit })
    res.json({
      success: true,
      items,
      next_cursor: null,
    })
  })
)

router.post(
  '/replay',
  authenticate,
  combinedRateLimit,
  requirePermission('events:write'),
  validate(replaySchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { event_id } = req.body as z.infer<typeof replaySchema>
    const replay = await eventEngineService.replayEvent(event_id)
    res.json({
      success: true,
      accepted: true,
      replay_id: replay.replayId,
    })
  })
)

export default router
