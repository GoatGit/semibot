/**
 * Skills API 路由
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import * as skillService from '../../services/skill.service'

const router: Router = Router()

// ═══════════════════════════════════════════════════════════════
// Schema 定义
// ═══════════════════════════════════════════════════════════════

const toolSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['function', 'mcp']),
  config: z.record(z.unknown()).optional(),
})

const createSkillSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  triggerKeywords: z.array(z.string().max(50)).max(20).optional(),
  tools: z.array(toolSchema).max(50).optional(),
  config: z
    .object({
      maxExecutionTime: z.number().min(1000).max(300000).optional(),
      retryAttempts: z.number().min(0).max(5).optional(),
      requiresApproval: z.boolean().optional(),
    })
    .optional(),
})

const updateSkillSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  triggerKeywords: z.array(z.string().max(50)).max(20).optional(),
  tools: z.array(toolSchema).max(50).optional(),
  config: z
    .object({
      maxExecutionTime: z.number().min(1000).max(300000).optional(),
      retryAttempts: z.number().min(0).max(5).optional(),
      requiresApproval: z.boolean().optional(),
    })
    .optional(),
  isActive: z.boolean().optional(),
})

const listSkillsQuerySchema = z.object({
  page: z.coerce.number().min(1).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  search: z.string().max(100).optional(),
  includeBuiltin: z
    .enum(['true', 'false'])
    .optional()
    .transform((val) => val !== 'false'),
})

// ═══════════════════════════════════════════════════════════════
// 路由
// ═══════════════════════════════════════════════════════════════

/**
 * POST /skills - 创建 Skill
 */
router.post(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('skills:write'),
  validate(createSkillSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const userId = req.user!.userId
    const input = req.body

    const skill = await skillService.createSkill(orgId, userId, input)

    res.status(201).json({
      success: true,
      data: skill,
    })
  })
)

/**
 * GET /skills - 列出 Skills
 */
router.get(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('skills:read'),
  validate(listSkillsQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const options = req.query

    const result = await skillService.listSkills(orgId, options)

    res.json({
      success: true,
      data: result.data,
      meta: result.meta,
    })
  })
)

/**
 * GET /skills/:id - 获取 Skill 详情
 */
router.get(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('skills:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const skillId = req.params.id

    const skill = await skillService.getSkill(orgId, skillId)

    res.json({
      success: true,
      data: skill,
    })
  })
)

/**
 * PUT /skills/:id - 更新 Skill
 */
router.put(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('skills:write'),
  validate(updateSkillSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const skillId = req.params.id
    const input = req.body

    const skill = await skillService.updateSkill(orgId, skillId, input)

    res.json({
      success: true,
      data: skill,
    })
  })
)

/**
 * DELETE /skills/:id - 删除 Skill
 */
router.delete(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('skills:write'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const skillId = req.params.id

    await skillService.deleteSkill(orgId, skillId)

    res.status(204).send()
  })
)

export default router
