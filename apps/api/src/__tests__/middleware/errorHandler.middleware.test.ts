/**
 * Error Handler Middleware Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { ZodError, z } from 'zod'
import {
  errorHandler,
  notFoundHandler,
  asyncHandler,
  validate,
  AppError,
  createError,
  errors,
} from '../../middleware/errorHandler'

// Mock logger
vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn().mockReturnValue({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  }),
}))

describe('Error Handler Middleware', () => {
  let mockReq: Partial<Request>
  let mockRes: Partial<Response>
  let mockNext: NextFunction

  beforeEach(() => {
    mockReq = {
      method: 'GET',
      path: '/test',
      body: {},
      query: {},
      params: {},
    }
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    }
    mockNext = vi.fn()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('errorHandler', () => {
    it('应该处理 AppError', () => {
      const error = new AppError('RESOURCE_NOT_FOUND', '资源不存在')

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(404)
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: '资源不存在',
          details: undefined,
        },
      })
    })

    it('应该处理带 details 的 AppError', () => {
      const error = new AppError('VALIDATION_FAILED', '验证失败', { field: 'name' })

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext)

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            details: { field: 'name' },
          }),
        })
      )
    })

    it('应该处理 ZodError', () => {
      const schema = z.object({
        name: z.string().min(1),
        email: z.string().email(),
      })

      let zodError: ZodError | null = null
      try {
        schema.parse({ name: '', email: 'invalid' })
      } catch (e) {
        zodError = e as ZodError
      }

      errorHandler(zodError!, mockReq as Request, mockRes as Response, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(400)
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'VALIDATION_FAILED',
            details: expect.any(Array),
          }),
        })
      )
    })

    it('应该处理普通 Error 为 500', () => {
      const error = new Error('Unknown error')

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(500)
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'INTERNAL_ERROR',
          }),
        })
      )
    })

    it('生产环境不应该暴露错误详情', () => {
      const originalEnv = process.env.NODE_ENV
      process.env.NODE_ENV = 'production'

      const error = new Error('Sensitive error details')

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext)

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            details: undefined,
          }),
        })
      )

      process.env.NODE_ENV = originalEnv
    })
  })

  describe('notFoundHandler', () => {
    it('应该返回 404 错误', () => {
      mockReq.method = 'POST'
      mockReq.path = '/api/unknown'

      notFoundHandler(mockReq as Request, mockRes as Response)

      expect(mockRes.status).toHaveBeenCalledWith(404)
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: '路由不存在: POST /api/unknown',
        },
      })
    })
  })

  describe('asyncHandler', () => {
    it('应该捕获异步错误并传递给 next', async () => {
      const asyncFn = async () => {
        throw new Error('Async error')
      }

      const handler = asyncHandler(asyncFn)
      handler(mockReq as Request, mockRes as Response, mockNext)

      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(mockNext).toHaveBeenCalledWith(expect.any(Error))
    })

    it('成功时不应该调用 next with error', async () => {
      const asyncFn = async (_req: Request, res: Response) => {
        res.json({ success: true })
      }

      const handler = asyncHandler(asyncFn)
      handler(mockReq as Request, mockRes as Response, mockNext)

      await new Promise((resolve) => setTimeout(resolve, 10))

      expect(mockRes.json).toHaveBeenCalledWith({ success: true })
    })
  })

  describe('validate', () => {
    const testSchema = z.object({
      name: z.string().min(1),
      age: z.number().int().min(0).optional(),
    })

    it('应该通过有效数据', () => {
      mockReq.body = { name: 'Test', age: 25 }

      validate(testSchema, 'body')(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalledWith()
      expect(mockReq.body).toEqual({ name: 'Test', age: 25 })
    })

    it('应该拒绝无效数据并调用 next with error', () => {
      mockReq.body = { name: '' }

      validate(testSchema, 'body')(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalledWith(expect.any(ZodError))
    })

    it('应该验证 query 参数', () => {
      const querySchema = z.object({
        page: z.coerce.number().int().min(1).default(1),
      })
      mockReq.query = { page: '2' }

      validate(querySchema, 'query')(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalledWith()
      expect(mockReq.query).toEqual({ page: 2 })
    })

    it('应该验证 params', () => {
      const paramsSchema = z.object({
        id: z.string().uuid(),
      })
      mockReq.params = { id: '550e8400-e29b-41d4-a716-446655440000' }

      validate(paramsSchema, 'params')(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalledWith()
    })
  })

  describe('AppError', () => {
    it('应该正确设置 code 和 message', () => {
      const error = new AppError('AGENT_NOT_FOUND', '代理不存在')

      expect(error.code).toBe('AGENT_NOT_FOUND')
      expect(error.message).toBe('代理不存在')
      expect(error.name).toBe('AppError')
    })

    it('应该从 ERROR_HTTP_STATUS 获取 statusCode', () => {
      const error = new AppError('RESOURCE_NOT_FOUND')

      expect(error.statusCode).toBe(404)
    })

    it('未知 code 应该默认为 500', () => {
      const error = new AppError('UNKNOWN_CODE')

      expect(error.statusCode).toBe(500)
    })
  })

  describe('createError', () => {
    it('应该创建 AppError', () => {
      const error = createError('VALIDATION_FAILED', '验证失败', { field: 'email' })

      expect(error).toBeInstanceOf(AppError)
      expect(error.code).toBe('VALIDATION_FAILED')
      expect(error.details).toEqual({ field: 'email' })
    })
  })

  describe('errors convenience functions', () => {
    it('unauthorized 应该创建 AUTH_TOKEN_MISSING 错误', () => {
      const error = errors.unauthorized()

      expect(error).toBeInstanceOf(AppError)
      expect(error.code).toBe('AUTH_TOKEN_MISSING')
    })

    it('forbidden 应该创建 AUTH_PERMISSION_DENIED 错误', () => {
      const error = errors.forbidden()

      expect(error).toBeInstanceOf(AppError)
      expect(error.code).toBe('AUTH_PERMISSION_DENIED')
    })

    it('notFound 应该根据资源类型创建错误', () => {
      const agentError = errors.notFound('Agent')
      expect(agentError.code).toBe('AGENT_NOT_FOUND')

      const sessionError = errors.notFound('Session')
      expect(sessionError.code).toBe('SESSION_NOT_FOUND')

      const skillError = errors.notFound('Skill')
      expect(skillError.code).toBe('SKILL_NOT_FOUND')
    })

    it('validation 应该创建 VALIDATION_FAILED 错误', () => {
      const error = errors.validation({ field: 'name', message: 'required' })

      expect(error.code).toBe('VALIDATION_FAILED')
      expect(error.details).toEqual({ field: 'name', message: 'required' })
    })

    it('conflict 应该创建 RESOURCE_CONFLICT 错误', () => {
      const error = errors.conflict('版本冲突')

      expect(error.code).toBe('RESOURCE_CONFLICT')
      expect(error.message).toBe('版本冲突')
    })

    it('rateLimit 应该创建 RATE_LIMIT_EXCEEDED 错误', () => {
      const error = errors.rateLimit()

      expect(error.code).toBe('RATE_LIMIT_EXCEEDED')
    })

    it('internal 应该创建 INTERNAL_ERROR 错误', () => {
      const error = errors.internal('服务器内部错误')

      expect(error.code).toBe('INTERNAL_ERROR')
    })
  })
})
