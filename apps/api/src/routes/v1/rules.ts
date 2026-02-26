/**
 * Rules API 路由
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import * as eventEngineService from '../../services/event-engine.service'

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
})

router.get(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('rules:read'),
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    const items = await eventEngineService.listRules()
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
    const created = await eventEngineService.createRule({
      name: body.name,
      eventType: body.event_type,
      conditions: body.conditions,
      actionMode: body.action_mode,
      actions: body.actions.map((item) => ({
        actionType: item.action_type,
        params: item.params,
      })),
      riskLevel: body.risk_level,
      priority: body.priority,
      dedupeWindowSeconds: body.dedupe_window_seconds,
      cooldownSeconds: body.cooldown_seconds,
      attentionBudgetPerDay: body.attention_budget_per_day,
      isActive: body.is_active,
    })
    res.status(201).json({
      success: true,
      id: created.id,
      created: true,
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
    const updated = await eventEngineService.updateRule(req.params.id, {
      name: body.name,
      eventType: body.event_type,
      conditions: body.conditions,
      actionMode: body.action_mode,
      actions: body.actions?.map((item) => ({
        actionType: item.action_type,
        params: item.params,
      })),
      riskLevel: body.risk_level,
      priority: body.priority,
      dedupeWindowSeconds: body.dedupe_window_seconds,
      cooldownSeconds: body.cooldown_seconds,
      attentionBudgetPerDay: body.attention_budget_per_day,
      isActive: body.is_active,
    })

    if (!updated) {
      res.status(404).json({
        success: false,
        error: {
          code: 'RULE_NOT_FOUND',
          message: '规则不存在',
        },
      })
      return
    }

    res.json({
      success: true,
      data: updated,
    })
  })
)

export default router
