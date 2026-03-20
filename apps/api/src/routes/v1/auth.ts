/**
 * Auth 路由
 *
 * 处理用户认证相关的 API 端点
 */

import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import * as authService from '../../services/auth.service'
import { authenticate, type AuthRequest } from '../../middleware/auth'
import { authRateLimit } from '../../middleware/rateLimit'
import { ERROR_HTTP_STATUS, ERROR_MESSAGES, VALIDATION_FAILED } from '../../constants/errorCodes'
import { authLogger } from '../../lib/logger'

const router: Router = Router()

// ═══════════════════════════════════════════════════════════════
// 请求验证 Schema
// ═══════════════════════════════════════════════════════════════

const registerSchema = z.object({
  email: z.string().email('邮箱格式无效'),
  password: z.string().min(8, '密码至少8位').max(100, '密码最长100位'),
  name: z.string().min(1, '姓名不能为空').max(100, '姓名最长100字符'),
  orgName: z.string().min(1, '组织名称不能为空').max(100, '组织名称最长100字符'),
})

const loginSchema = z.object({
  email: z.string().email('邮箱格式无效'),
  password: z.string().min(1, '密码不能为空'),
})

const refreshSchema = z.object({
  refreshToken: z.string().min(1, '刷新令牌不能为空'),
})

const forgotPasswordSchema = z.object({
  email: z.string().email('邮箱格式无效'),
})

const resetPasswordSchema = z.object({
  token: z.string().min(1, '重置令牌不能为空'),
  password: z.string().min(8, '密码至少8位').max(100, '密码最长100位'),
})

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

function handleError(res: Response, error: unknown): void {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: string }).code
    const status = ERROR_HTTP_STATUS[code] ?? 400
    const message = ERROR_MESSAGES[code] ?? '请求失败'

    res.status(status).json({
      success: false,
      error: { code, message },
    })
    return
  }

  authLogger.error('未预期的错误', error as Error)
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: '服务内部错误' },
  })
}

// ═══════════════════════════════════════════════════════════════
// 路由处理
// ═══════════════════════════════════════════════════════════════

/**
 * POST /auth/register
 * 用户注册
 */
router.post('/register', authRateLimit, async (req: Request, res: Response) => {
  try {
    const validation = registerSchema.safeParse(req.body)

    if (!validation.success) {
      res.status(400).json({
        success: false,
        error: {
          code: VALIDATION_FAILED,
          message: '数据校验失败',
          details: validation.error.errors.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        },
      })
      return
    }

    const { email, password, name, orgName } = validation.data

    const result = await authService.register({
      email,
      password,
      name,
      orgName,
    })

    res.status(201).json({
      success: true,
      data: {
        user: result.user,
        organization: result.organization,
        token: result.token,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
      },
    })
  } catch (error) {
    handleError(res, error)
  }
})

/**
 * POST /auth/login
 * 用户登录
 */
router.post('/login', authRateLimit, async (req: Request, res: Response) => {
  try {
    const validation = loginSchema.safeParse(req.body)

    if (!validation.success) {
      res.status(400).json({
        success: false,
        error: {
          code: VALIDATION_FAILED,
          message: '数据校验失败',
          details: validation.error.errors.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        },
      })
      return
    }

    const { email, password } = validation.data

    const result = await authService.login({ email, password })

    res.json({
      success: true,
      data: {
        user: result.user,
        token: result.token,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
      },
    })
  } catch (error) {
    handleError(res, error)
  }
})

/**
 * POST /auth/refresh
 * 刷新 Token
 */
router.post('/refresh', authRateLimit, async (req: Request, res: Response) => {
  try {
    const validation = refreshSchema.safeParse(req.body)

    if (!validation.success) {
      res.status(400).json({
        success: false,
        error: {
          code: VALIDATION_FAILED,
          message: '数据校验失败',
          details: validation.error.errors.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        },
      })
      return
    }

    const { refreshToken } = validation.data

    const result = await authService.refreshToken(refreshToken)

    res.json({
      success: true,
      data: {
        user: result.user,
        token: result.token,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
      },
    })
  } catch (error) {
    handleError(res, error)
  }
})

/**
 * POST /auth/forgot-password
 * 请求重置密码邮件
 */
router.post('/forgot-password', authRateLimit, async (req: Request, res: Response) => {
  try {
    const validation = forgotPasswordSchema.safeParse(req.body)

    if (!validation.success) {
      res.status(400).json({
        success: false,
        error: {
          code: VALIDATION_FAILED,
          message: '数据校验失败',
          details: validation.error.errors.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        },
      })
      return
    }

    await authService.requestPasswordReset(validation.data.email)

    res.json({
      success: true,
      data: {
        message: '如果邮箱存在，重置链接已发送',
      },
    })
  } catch (error) {
    handleError(res, error)
  }
})

/**
 * POST /auth/reset-password
 * 使用重置令牌设置新密码
 */
router.post('/reset-password', authRateLimit, async (req: Request, res: Response) => {
  try {
    const validation = resetPasswordSchema.safeParse(req.body)

    if (!validation.success) {
      res.status(400).json({
        success: false,
        error: {
          code: VALIDATION_FAILED,
          message: '数据校验失败',
          details: validation.error.errors.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        },
      })
      return
    }

    await authService.resetPassword(validation.data.token, validation.data.password)

    res.json({
      success: true,
      data: {
        message: '密码重置成功',
      },
    })
  } catch (error) {
    handleError(res, error)
  }
})

/**
 * POST /auth/logout
 * 用户登出
 */
router.post('/logout', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { refreshToken } = req.body ?? {}
    await authService.logout(req.user!.userId, req.token, refreshToken)

    res.json({
      success: true,
      data: {
        message: '已成功登出',
      },
    })
  } catch (error) {
    handleError(res, error)
  }
})

export default router
