import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Request, Response, NextFunction } from 'express'

const memStore = vi.hoisted(() => ({
  get: vi.fn(),
  setNX: vi.fn(),
  setWithExpiry: vi.fn(),
}))

vi.mock('../lib/mem-store', () => memStore)

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

import { idempotency } from '../middleware/idempotency'

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
    memStore.get.mockResolvedValue(null)
    memStore.setNX.mockResolvedValue('OK')
    memStore.setWithExpiry.mockResolvedValue(undefined)
  })

  it('should pass through when no X-Request-ID header', async () => {
    const req = createMockReq()
    const res = createMockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(memStore.get).not.toHaveBeenCalled()
  })

  it('should return cached response for duplicate request', async () => {
    const cached = JSON.stringify({ statusCode: 200, body: { success: true, data: { id: '1' } } })
    memStore.get.mockResolvedValue(cached)

    const req = createMockReq({ 'x-request-id': 'req-001' })
    const res = createMockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res._status).toBe(200)
    expect(res._body).toEqual({ success: true, data: { id: '1' } })
  })

  it('should execute normally and cache result for first request', async () => {
    const req = createMockReq({ 'x-request-id': 'req-002' })
    const res = createMockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(memStore.setNX).toHaveBeenCalledWith(
      'idempotency:req-002',
      expect.any(String),
      300
    )

    res.json({ success: true, data: { id: '2' } })

    expect(memStore.setWithExpiry).toHaveBeenCalledWith(
      'idempotency:req-002',
      JSON.stringify({ statusCode: 200, body: { success: true, data: { id: '2' } } }),
      300
    )
  })

  it('should degrade gracefully when storage throws', async () => {
    memStore.get.mockRejectedValue(new Error('boom'))

    const req = createMockReq({ 'x-request-id': 'req-004' })
    const res = createMockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(next).toHaveBeenCalled()
  })

  it('should return 409 when another request is in progress', async () => {
    memStore.setNX.mockResolvedValue(null)

    const req = createMockReq({ 'x-request-id': 'req-005' })
    const res = createMockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res._status).toBe(409)
  })
})
