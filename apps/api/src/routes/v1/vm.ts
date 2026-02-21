import { Router, type Response } from 'express'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import { forceRebootstrap, getUserVMStatus } from '../../scheduler/vm-scheduler'

const router: Router = Router()

router.get(
  '/status',
  authenticate,
  combinedRateLimit,
  requirePermission('sessions:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.userId
    const data = await getUserVMStatus(userId)
    res.json({ success: true, data })
  })
)

router.post(
  '/rebootstrap',
  authenticate,
  combinedRateLimit,
  requirePermission('sessions:write'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.userId
    const orgId = req.user!.orgId
    const data = await forceRebootstrap(userId, orgId)
    res.json({ success: true, data })
  })
)

export default router
