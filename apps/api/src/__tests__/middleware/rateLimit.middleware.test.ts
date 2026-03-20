/**
 * Rate Limit Middleware Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Response, NextFunction } from 'express'
import type { AuthRequest } from '../../middleware/auth'
import {
  userRateLimit,
  orgRateLimit,
  authRateLimit,
  createRateLimit,
} from '../../middleware/rateLimit'

// Mock Redis
vi.mock('../../lib/redis', () => ({
  isRedisConnected: vi.fn().mockReturnValue(false),
  getRedisClient: vi.fn(),
}))

// Mock logger
vi.mock('../../lib/logger', () => ({
  rateLimitLogger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

describe('Rate Limit Middleware', () => {
  let mockReq: Partial<AuthRequest>
  let mockRes: Partial<Response>
  let mockNext: NextFunction
  let headerValues: Record<string, string | number>

  beforeEach(() => {
    headerValues = {}
    mockReq = {
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' } as any,
      user: {
        userId: 'user-1',
        orgId: 'org-1',
        role: 'member',
        permissions: [],
      },
    }
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn((key: string, value: string | number) => {
        headerValues[key] = value
        return mockRes
      }),
      headersSent: false,
    }
    mockNext = vi.fn()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('userRateLimit', () => {
    it('应该允许在限制内的请求', async () => {
      await userRateLimit(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
      expect(mockRes.status).not.toHaveBeenCalled()
    })

    it('应该设置限流响应头', async () => {
      await userRateLimit(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockRes.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', expect.any(Number))
      expect(mockRes.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(Number))
      expect(mockRes.setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(Number))
    })

    it('未认证用户应该使用 IP 作为标识', async () => {
      mockReq.user = undefined
      mockReq.ip = '192.168.1.1'

      await userRateLimit(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
    })

    it('无 IP 时应该使用 socket.remoteAddress', async () => {
      mockReq.user = undefined
      mockReq.ip = undefined

      await userRateLimit(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
    })
  })

  describe('orgRateLimit', () => {
    it('有 orgId 时应该检查组织级限流', async () => {
      await orgRateLimit(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
      expect(mockRes.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', expect.any(Number))
    })

    it('无 orgId 时应该直接跳过', async () => {
      mockReq.user = undefined

      await orgRateLimit(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
      // 不应该设置限流头
      expect(mockRes.setHeader).not.toHaveBeenCalled()
    })
  })

  describe('authRateLimit', () => {
    it('应该允许在限制内的请求', async () => {
      await authRateLimit(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
    })

    it('应该设置限流响应头', async () => {
      await authRateLimit(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockRes.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', expect.any(Number))
    })
  })

  describe('createRateLimit', () => {
    it('应该创建自定义限流中间件', async () => {
      const customLimiter = createRateLimit({
        limit: 10,
        windowMs: 60000,
      })

      await customLimiter(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
    })

    it('应该支持自定义 key 生成器', async () => {
      const customLimiter = createRateLimit({
        limit: 10,
        windowMs: 60000,
        keyGenerator: (req) => `custom:${req.user?.userId}`,
      })

      await customLimiter(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
    })

    it('超过限制时应该返回 429', async () => {
      const customLimiter = createRateLimit({
        limit: 1,
        windowMs: 60000,
      })

      // 第一次请求
      await customLimiter(mockReq as AuthRequest, mockRes as Response, mockNext)
      expect(mockNext).toHaveBeenCalled()

      // 重置 mock
      mockNext = vi.fn()
      mockRes.status = vi.fn().mockReturnThis()
      mockRes.json = vi.fn().mockReturnThis()

      // 第二次请求应该被限流
      await customLimiter(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(429)
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'RATE_LIMIT_EXCEEDED',
          }),
        })
      )
    })

    it('应该支持自定义错误消息', async () => {
      const customLimiter = createRateLimit({
        limit: 1,
        windowMs: 60000,
        message: '请求过于频繁，请稍后再试',
      })

      // 第一次请求
      await customLimiter(mockReq as AuthRequest, mockRes as Response, mockNext)

      // 重置 mock
      mockNext = vi.fn()
      mockRes.status = vi.fn().mockReturnThis()
      mockRes.json = vi.fn().mockReturnThis()

      // 第二次请求
      await customLimiter(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: '请求过于频繁，请稍后再试',
          }),
        })
      )
    })

    it('被限流时应该设置 Retry-After 头', async () => {
      const customLimiter = createRateLimit({
        limit: 1,
        windowMs: 60000,
      })

      await customLimiter(mockReq as AuthRequest, mockRes as Response, mockNext)

      mockNext = vi.fn()
      mockRes.status = vi.fn().mockReturnThis()
      mockRes.json = vi.fn().mockReturnThis()

      await customLimiter(mockReq as AuthRequest, mockRes as Response, mockNext)

      expect(mockRes.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number))
    })
  })
})
