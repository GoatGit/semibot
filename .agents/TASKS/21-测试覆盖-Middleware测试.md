# 任务：Middleware 测试

**优先级**: 🟡 P1 - 高优先级
**类型**: 测试覆盖
**预估工时**: 1-2 天
**影响范围**: apps/api/src/middlewares/ 目录

---

## 问题描述

Middleware 层负责请求预处理（认证、限流、验证等），是 API 安全的第一道防线，但**缺少完整的测试覆盖**。

---

## 需要测试的 Middleware

| 文件 | 功能 | 测试重点 |
|------|------|----------|
| `auth.middleware.ts` | JWT 认证 | Token 验证、过期处理 |
| `validate.middleware.ts` | 输入验证 | Schema 验证、错误消息 |
| `rate-limit.middleware.ts` | 限流 | 限流规则、响应头 |
| `error.middleware.ts` | 错误处理 | 错误格式、日志 |
| `cors.middleware.ts` | CORS | 跨域配置 |

---

## 测试用例

### 1. Auth Middleware 测试

```typescript
// apps/api/src/__tests__/middlewares/auth.middleware.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Request, Response, NextFunction } from 'express'
import { authenticate, optionalAuth } from '../../middlewares/auth.middleware'
import * as jwt from 'jsonwebtoken'

describe('AuthMiddleware', () => {
  let mockReq: Partial<Request>
  let mockRes: Partial<Response>
  let mockNext: NextFunction

  beforeEach(() => {
    mockReq = {
      headers: {},
      get: vi.fn()
    }
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    }
    mockNext = vi.fn()
  })

  describe('authenticate', () => {
    it('应该拒绝无 Token 的请求', async () => {
      await authenticate(mockReq as Request, mockRes as Response, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(401)
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'UNAUTHORIZED'
          })
        })
      )
      expect(mockNext).not.toHaveBeenCalled()
    })

    it('应该拒绝无效 Token', async () => {
      mockReq.headers = { authorization: 'Bearer invalid-token' }

      await authenticate(mockReq as Request, mockRes as Response, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(401)
      expect(mockNext).not.toHaveBeenCalled()
    })

    it('应该拒绝过期 Token', async () => {
      const expiredToken = jwt.sign(
        { userId: 'user-1', orgId: 'org-1' },
        process.env.JWT_SECRET || 'test-secret',
        { expiresIn: '-1h' }  // 已过期
      )
      mockReq.headers = { authorization: `Bearer ${expiredToken}` }

      await authenticate(mockReq as Request, mockRes as Response, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(401)
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'TOKEN_EXPIRED'
          })
        })
      )
    })

    it('应该接受有效 Token 并设置 req.auth', async () => {
      const validToken = jwt.sign(
        { userId: 'user-1', orgId: 'org-1' },
        process.env.JWT_SECRET || 'test-secret',
        { expiresIn: '1h' }
      )
      mockReq.headers = { authorization: `Bearer ${validToken}` }

      await authenticate(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
      expect((mockReq as any).auth).toBeDefined()
      expect((mockReq as any).auth.userId).toBe('user-1')
      expect((mockReq as any).auth.orgId).toBe('org-1')
    })

    it('应该支持 Bearer 前缀（大小写不敏感）', async () => {
      const validToken = jwt.sign(
        { userId: 'user-1', orgId: 'org-1' },
        process.env.JWT_SECRET || 'test-secret',
        { expiresIn: '1h' }
      )
      mockReq.headers = { authorization: `bearer ${validToken}` }

      await authenticate(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
    })
  })

  describe('optionalAuth', () => {
    it('无 Token 时也应该继续', async () => {
      await optionalAuth(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
      expect((mockReq as any).auth).toBeUndefined()
    })

    it('有效 Token 时应该设置 req.auth', async () => {
      const validToken = jwt.sign(
        { userId: 'user-1', orgId: 'org-1' },
        process.env.JWT_SECRET || 'test-secret',
        { expiresIn: '1h' }
      )
      mockReq.headers = { authorization: `Bearer ${validToken}` }

      await optionalAuth(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
      expect((mockReq as any).auth).toBeDefined()
    })

    it('无效 Token 时也应该继续（不设置 auth）', async () => {
      mockReq.headers = { authorization: 'Bearer invalid' }

      await optionalAuth(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
      expect((mockReq as any).auth).toBeUndefined()
    })
  })
})
```

### 2. Validate Middleware 测试

```typescript
// apps/api/src/__tests__/middlewares/validate.middleware.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Request, Response, NextFunction } from 'express'
import { validate } from '../../middlewares/validate.middleware'
import { z } from 'zod'

describe('ValidateMiddleware', () => {
  let mockReq: Partial<Request>
  let mockRes: Partial<Response>
  let mockNext: NextFunction

  beforeEach(() => {
    mockReq = {
      body: {},
      query: {},
      params: {}
    }
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    }
    mockNext = vi.fn()
  })

  const testSchema = z.object({
    name: z.string().min(1).max(100),
    email: z.string().email(),
    age: z.number().int().min(0).max(150).optional()
  })

  describe('body validation', () => {
    it('应该接受有效数据', () => {
      mockReq.body = { name: 'Test', email: 'test@example.com' }

      validate(testSchema, 'body')(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
      expect(mockRes.status).not.toHaveBeenCalled()
    })

    it('应该拒绝缺少必填字段', () => {
      mockReq.body = { name: 'Test' }  // 缺少 email

      validate(testSchema, 'body')(mockReq as Request, mockRes as Response, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(400)
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'VALIDATION_ERROR'
          })
        })
      )
      expect(mockNext).not.toHaveBeenCalled()
    })

    it('应该拒绝无效格式', () => {
      mockReq.body = { name: 'Test', email: 'invalid-email' }

      validate(testSchema, 'body')(mockReq as Request, mockRes as Response, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(400)
    })

    it('应该返回详细的错误信息', () => {
      mockReq.body = { name: '', email: 'invalid' }

      validate(testSchema, 'body')(mockReq as Request, mockRes as Response, mockNext)

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            details: expect.arrayContaining([
              expect.objectContaining({ path: ['name'] }),
              expect.objectContaining({ path: ['email'] })
            ])
          })
        })
      )
    })
  })

  describe('query validation', () => {
    const querySchema = z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20)
    })

    it('应该解析并验证 query 参数', () => {
      mockReq.query = { page: '2', limit: '50' }

      validate(querySchema, 'query')(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
      expect(mockReq.query).toEqual({ page: 2, limit: 50 })
    })

    it('应该应用默认值', () => {
      mockReq.query = {}

      validate(querySchema, 'query')(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
      expect(mockReq.query).toEqual({ page: 1, limit: 20 })
    })
  })

  describe('params validation', () => {
    const paramsSchema = z.object({
      id: z.string().uuid()
    })

    it('应该验证 UUID 参数', () => {
      mockReq.params = { id: '550e8400-e29b-41d4-a716-446655440000' }

      validate(paramsSchema, 'params')(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
    })

    it('应该拒绝无效 UUID', () => {
      mockReq.params = { id: 'invalid-uuid' }

      validate(paramsSchema, 'params')(mockReq as Request, mockRes as Response, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(400)
    })
  })
})
```

### 3. Rate Limit Middleware 测试

```typescript
// apps/api/src/__tests__/middlewares/rate-limit.middleware.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Request, Response, NextFunction } from 'express'
import { createRateLimiter } from '../../middlewares/rate-limit.middleware'

describe('RateLimitMiddleware', () => {
  let mockReq: Partial<Request>
  let mockRes: Partial<Response>
  let mockNext: NextFunction

  beforeEach(() => {
    mockReq = {
      ip: '127.0.0.1',
      auth: { userId: 'user-1', orgId: 'org-1' }
    }
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      setHeader: vi.fn()
    }
    mockNext = vi.fn()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('basic rate limiting', () => {
    it('应该允许在限制内的请求', async () => {
      const limiter = createRateLimiter({ windowMs: 60000, max: 10 })

      await limiter(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
      expect(mockRes.status).not.toHaveBeenCalled()
    })

    it('应该设置限流响应头', async () => {
      const limiter = createRateLimiter({ windowMs: 60000, max: 10 })

      await limiter(mockReq as Request, mockRes as Response, mockNext)

      expect(mockRes.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 10)
      expect(mockRes.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(Number))
    })

    it('应该在超过限制时返回 429', async () => {
      const limiter = createRateLimiter({ windowMs: 60000, max: 2 })

      // 发送超过限制的请求
      await limiter(mockReq as Request, mockRes as Response, mockNext)
      await limiter(mockReq as Request, mockRes as Response, mockNext)
      await limiter(mockReq as Request, mockRes as Response, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(429)
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'RATE_LIMIT_EXCEEDED'
          })
        })
      )
    })
  })

  describe('user-based rate limiting', () => {
    it('应该按用户独立限流', async () => {
      const limiter = createRateLimiter({ windowMs: 60000, max: 2, keyBy: 'user' })

      // 用户 1
      mockReq.auth = { userId: 'user-1', orgId: 'org-1' }
      await limiter(mockReq as Request, mockRes as Response, mockNext)
      await limiter(mockReq as Request, mockRes as Response, mockNext)

      // 用户 2 不受影响
      mockReq.auth = { userId: 'user-2', orgId: 'org-1' }
      mockNext = vi.fn()
      await limiter(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
    })
  })
})
```

### 4. Error Middleware 测试

```typescript
// apps/api/src/__tests__/middlewares/error.middleware.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Request, Response, NextFunction } from 'express'
import { errorHandler } from '../../middlewares/error.middleware'
import { createError } from '../../lib/errors'

describe('ErrorMiddleware', () => {
  let mockReq: Partial<Request>
  let mockRes: Partial<Response>
  let mockNext: NextFunction

  beforeEach(() => {
    mockReq = {}
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    }
    mockNext = vi.fn()
  })

  it('应该处理 AppError', () => {
    const error = createError(404, 'NOT_FOUND', 'Resource not found')

    errorHandler(error, mockReq as Request, mockRes as Response, mockNext)

    expect(mockRes.status).toHaveBeenCalledWith(404)
    expect(mockRes.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Resource not found'
      }
    })
  })

  it('应该处理未知错误为 500', () => {
    const error = new Error('Unknown error')

    errorHandler(error, mockReq as Request, mockRes as Response, mockNext)

    expect(mockRes.status).toHaveBeenCalledWith(500)
    expect(mockRes.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error'
      }
    })
  })

  it('应该在开发环境返回堆栈信息', () => {
    process.env.NODE_ENV = 'development'
    const error = new Error('Test error')

    errorHandler(error, mockReq as Request, mockRes as Response, mockNext)

    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          stack: expect.any(String)
        })
      })
    )

    process.env.NODE_ENV = 'test'
  })

  it('不应该在生产环境返回堆栈信息', () => {
    process.env.NODE_ENV = 'production'
    const error = new Error('Test error')

    errorHandler(error, mockReq as Request, mockRes as Response, mockNext)

    expect(mockRes.json).toHaveBeenCalledWith(
      expect.not.objectContaining({
        error: expect.objectContaining({
          stack: expect.any(String)
        })
      })
    )

    process.env.NODE_ENV = 'test'
  })
})
```

---

## 测试目录结构

```
apps/api/src/__tests__/middlewares/
├── auth.middleware.test.ts
├── validate.middleware.test.ts
├── rate-limit.middleware.test.ts
├── error.middleware.test.ts
└── cors.middleware.test.ts
```

---

## 修复清单

### 测试文件
- [ ] 创建 `auth.middleware.test.ts`
- [ ] 创建 `validate.middleware.test.ts`
- [ ] 创建 `rate-limit.middleware.test.ts`
- [ ] 创建 `error.middleware.test.ts`
- [ ] 创建 `cors.middleware.test.ts`

### 覆盖目标
- [ ] `auth.middleware.ts` 覆盖率 >= 90%
- [ ] `validate.middleware.ts` 覆盖率 >= 90%
- [ ] `rate-limit.middleware.ts` 覆盖率 >= 80%
- [ ] `error.middleware.ts` 覆盖率 >= 90%

---

## 完成标准

- [ ] 所有 Middleware 有测试
- [ ] 测试覆盖率 >= 80%
- [ ] 边界条件测试完整
- [ ] CI 集成通过
- [ ] 代码审查通过

---

## 相关文档

- [测试规范](docs/design/TESTING.md)
- [安全规范](.claude/rules/security.md)
