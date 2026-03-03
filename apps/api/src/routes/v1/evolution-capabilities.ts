import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import * as evolutionCapabilityService from '../../services/evolution-capability.service'

const router: Router = Router()

const capabilityTypeSchema = z.enum(['hands', 'reflex', 'spine', 'guard', 'mind'])

const updateCapabilitySchema = z.object({
  content: z.string().max(200000),
  changeNote: z.string().max(1000).optional(),
})

const switchCapabilitySchema = z.object({
  targetVersion: z.string().min(2).max(32),
  reason: z.string().max(1000).optional(),
})

const versionsQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).optional(),
})

router.get(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const userId = req.user?.userId
    const docs = await evolutionCapabilityService.getActiveCapabilities(orgId, userId)
    res.json({ success: true, data: docs })
  })
)

router.get(
  '/:capabilityType/versions',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:read'),
  validate(versionsQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const capabilityType = capabilityTypeSchema.parse(req.params.capabilityType)
    const { limit } = req.query as z.infer<typeof versionsQuerySchema>
    const docs = await evolutionCapabilityService.getCapabilityVersions(orgId, capabilityType, limit ?? 20)
    res.json({ success: true, data: docs })
  })
)

router.put(
  '/:capabilityType',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:write'),
  validate(updateCapabilitySchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const userId = req.user!.userId
    const capabilityType = capabilityTypeSchema.parse(req.params.capabilityType)
    const doc = await evolutionCapabilityService.updateCapability(
      orgId,
      userId,
      capabilityType,
      req.body.content,
      req.body.changeNote
    )
    res.json({ success: true, data: doc })
  })
)

router.post(
  '/:capabilityType/switch',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:write'),
  validate(switchCapabilitySchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.orgId
    const userId = req.user!.userId
    const capabilityType = capabilityTypeSchema.parse(req.params.capabilityType)
    const doc = await evolutionCapabilityService.switchCapabilityVersion(
      orgId,
      userId,
      capabilityType,
      req.body.targetVersion,
      req.body.reason
    )
    res.json({ success: true, data: doc })
  })
)

export default router

