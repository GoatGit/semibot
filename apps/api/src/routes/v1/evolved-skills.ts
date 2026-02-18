/**
 * Evolved Skills API 路由
 *
 * 进化技能管理端点
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import * as evolvedSkillService from '../../services/evolved-skill.service'

const router: Router = Router()

// ═══════════════════════════════════════════════════════════════
// Schema 定义
// ═══════════════════════════════════════════════════════════════

const listEvolvedSkillsQuerySchema = z.object({
  status: z.enum([
    'pending_review', 'approved', 'rejected', 'auto_approved', 'deprecated',
  ]).optional(),
  agentId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  page: z.coerce.number().int().min(1).default(1),
})

const reviewEvolvedSkillSchema = z.object({
  action: z.enum(['approve', 'reject']),
  comment: z.string().max(1000).optional(),
})

// ═══════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════

// 1. 列出进化技能
router.get(
  '/',
  authenticate,
  combinedRateLimit,
  validate(listEvolvedSkillsQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { orgId } = req.user!
    const { status, agentId, limit, page } = req.query as Record<string, string>
    const result = await evolvedSkillService.list(orgId, {
      status,
      agentId,
      limit: limit ? parseInt(limit, 10) : undefined,
      page: page ? parseInt(page, 10) : undefined,
    })
    res.json({ success: true, data: result.data, meta: result.meta })
  })
)

// 2. 获取进化技能详情
router.get(
  '/:id',
  authenticate,
  combinedRateLimit,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { orgId } = req.user!
    const skill = await evolvedSkillService.getById(req.params.id, orgId)
    res.json({ success: true, data: skill })
  })
)

// 3. 审核进化技能
router.post(
  '/:id/review',
  authenticate,
  combinedRateLimit,
  validate(reviewEvolvedSkillSchema),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { orgId, userId } = req.user!
    const skill = await evolvedSkillService.review(
      req.params.id, orgId, userId, req.body
    )
    res.json({ success: true, data: skill })
  })
)

// 4. 废弃进化技能
router.delete(
  '/:id',
  authenticate,
  combinedRateLimit,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { orgId, userId } = req.user!
    await evolvedSkillService.deprecate(req.params.id, orgId, userId)
    res.json({ success: true, data: null })
  })
)

// 5. 提升为正式技能
router.post(
  '/:id/promote',
  authenticate,
  combinedRateLimit,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { orgId, userId } = req.user!
    const skill = await evolvedSkillService.promote(req.params.id, orgId, userId)
    res.json({ success: true, data: skill })
  })
)

export default router
