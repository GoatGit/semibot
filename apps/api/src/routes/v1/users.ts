/**
 * Users API 路由
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import * as userService from '../../services/user.service'

const router: Router = Router()

const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  avatarUrl: z.string().url().max(500).optional(),
})

const updatePreferencesSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']).optional(),
  language: z.enum(['zh-CN', 'en-US']).optional(),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
})

/**
 * GET /users/me - 获取当前用户资料
 */
router.get(
  '/me',
  authenticate,
  combinedRateLimit,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = await userService.getUserProfile(req.user!.userId)
    res.json({
      success: true,
      data: user,
    })
  })
)

/**
 * PATCH /users/me - 更新当前用户资料
 */
router.patch(
  '/me',
  authenticate,
  combinedRateLimit,
  validate(updateProfileSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = await userService.updateUserProfile(req.user!.userId, req.body)
    res.json({
      success: true,
      data: user,
    })
  })
)

/**
 * GET /users/preferences - 获取当前用户偏好
 */
router.get(
  '/preferences',
  authenticate,
  combinedRateLimit,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const preferences = await userService.getUserPreferences(req.user!.userId)
    res.json({
      success: true,
      data: preferences,
    })
  })
)

/**
 * PATCH /users/preferences - 更新当前用户偏好
 */
router.patch(
  '/preferences',
  authenticate,
  combinedRateLimit,
  validate(updatePreferencesSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const preferences = await userService.updateUserPreferences(req.user!.userId, req.body)
    res.json({
      success: true,
      data: preferences,
    })
  })
)

/**
 * PUT /users/me/password - 修改密码
 */
router.put(
  '/me/password',
  authenticate,
  combinedRateLimit,
  validate(changePasswordSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await userService.changePassword(
      req.user!.userId,
      req.body.currentPassword,
      req.body.newPassword
    )
    res.json({
      success: true,
      data: null,
    })
  })
)

export default router
