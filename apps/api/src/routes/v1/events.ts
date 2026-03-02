/**
 * Events API 路由
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, errors, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import { runtimeRequest } from '../../lib/runtime-client'
import * as eventEngineService from '../../services/event-engine.service'

const router: Router = Router()

const listEventsQuerySchema = z.object({
  type: z.string().max(120).optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
})

const replaySchema = z.object({
  event_id: z.string().min(1),
})

const stringMapSchema = z.record(z.string().min(1).max(120), z.string().min(1).max(120))

const updatePresentationSchema = z.object({
  eventTypeLabels: stringMapSchema.optional(),
  categoryLabels: stringMapSchema.optional(),
  actionLabels: stringMapSchema.optional(),
})

router.get(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('events:read'),
  validate(listEventsQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { type, limit } = req.query as z.infer<typeof listEventsQuerySchema>
    const payload = await runtimeRequest<{ items?: unknown[]; next_cursor?: string | null }>('/v1/events', {
      method: 'GET',
      query: {
        event_type: type,
        limit,
      },
      timeoutMs: 4000,
    })
    const items = Array.isArray(payload.items) ? payload.items : []
    res.json({
      success: true,
      items,
      next_cursor: payload.next_cursor ?? null,
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
    const replay = await runtimeRequest<{ event_id?: string; matched_rules?: number; outcomes?: unknown[] }>(
      '/v1/events/replay',
      {
        method: 'POST',
        body: { event_id },
        timeoutMs: 5000,
      }
    )
    res.json({
      success: true,
      accepted: true,
      replay_id: replay.event_id || event_id,
      matched_rules: replay.matched_rules ?? 0,
      outcomes: Array.isArray(replay.outcomes) ? replay.outcomes : [],
    })
  })
)

router.get(
  '/presentation',
  authenticate,
  combinedRateLimit,
  requirePermission('events:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const dictionary = await eventEngineService.getEventPresentationDictionary(req.user!.orgId)
    res.json({
      success: true,
      data: dictionary,
    })
  })
)

router.put(
  '/presentation',
  authenticate,
  combinedRateLimit,
  requirePermission('events:write'),
  validate(updatePresentationSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (req.user!.role !== 'owner' && req.user!.role !== 'admin') {
      throw errors.forbidden('仅 owner/admin 可更新事件展示字典')
    }

    const payload = req.body as z.infer<typeof updatePresentationSchema>
    const dictionary = await eventEngineService.updateEventPresentationDictionary(req.user!.orgId, payload)
    res.json({
      success: true,
      data: dictionary,
    })
  })
)

export default router
