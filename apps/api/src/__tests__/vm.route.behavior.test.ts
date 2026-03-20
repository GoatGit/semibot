import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockScheduler } = vi.hoisted(() => ({
  mockScheduler: {
    getUserVMStatus: vi.fn(),
    forceRebootstrap: vi.fn(),
  },
}))

vi.mock('../scheduler/vm-scheduler', () => mockScheduler)

vi.mock('../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = {
      userId: 'user-1',
      orgId: 'org-1',
      role: 'member',
      permissions: ['sessions:read', 'sessions:write'],
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
}))

import vmRouter from '../routes/v1/vm'

function getRouteHandler(path: string, method: 'get' | 'post') {
  const stack = (vmRouter as unknown as { stack: any[] }).stack ?? []
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

describe('vm route behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('GET /status returns vm status payload', async () => {
    mockScheduler.getUserVMStatus.mockResolvedValue({
      instanceId: 'vm-1',
      status: 'disconnected',
      retryAfterMs: 5000,
    })

    const handler = getRouteHandler('/status', 'get')
    const req = { user: { userId: 'user-1' } }
    const res = { json: vi.fn() }
    const next = vi.fn()

    await handler(req, res, next)

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        instanceId: 'vm-1',
        status: 'disconnected',
        retryAfterMs: 5000,
      },
    })
    expect(next).not.toHaveBeenCalled()
    expect(mockScheduler.getUserVMStatus).toHaveBeenCalledWith('user-1')
  })

  it('POST /rebootstrap returns scheduler result', async () => {
    mockScheduler.forceRebootstrap.mockResolvedValue({
      ready: false,
      status: 'provisioning',
      instanceId: 'vm-2',
    })

    const handler = getRouteHandler('/rebootstrap', 'post')
    const req = { user: { userId: 'user-1', orgId: 'org-1' } }
    const res = { json: vi.fn() }
    const next = vi.fn()

    await handler(req, res, next)

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        ready: false,
        status: 'provisioning',
        instanceId: 'vm-2',
      },
    })
    expect(next).not.toHaveBeenCalled()
    expect(mockScheduler.forceRebootstrap).toHaveBeenCalledWith('user-1', 'org-1')
  })
})
