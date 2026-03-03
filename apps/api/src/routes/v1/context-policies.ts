import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import * as contextPolicyService from '../../services/context-policy.service'

const router: Router = Router()
const CONTEXT_POLICIES_SUNSET = 'Tue, 30 Jun 2026 00:00:00 GMT'

function applyDeprecationHeaders(res: Response): void {
  res.setHeader('Deprecation', 'true')
  res.setHeader('Sunset', CONTEXT_POLICIES_SUNSET)
  res.setHeader('Link', '</api/v1/evolution-capabilities>; rel="successor-version"')
  res.setHeader(
    'Warning',
    '299 Semibot API "/api/v1/context-policies" is deprecated. Please migrate to "/api/v1/evolution-capabilities".'
  )
}

const docTypeSchema = z.enum(['gene', 'agents', 'tools'])

const updatePolicySchema = z.object({
  content: z.string().max(200000),
  changeNote: z.string().max(1000).optional(),
})

const rollbackPolicySchema = z.object({
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
    applyDeprecationHeaders(res)
    const orgId = req.user!.orgId
    const docs = await contextPolicyService.getActivePolicies(orgId)
    res.json({ success: true, data: docs })
  })
)

router.get(
  '/:docType/versions',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:read'),
  validate(versionsQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    applyDeprecationHeaders(res)
    const orgId = req.user!.orgId
    const docType = docTypeSchema.parse(req.params.docType)
    const { limit } = req.query as z.infer<typeof versionsQuerySchema>
    const docs = await contextPolicyService.getPolicyVersions(orgId, docType, limit ?? 20)
    res.json({ success: true, data: docs })
  })
)

router.put(
  '/:docType',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:write'),
  validate(updatePolicySchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    applyDeprecationHeaders(res)
    const orgId = req.user!.orgId
    const userId = req.user!.userId
    const docType = docTypeSchema.parse(req.params.docType)
    const doc = await contextPolicyService.updatePolicy(
      orgId,
      userId,
      docType,
      req.body.content,
      req.body.changeNote
    )
    res.json({ success: true, data: doc })
  })
)

router.post(
  '/:docType/rollback',
  authenticate,
  combinedRateLimit,
  requirePermission('tools:write'),
  validate(rollbackPolicySchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    applyDeprecationHeaders(res)
    const orgId = req.user!.orgId
    const userId = req.user!.userId
    const docType = docTypeSchema.parse(req.params.docType)
    const doc = await contextPolicyService.rollbackPolicy(
      orgId,
      userId,
      docType,
      req.body.targetVersion,
      req.body.reason
    )
    res.json({ success: true, data: doc })
  })
)

export default router
