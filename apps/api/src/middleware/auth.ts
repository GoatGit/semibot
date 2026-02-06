/**
 * 认证中间件
 *
 * 支持 API Key 和 JWT 两种认证方式
 */

import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import {
  AUTH_TOKEN_MISSING,
  AUTH_TOKEN_INVALID,
  AUTH_TOKEN_EXPIRED,
  AUTH_API_KEY_INVALID,
  AUTH_PERMISSION_DENIED,
  ERROR_HTTP_STATUS,
  ERROR_MESSAGES,
} from '../constants/errorCodes'
import { API_KEY_PREFIX } from '../constants/config'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface AuthUser {
  userId: string
  orgId: string
  role: 'owner' | 'admin' | 'member' | 'api_service'
  permissions: string[]
}

export interface AuthRequest extends Request {
  user?: AuthUser
}

interface JWTPayload {
  userId: string
  orgId: string
  role: string
  permissions: string[]
  iat: number
  exp: number
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 获取 JWT Secret
 * 生产环境必须设置 JWT_SECRET 环境变量
 */
function getJWTSecret(): string {
  const secret = process.env.JWT_SECRET

  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('[Auth] 生产环境必须设置 JWT_SECRET 环境变量')
  }

  if (!secret) {
    console.warn('[Auth] 未设置 JWT_SECRET，使用开发环境默认值（请勿用于生产）')
  }

  return secret ?? 'development-secret-change-in-production'
}

const JWT_SECRET = getJWTSecret()

/**
 * 发送认证错误响应
 */
function sendAuthError(res: Response, code: string): void {
  const status = ERROR_HTTP_STATUS[code] ?? 401
  const message = ERROR_MESSAGES[code] ?? '认证失败'

  res.status(status).json({
    success: false,
    error: { code, message },
  })
}

/**
 * 从请求头提取 Token
 */
function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization

  if (!authHeader) {
    return null
  }

  // Bearer Token
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }

  return null
}

/**
 * 验证 API Key (查询数据库)
 */
async function validateApiKey(
  apiKey: string
): Promise<{ valid: boolean; user?: AuthUser; error?: string }> {
  // API Key 格式检查
  if (!apiKey.startsWith(API_KEY_PREFIX)) {
    return { valid: false, error: AUTH_API_KEY_INVALID }
  }

  // 开发环境快捷测试 Key
  if (process.env.NODE_ENV === 'development' && apiKey === 'sk-dev-test-key') {
    return {
      valid: true,
      user: {
        userId: 'dev-user-id',
        orgId: 'dev-org-id',
        role: 'api_service',
        permissions: ['*'],
      },
    }
  }

  try {
    // 动态导入以避免循环依赖
    const { validateApiKey: validateApiKeyFromDb } = await import('../services/api-keys.service')
    const result = await validateApiKeyFromDb(apiKey)

    if (!result) {
      return { valid: false, error: AUTH_API_KEY_INVALID }
    }

    return {
      valid: true,
      user: {
        userId: result.userId,
        orgId: result.orgId,
        role: 'api_service',
        permissions: result.permissions,
      },
    }
  } catch (error) {
    console.error('[Auth] API Key 验证失败:', error)
    return { valid: false, error: AUTH_API_KEY_INVALID }
  }
}

/**
 * 验证 JWT Token
 */
function validateJWT(token: string): { valid: boolean; user?: AuthUser; error?: string } {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JWTPayload

    return {
      valid: true,
      user: {
        userId: decoded.userId,
        orgId: decoded.orgId,
        role: decoded.role as AuthUser['role'],
        permissions: decoded.permissions,
      },
    }
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return { valid: false, error: AUTH_TOKEN_EXPIRED }
    }
    return { valid: false, error: AUTH_TOKEN_INVALID }
  }
}

/**
 * 检查 Token 是否在黑名单中
 */
async function checkTokenBlacklist(token: string): Promise<boolean> {
  try {
    const { isBlacklisted } = await import('../services/auth.service')
    return isBlacklisted(token)
  } catch (error) {
    console.error('[Auth] 黑名单检查失败:', error)
    return false
  }
}

// ═══════════════════════════════════════════════════════════════
// 中间件
// ═══════════════════════════════════════════════════════════════

/**
 * 认证中间件 - 验证请求的身份
 *
 * 支持:
 * - API Key: Authorization: Bearer sk-xxx
 * - JWT: Authorization: Bearer eyJxxx
 */
export function authenticate(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = extractToken(req)

  if (!token) {
    sendAuthError(res, AUTH_TOKEN_MISSING)
    return
  }

  // 判断是 API Key 还是 JWT
  if (token.startsWith(API_KEY_PREFIX)) {
    // API Key 认证
    validateApiKey(token)
      .then((result) => {
        if (!result.valid || !result.user) {
          sendAuthError(res, result.error ?? AUTH_API_KEY_INVALID)
          return
        }

        req.user = result.user
        next()
      })
      .catch(() => {
        sendAuthError(res, AUTH_API_KEY_INVALID)
      })
  } else {
    // JWT 认证 - 先检查黑名单，再验证 Token
    checkTokenBlacklist(token)
      .then((isBlacklisted) => {
        if (isBlacklisted) {
          console.warn('[Auth] Token 已被加入黑名单')
          sendAuthError(res, AUTH_TOKEN_INVALID)
          return
        }

        const result = validateJWT(token)

        if (!result.valid || !result.user) {
          sendAuthError(res, result.error ?? AUTH_TOKEN_INVALID)
          return
        }

        req.user = result.user
        next()
      })
      .catch(() => {
        // 黑名单检查失败时，继续验证 Token (降级处理)
        const result = validateJWT(token)

        if (!result.valid || !result.user) {
          sendAuthError(res, result.error ?? AUTH_TOKEN_INVALID)
          return
        }

        req.user = result.user
        next()
      })
  }
}

/**
 * 可选认证中间件 - 如果有 Token 则验证，没有则跳过
 */
export function optionalAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = extractToken(req)

  if (!token) {
    next()
    return
  }

  // 有 Token 时进行验证
  authenticate(req, res, next)
}

/**
 * 权限检查中间件工厂
 *
 * @param requiredPermissions 需要的权限列表 (任一匹配即可)
 */
export function requirePermission(...requiredPermissions: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    const user = req.user

    if (!user) {
      sendAuthError(res, AUTH_TOKEN_MISSING)
      return
    }

    // 检查是否有通配符权限
    if (user.permissions.includes('*')) {
      next()
      return
    }

    // 检查是否有任一所需权限
    const hasPermission = requiredPermissions.some((perm) => {
      // 支持通配符匹配: agents:* 匹配 agents:read
      return user.permissions.some((userPerm) => {
        if (userPerm === perm) return true
        if (userPerm.endsWith(':*')) {
          const prefix = userPerm.slice(0, -1)
          return perm.startsWith(prefix)
        }
        return false
      })
    })

    if (!hasPermission) {
      console.warn(
        `[Auth] 权限不足 - 用户: ${user.userId}, 需要: ${requiredPermissions.join('|')}, 拥有: ${user.permissions.join(',')}`
      )
      sendAuthError(res, AUTH_PERMISSION_DENIED)
      return
    }

    next()
  }
}

/**
 * 角色检查中间件工厂
 *
 * @param allowedRoles 允许的角色列表
 */
export function requireRole(...allowedRoles: AuthUser['role'][]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    const user = req.user

    if (!user) {
      sendAuthError(res, AUTH_TOKEN_MISSING)
      return
    }

    if (!allowedRoles.includes(user.role)) {
      console.warn(
        `[Auth] 角色不足 - 用户: ${user.userId}, 需要: ${allowedRoles.join('|')}, 拥有: ${user.role}`
      )
      sendAuthError(res, AUTH_PERMISSION_DENIED)
      return
    }

    next()
  }
}

/**
 * 生成 JWT Token (用于登录)
 */
export function generateToken(user: AuthUser): string {
  const payload: Omit<JWTPayload, 'iat' | 'exp'> = {
    userId: user.userId,
    orgId: user.orgId,
    role: user.role,
    permissions: user.permissions,
  }

  return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' })
}

/**
 * 生成 API Key (用于创建 API Key)
 */
export async function generateApiKey(): Promise<{ key: string; hash: string; prefix: string }> {
  const { randomBytes } = await import('crypto')
  const keyBytes = randomBytes(32)
  const key = `${API_KEY_PREFIX}${keyBytes.toString('base64url')}`
  const prefix = key.slice(0, 10)
  const hash = await bcrypt.hash(key, 12)

  return { key, hash, prefix }
}
