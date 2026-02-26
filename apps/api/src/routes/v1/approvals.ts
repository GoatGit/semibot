/**
 * Approvals API 路由
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import * as eventEngineService from '../../services/event-engine.service'

const router: Router = Router()

const listApprovalsQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'expired']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

const resolveApprovalSchema = z.object({
  reason: z.string().max(2000).optional(),
})

router.get(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('approvals:read'),
  validate(listApprovalsQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { status, limit } = req.query as z.infer<typeof listApprovalsQuerySchema>
    const items = await eventEngineService.listApprovals({ status, limit })
    res.json({
      success: true,
      items,
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
    const resolved = await eventEngineService.resolveApproval(req.params.id, 'approve', req.body.reason)
    if (!resolved) {
      res.status(404).json({
        success: false,
        error: {
          code: 'APPROVAL_NOT_FOUND',
          message: '审批记录不存在',
        },
      })
      return
    }

    res.json({
      success: true,
      id: resolved.id,
      status: resolved.status,
      resolved: true,
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
    const resolved = await eventEngineService.resolveApproval(req.params.id, 'reject', req.body.reason)
    if (!resolved) {
      res.status(404).json({
        success: false,
        error: {
          code: 'APPROVAL_NOT_FOUND',
          message: '审批记录不存在',
        },
      })
      return
    }

    res.json({
      success: true,
      id: resolved.id,
      status: resolved.status,
      resolved: true,
    })
  })
)

export default router
