/**
 * Auth 路由
 *
 * 处理用户认证相关的 API 端点
 */

import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import * as authService from '../../services/auth.service'
import { authenticate, type AuthRequest } from '../../middleware/auth'
import { ERROR_HTTP_STATUS, ERROR_MESSAGES, VALIDATION_FAILED } from '../../constants/errorCodes'

const router: Router = Router()

// ═══════════════════════════════════════════════════════════════
// 请求验证 Schema
// ═══════════════════════════════════════════════════════════════

const registerSchema = z.object({
  email: z.string().email('邮箱格式无效'),
  password: z.string().min(8, '密码至少8位').max(100, '密码最长100位'),
  name: z.string().min(1, '姓名不能为空').max(100, '姓名最长100字符'),
  org_name: z.string().min(1, '组织名称不能为空').max(100, '组织名称最长100字符'),
})

const loginSchema = z.object({
  email: z.string().email('邮箱格式无效'),
  password: z.string().min(1, '密码不能为空'),
})

const refreshSchema = z.object({
  refresh_token: z.string().min(1, '刷新令牌不能为空'),
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

  console.error('[Auth] 未预期的错误:', error)
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
router.post('/register', async (req: Request, res: Response) => {
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

    const { email, password, name, org_name } = validation.data

    const result = await authService.register({
      email,
      password,
      name,
      orgName: org_name,
    })

    res.status(201).json({
      success: true,
      data: {
        user: result.user,
        organization: result.organization,
        token: result.token,
        refresh_token: result.refreshToken,
        expires_at: result.expiresAt,
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
router.post('/login', async (req: Request, res: Response) => {
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
        refresh_token: result.refreshToken,
        expires_at: result.expiresAt,
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
router.post('/refresh', async (req: Request, res: Response) => {
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

    const { refresh_token } = validation.data

    const result = await authService.refreshToken(refresh_token)

    res.json({
      success: true,
      data: {
        user: result.user,
        token: result.token,
        refresh_token: result.refreshToken,
        expires_at: result.expiresAt,
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
    await authService.logout(req.user!.userId)

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
