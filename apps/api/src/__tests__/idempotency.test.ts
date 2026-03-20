import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { idempotency } from '../middleware/idempotency'

// Mock redis
const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
}

vi.mock('../lib/redis', () => ({
  getRedisClient: () => mockRedis,
  isRedisConnected: vi.fn(() => true),
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

import { isRedisConnected } from '../lib/redis'

function createMockReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request
}

function createMockRes(): Response & { _status: number; _body: unknown } {
  const res = {
    _status: 200,
    _body: null,
    statusCode: 200,
    status(code: number) {
      res._status = code
      res.statusCode = code
      return res
    },
    json(body: unknown) {
      res._body = body
      return res
    },
  } as unknown as Response & { _status: number; _body: unknown }
  return res
}

describe('idempotency middleware', () => {
  const middleware = idempotency()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isRedisConnected).mockReturnValue(true)
  })

  it('should pass through when no X-Request-ID header', async () => {
    const req = createMockReq()
    const res = createMockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(mockRedis.get).not.toHaveBeenCalled()
  })

  it('should return cached response for duplicate request', async () => {
    const cached = JSON.stringify({ statusCode: 200, body: { success: true, data: { id: '1' } } })
    mockRedis.get.mockResolvedValue(cached)

    const req = createMockReq({ 'x-request-id': 'req-001' })
    const res = createMockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res._status).toBe(200)
    expect(res._body).toEqual({ success: true, data: { id: '1' } })
  })

  it('should execute normally and cache result for first request', async () => {
    mockRedis.get.mockResolvedValue(null)
    mockRedis.set.mockResolvedValue('OK')

    const req = createMockReq({ 'x-request-id': 'req-002' })
    const res = createMockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(next).toHaveBeenCalled()
    // SET NX 应该被调用来获取锁
    expect(mockRedis.set).toHaveBeenCalledWith(
      'idempotency:req-002',
      expect.any(String),
      'EX',
      300,
      'NX'
    )

    // 模拟业务逻辑调用 res.json
    res.json({ success: true, data: { id: '2' } })

    // 应该缓存响应
    expect(mockRedis.set).toHaveBeenCalledTimes(2)
  })

  it('should degrade gracefully when Redis is unavailable', async () => {
    vi.mocked(isRedisConnected).mockReturnValue(false)

    const req = createMockReq({ 'x-request-id': 'req-003' })
    const res = createMockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(mockRedis.get).not.toHaveBeenCalled()
  })

  it('should degrade gracefully when Redis throws', async () => {
    mockRedis.get.mockRejectedValue(new Error('Connection refused'))

    const req = createMockReq({ 'x-request-id': 'req-004' })
    const res = createMockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(next).toHaveBeenCalled()
  })

  it('should return 409 when another request is in progress', async () => {
    mockRedis.get.mockResolvedValue(null)
    mockRedis.set.mockResolvedValue(null) // NX 失败

    const req = createMockReq({ 'x-request-id': 'req-005' })
    const res = createMockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res._status).toBe(409)
  })
})
