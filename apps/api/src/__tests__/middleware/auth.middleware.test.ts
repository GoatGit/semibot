/**
 * Auth Middleware Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import {
  authenticate,
  optionalAuth,
  requirePermission,
  requireRole,
  generateToken,
  type AuthRequest,
  type AuthUser,
} from '../../middleware/auth'

// Mock dependencies
vi.mock('../../lib/logger', () => ({
  authLogger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('../../services/auth.service', () => ({
  isBlacklisted: vi.fn().mockResolvedValue(false),
}))

vi.mock('../../services/api-keys.service', () => ({
  validateApiKey: vi.fn().mockResolvedValue(null),
}))

const JWT_SECRET = process.env.JWT_SECRET ?? 'development-secret-change-in-production'

describe('Auth Middleware', () => {
  let mockReq: Partial<AuthRequest>
  let mockRes: Partial<Response>
  let mockNext: NextFunction

  beforeEach(() => {
    process.env.SEMIBOT_ENABLE_AUTH = 'true'

    mockReq = {
      headers: {},
    }
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    }
    mockNext = vi.fn()
  })

  afterEach(() => {
    delete process.env.SEMIBOT_ENABLE_AUTH
    vi.clearAllMocks()
  })

  describe('authenticate', () => {
    it('应该拒绝无 Token 的请求', () => {
      authenticate(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(401)
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'AUTH_TOKEN_MISSING',
          }),
        })
      )
      expect(mockNext).not.toHaveBeenCalled()
    })

    it('应该拒绝无效格式的 Authorization 头', () => {
      mockReq.headers = { authorization: 'Invalid format' }

      authenticate(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(401)
      expect(mockNext).not.toHaveBeenCalled()
    })

    it('应该拒绝无效 JWT Token', async () => {
      mockReq.headers = { authorization: 'Bearer invalid-token' }

      authenticate(mockReq as AuthRequest, mockRes as Response, mockNext)

      // 等待异步操作完成
      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(mockRes.status).toHaveBeenCalledWith(401)
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'AUTH_TOKEN_INVALID',
          }),
        })
      )
      expect(mockNext).not.toHaveBeenCalled()
    })

    it('应该拒绝过期 JWT Token', async () => {
      const expiredToken = jwt.sign(
        { userId: 'user-1', orgId: 'org-1', role: 'member', permissions: [] },
        JWT_SECRET,
        { expiresIn: '-1h' }
      )
      mockReq.headers = { authorization: `Bearer ${expiredToken}` }

      authenticate(mockReq as AuthRequest, mockRes as Response, mockNext)

      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(mockRes.status).toHaveBeenCalledWith(401)
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'AUTH_TOKEN_EXPIRED',
          }),
        })
      )
    })

    it('应该接受有效 JWT Token 并设置 req.user', async () => {
      const validToken = jwt.sign(
        { userId: 'user-1', orgId: 'org-1', role: 'member', permissions: ['read'] },
        JWT_SECRET,
        { expiresIn: '1h' }
      )
      mockReq.headers = { authorization: `Bearer ${validToken}` }

      authenticate(mockReq as AuthRequest, mockRes as Response, mockNext)

      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(mockNext).toHaveBeenCalled()
      expect(mockReq.user).toBeDefined()
      expect(mockReq.user?.userId).toBe('user-1')
      expect(mockReq.user?.orgId).toBe('org-1')
    })
  })

  describe('optionalAuth', () => {
    it('无 Token 时应该继续处理请求', () => {
      optionalAuth(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
      expect(mockReq.user).toBeUndefined()
    })

    it('有有效 Token 时应该设置 req.user', async () => {
      const validToken = jwt.sign(
        { userId: 'user-1', orgId: 'org-1', role: 'member', permissions: [] },
        JWT_SECRET,
        { expiresIn: '1h' }
      )
      mockReq.headers = { authorization: `Bearer ${validToken}` }

      optionalAuth(mockReq as AuthRequest, mockRes as Response, mockNext)

      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(mockNext).toHaveBeenCalled()
      expect(mockReq.user).toBeDefined()
    })
  })

  describe('requirePermission', () => {
    it('无用户时应该返回错误', () => {
      const middleware = requirePermission('agents:read')
      middleware(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(401)
      expect(mockNext).not.toHaveBeenCalled()
    })

    it('有通配符权限时应该允许', () => {
      mockReq.user = {
        userId: 'user-1',
        orgId: 'org-1',
        role: 'admin',
        permissions: ['*'],
      }

      const middleware = requirePermission('agents:read')
      middleware(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
    })

    it('有精确权限时应该允许', () => {
      mockReq.user = {
        userId: 'user-1',
        orgId: 'org-1',
        role: 'member',
        permissions: ['agents:read'],
      }

      const middleware = requirePermission('agents:read')
      middleware(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
    })

    it('有前缀通配符权限时应该允许', () => {
      mockReq.user = {
        userId: 'user-1',
        orgId: 'org-1',
        role: 'member',
        permissions: ['agents:*'],
      }

      const middleware = requirePermission('agents:read')
      middleware(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
    })

    it('权限不足时应该拒绝', () => {
      mockReq.user = {
        userId: 'user-1',
        orgId: 'org-1',
        role: 'member',
        permissions: ['sessions:read'],
      }

      const middleware = requirePermission('agents:read')
      middleware(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(403)
      expect(mockNext).not.toHaveBeenCalled()
    })

    it('多个权限任一匹配即可', () => {
      mockReq.user = {
        userId: 'user-1',
        orgId: 'org-1',
        role: 'member',
        permissions: ['sessions:read'],
      }

      const middleware = requirePermission('agents:read', 'sessions:read')
      middleware(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
    })
  })

  describe('requireRole', () => {
    it('无用户时应该返回错误', () => {
      const middleware = requireRole('admin')
      middleware(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(401)
      expect(mockNext).not.toHaveBeenCalled()
    })

    it('角色匹配时应该允许', () => {
      mockReq.user = {
        userId: 'user-1',
        orgId: 'org-1',
        role: 'admin',
        permissions: [],
      }

      const middleware = requireRole('admin')
      middleware(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
    })

    it('角色不匹配时应该拒绝', () => {
      mockReq.user = {
        userId: 'user-1',
        orgId: 'org-1',
        role: 'member',
        permissions: [],
      }

      const middleware = requireRole('admin', 'owner')
      middleware(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(403)
      expect(mockNext).not.toHaveBeenCalled()
    })

    it('多个角色任一匹配即可', () => {
      mockReq.user = {
        userId: 'user-1',
        orgId: 'org-1',
        role: 'owner',
        permissions: [],
      }

      const middleware = requireRole('admin', 'owner')
      middleware(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
    })
  })

  describe('generateToken', () => {
    it('应该生成有效的 JWT Token', () => {
      const user: AuthUser = {
        userId: 'user-1',
        orgId: 'org-1',
        role: 'member',
        permissions: ['read'],
      }

      const token = generateToken(user)

      expect(token).toBeDefined()
      expect(typeof token).toBe('string')

      // 验证 Token 可以被解析
      const decoded = jwt.verify(token, JWT_SECRET) as Record<string, unknown>
      expect(decoded.userId).toBe('user-1')
      expect(decoded.orgId).toBe('org-1')
      expect(decoded.role).toBe('member')
    })

    it('生成的 Token 应该有过期时间', () => {
      const user: AuthUser = {
        userId: 'user-1',
        orgId: 'org-1',
        role: 'member',
        permissions: [],
      }

      const token = generateToken(user)
      const decoded = jwt.verify(token, JWT_SECRET) as Record<string, unknown>

      expect(decoded.exp).toBeDefined()
      expect(decoded.iat).toBeDefined()
      expect((decoded.exp as number) > (decoded.iat as number)).toBe(true)
    })
  })
})
