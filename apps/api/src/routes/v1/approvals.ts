/**
 * Approvals API 路由
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import { runtimeRequest } from '../../lib/runtime-client'
import { resolveApprovalAndMaybeResume } from '../../services/chat.service'

const router: Router = Router()

const listApprovalsQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'expired']).optional(),
  capability: z.string().max(240).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

const resolveApprovalSchema = z.object({
  reason: z.string().max(2000).optional(),
})

function readCapabilityId(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return ''
  const row = raw as Record<string, unknown>
  const direct = typeof row.capabilityId === 'string' ? row.capabilityId.trim() : ''
  if (direct) return direct
  return typeof row.capability_id === 'string' ? row.capability_id.trim() : ''
}

router.get(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('approvals:read'),
  validate(listApprovalsQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { status, capability, limit } = req.query as z.infer<typeof listApprovalsQuerySchema>
    const payload = await runtimeRequest<{ items?: unknown[] }>('/v1/approvals', {
      method: 'GET',
      query: { status, capability_id: capability, limit: limit ?? 50 },
    })
    const items = Array.isArray(payload.items) ? payload.items : []
    const capabilityNeedle = typeof capability === 'string' ? capability.trim().toLowerCase() : ''
    const filteredItems = capabilityNeedle
      ? items.filter((item) => readCapabilityId(item).toLowerCase().includes(capabilityNeedle))
      : items
    res.json({
      success: true,
      items: filteredItems,
    })
  })
)

router.post(
  '/:id/approve',
  authenticate,
  combinedRateLimit,
  requirePermission('approvals:write'),
  validate(resolveApprovalSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const resolved = await resolveApprovalAndMaybeResume(req.params.id, 'approve')

    res.json({
      success: true,
      id: resolved.approvalId,
      status: resolved.status,
      resolved: true,
      resumed: resolved.resumed,
      sessionId: resolved.sessionId,
      attemptId: resolved.attemptId,
      userMessageId: resolved.userMessageId,
      assistantMessageId: resolved.assistantMessageId,
    })
  })
)

router.post(
  '/:id/reject',
  authenticate,
  combinedRateLimit,
  requirePermission('approvals:write'),
  validate(resolveApprovalSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const resolved = await resolveApprovalAndMaybeResume(req.params.id, 'reject')

    res.json({
      success: true,
      id: resolved.approvalId,
      status: resolved.status,
      resolved: true,
      resumed: resolved.resumed,
      attemptId: resolved.attemptId,
      userMessageId: resolved.userMessageId,
    })
  })
)

export default router
