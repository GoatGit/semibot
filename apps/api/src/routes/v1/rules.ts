/**
 * Rules API 路由
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import { runtimeRequest } from '../../lib/runtime-client'

const router: Router = Router()

const createRuleSchema = z.object({
  name: z.string().min(1).max(120),
  event_type: z.string().min(1).max(160),
  conditions: z.record(z.unknown()).optional(),
  action_mode: z.enum(['ask', 'suggest', 'auto', 'skip']),
  actions: z.array(
    z.object({
      action_type: z.string().min(1).max(80),
      params: z.record(z.unknown()).optional(),
    })
  ).min(1),
  risk_level: z.enum(['low', 'medium', 'high']),
  priority: z.number().int().min(0).max(1000).default(50),
  dedupe_window_seconds: z.number().int().min(0).max(86400).default(300),
  cooldown_seconds: z.number().int().min(0).max(86400).default(600),
  attention_budget_per_day: z.number().int().min(0).max(10000).default(10),
  is_active: z.boolean().default(true),
  cron: z.object({
    upsert: z.boolean().optional(),
    name: z.string().min(1).max(120).optional(),
    schedule: z.string().min(1).max(120).optional(),
    event_type: z.string().min(1).max(160).optional(),
    source: z.string().min(1).max(160).optional(),
    subject: z.string().max(160).optional(),
    payload: z.record(z.unknown()).optional(),
  }).optional(),
})

const updateRuleSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  event_type: z.string().min(1).max(160).optional(),
  conditions: z.record(z.unknown()).optional(),
  action_mode: z.enum(['ask', 'suggest', 'auto', 'skip']).optional(),
  actions: z.array(
    z.object({
      action_type: z.string().min(1).max(80),
      params: z.record(z.unknown()).optional(),
    })
  ).min(1).optional(),
  risk_level: z.enum(['low', 'medium', 'high']).optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  dedupe_window_seconds: z.number().int().min(0).max(86400).optional(),
  cooldown_seconds: z.number().int().min(0).max(86400).optional(),
  attention_budget_per_day: z.number().int().min(0).max(10000).optional(),
  is_active: z.boolean().optional(),
  cron: z.object({
    upsert: z.boolean().optional(),
    name: z.string().min(1).max(120).optional(),
    schedule: z.string().min(1).max(120).optional(),
    event_type: z.string().min(1).max(160).optional(),
    source: z.string().min(1).max(160).optional(),
    subject: z.string().max(160).optional(),
    payload: z.record(z.unknown()).optional(),
  }).optional(),
})

router.get(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('rules:read'),
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    const payload = await runtimeRequest<{ items?: unknown[]; data?: unknown[] }>('/v1/rules')
    const items = Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.data)
        ? payload.data
        : []
    res.json({
      success: true,
      items,
    })
  })
)

router.post(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('rules:write'),
  validate(createRuleSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = req.body as z.infer<typeof createRuleSchema>
    const created = await runtimeRequest<Record<string, unknown>>('/v1/rules', {
      method: 'POST',
      body: {
        name: body.name,
        event_type: body.event_type,
        conditions: body.conditions,
        action_mode: body.action_mode,
        actions: body.actions,
        risk_level: body.risk_level,
        priority: body.priority,
        dedupe_window_seconds: body.dedupe_window_seconds,
        cooldown_seconds: body.cooldown_seconds,
        attention_budget_per_day: body.attention_budget_per_day,
        is_active: body.is_active,
        cron: body.cron,
      },
    })
    res.status(201).json({
      success: true,
      id: String(created.id || ''),
      created: true,
      data: created,
    })
  })
)

router.put(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('rules:write'),
  validate(updateRuleSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = req.body as z.infer<typeof updateRuleSchema>
    const updated = await runtimeRequest<Record<string, unknown>>(`/v1/rules/${encodeURIComponent(req.params.id)}`, {
      method: 'PUT',
      body: {
        name: body.name,
        event_type: body.event_type,
        conditions: body.conditions,
        action_mode: body.action_mode,
        actions: body.actions,
        risk_level: body.risk_level,
        priority: body.priority,
        dedupe_window_seconds: body.dedupe_window_seconds,
        cooldown_seconds: body.cooldown_seconds,
        attention_budget_per_day: body.attention_budget_per_day,
        is_active: body.is_active,
        cron: body.cron,
      },
    })

    res.json({
      success: true,
      data: updated,
    })
  })
)

router.delete(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('rules:write'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const result = await runtimeRequest<Record<string, unknown>>(`/v1/rules/${encodeURIComponent(req.params.id)}`, {
      method: 'DELETE',
    })
    res.json({
      success: true,
      removed: Boolean(result.removed ?? true),
      data: result,
    })
  })
)

export default router
