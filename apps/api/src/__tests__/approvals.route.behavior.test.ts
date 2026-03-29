import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRuntimeRequest, mockResolveApproval } = vi.hoisted(() => ({
  mockRuntimeRequest: vi.fn(),
  mockResolveApproval: vi.fn(),
}))

vi.mock('../lib/runtime-client', () => ({
  runtimeRequest: mockRuntimeRequest,
}))

vi.mock('../services/chat.service', () => ({
  resolveApprovalAndMaybeResume: mockResolveApproval,
}))

vi.mock('../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = {
      userId: 'user-1',
      orgId: 'org-1',
      role: 'member',
      permissions: ['approvals:read', 'approvals:write'],
    }
    next()
  },
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}))

vi.mock('../middleware/rateLimit', () => ({
  combinedRateLimit: (_req: any, _res: any, next: any) => next(),
}))

vi.mock('../middleware/errorHandler', () => ({
  asyncHandler: (fn: any) => (req: any, res: any, next: any) =>
    Promise.resolve(fn(req, res, next)).catch(next),
  validate: () => (_req: any, _res: any, next: any) => next(),
}))

import approvalsRouter from '../routes/v1/approvals'

function getRouteHandler(path: string, method: 'get' | 'post') {
  const stack = (approvalsRouter as unknown as { stack: any[] }).stack ?? []
  const routeLayer = stack.find(
    (layer) => layer.route?.path === path && Boolean(layer.route?.methods?.[method])
  )
  if (!routeLayer) {
    throw new Error(`route not found: ${method.toUpperCase()} ${path}`)
  }
  const handlers = routeLayer.route.stack ?? []
  const finalLayer = handlers[handlers.length - 1]
  if (!finalLayer?.handle) {
    throw new Error(`handler not found: ${method.toUpperCase()} ${path}`)
  }
  return finalLayer.handle as (req: any, res: any, next: any) => Promise<void> | void
}

describe('approvals route behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('GET / returns approval items with attempt and session context passthrough', async () => {
    mockRuntimeRequest.mockResolvedValue({
      items: [
        {
          id: 'appr-1',
          status: 'pending',
          session_id: 'sess-1',
          attempt_id: 'att-1',
          user_message_id: 'msg-user-1',
        },
      ],
    })

    const handler = getRouteHandler('/', 'get')
    const req = { query: { status: 'pending', limit: '50' }, user: { userId: 'user-1' } }
    const res = { json: vi.fn() }
    const next = vi.fn()

    await handler(req, res, next)

    expect(mockRuntimeRequest).toHaveBeenCalledWith('/v1/approvals', {
      method: 'GET',
      query: { status: 'pending', limit: '50' },
    })
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      items: [
        expect.objectContaining({
          id: 'appr-1',
          session_id: 'sess-1',
          attempt_id: 'att-1',
          user_message_id: 'msg-user-1',
        }),
      ],
    })
    expect(next).not.toHaveBeenCalled()
  })

  it('POST /:id/approve returns resume identity payload', async () => {
    mockResolveApproval.mockResolvedValue({
      approvalId: 'appr-1',
      status: 'approved',
      resumed: true,
      sessionId: 'sess-1',
      attemptId: 'att-1',
      userMessageId: 'msg-user-1',
      assistantMessageId: 'msg-assistant-1',
    })

    const handler = getRouteHandler('/:id/approve', 'post')
    const req = { params: { id: 'appr-1' }, body: {}, user: { userId: 'user-1' } }
    const res = { json: vi.fn() }
    const next = vi.fn()

    await handler(req, res, next)

    expect(mockResolveApproval).toHaveBeenCalledWith('appr-1', 'approve')
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      id: 'appr-1',
      status: 'approved',
      resolved: true,
      resumed: true,
      sessionId: 'sess-1',
      attemptId: 'att-1',
      userMessageId: 'msg-user-1',
      assistantMessageId: 'msg-assistant-1',
    })
    expect(next).not.toHaveBeenCalled()
  })
})
