import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockContextPolicyService } = vi.hoisted(() => ({
  mockContextPolicyService: {
    getActivePolicies: vi.fn(),
    getPolicyVersions: vi.fn(),
    updatePolicy: vi.fn(),
    rollbackPolicy: vi.fn(),
  },
}))

vi.mock('../services/context-policy.service', () => mockContextPolicyService)

vi.mock('../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = {
      userId: 'user-1',
      orgId: 'org-1',
      role: 'member',
      permissions: ['tools:read', 'tools:write'],
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

import contextPoliciesRouter from '../routes/v1/context-policies'

function getRouteHandler(path: string, method: 'get' | 'post' | 'put') {
  const stack = (contextPoliciesRouter as unknown as { stack: any[] }).stack ?? []
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

describe('context-policies route behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('GET / returns deprecated headers with policy payload', async () => {
    mockContextPolicyService.getActivePolicies.mockResolvedValue([
      { id: '1', docType: 'gene', version: 'v1', content: 'x', status: 'approved', updatedAt: '' },
    ])

    const handler = getRouteHandler('/', 'get')
    const req = { user: { orgId: 'org-1' } }
    const res = { setHeader: vi.fn(), json: vi.fn() }
    const next = vi.fn()

    await handler(req, res, next)

    expect(res.setHeader).toHaveBeenCalledWith('Deprecation', 'true')
    expect(res.setHeader).toHaveBeenCalledWith('Sunset', 'Tue, 30 Jun 2026 00:00:00 GMT')
    expect(res.setHeader).toHaveBeenCalledWith(
      'Link',
      '</api/v1/evolution-capabilities>; rel="successor-version"'
    )
    expect(res.setHeader).toHaveBeenCalledWith(
      'Warning',
      '299 Semibot API "/api/v1/context-policies" is deprecated. Please migrate to "/api/v1/evolution-capabilities".'
    )
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: [{ id: '1', docType: 'gene', version: 'v1', content: 'x', status: 'approved', updatedAt: '' }],
    })
    expect(next).not.toHaveBeenCalled()
  })
})

