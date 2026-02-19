/**
 * Tracing 中间件测试
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import { tracing } from '../../middleware/tracing'

function createMockReqRes() {
  const req: any = {
    headers: {},
  }
  const res: any = {
    setHeader: vi.fn(),
  }
  const next = vi.fn()
  return { req, res, next }
}

describe('Tracing Middleware', () => {
  it('应该生成 traceId 如果请求没有 X-Request-ID', () => {
    const { req, res, next } = createMockReqRes()

    tracing(req, res, next)

    expect(req.traceId).toBeDefined()
    expect(req.traceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', req.traceId)
    expect(next).toHaveBeenCalled()
  })

  it('应该透传请求中的 X-Request-ID', () => {
    const { req, res, next } = createMockReqRes()
    const existingTraceId = '12345678-1234-1234-1234-123456789abc'
    req.headers['x-request-id'] = existingTraceId

    tracing(req, res, next)

    expect(req.traceId).toBe(existingTraceId)
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', existingTraceId)
    expect(next).toHaveBeenCalled()
  })

  it('应该注入 logger 到 req', () => {
    const { req, res, next } = createMockReqRes()

    tracing(req, res, next)

    expect(req.logger).toBeDefined()
  })

  it('应该设置响应 header', () => {
    const { req, res, next } = createMockReqRes()

    tracing(req, res, next)

    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', expect.any(String))
  })
})
