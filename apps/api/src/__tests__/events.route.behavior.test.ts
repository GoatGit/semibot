import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRuntimeRequest, mockGetSessionMessages } = vi.hoisted(() => ({
  mockRuntimeRequest: vi.fn(),
  mockGetSessionMessages: vi.fn(),
}))

vi.mock('../lib/runtime-client', () => ({
  runtimeRequest: mockRuntimeRequest,
}))

vi.mock('../services/session.service', () => ({
  getSessionMessages: mockGetSessionMessages,
}))

vi.mock('../services/event-engine.service', () => ({
  getEventPresentationDictionary: vi.fn(),
  updateEventPresentationDictionary: vi.fn(),
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('../middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = {
      userId: 'user-1',
      orgId: 'org-1',
      role: 'member',
      permissions: ['events:read', 'events:write'],
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
  errors: {
    forbidden: (message: string) => new Error(message),
  },
}))

import eventsRouter from '../routes/v1/events'

function getRouteHandler(path: string, method: 'get' | 'post') {
  const stack = (eventsRouter as unknown as { stack: any[] }).stack ?? []
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

describe('events route behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSessionMessages.mockResolvedValue([])
  })

  it('GET / filters events by capability id after runtime fetch', async () => {
    mockRuntimeRequest.mockResolvedValue({
      items: [
        {
          id: 'evt-1',
          event_type: 'tool.exec.started',
          source: 'runtime',
          payload: { capability_id: 'mcp:browser.open_url', session_id: 'sess-1' },
          created_at: '2026-04-01T00:00:00Z',
        },
        {
          id: 'evt-2',
          event_type: 'tool.exec.started',
          source: 'runtime',
          payload: { capability_id: 'tool:bash.exec', session_id: 'sess-1' },
          created_at: '2026-04-01T00:00:01Z',
        },
      ],
      next_cursor: null,
    })

    const handler = getRouteHandler('/', 'get')
    const req = { query: { capability: 'browser', limit: '50', page: '1' }, user: { userId: 'user-1' } }
    const res = { json: vi.fn() }
    const next = vi.fn()

    await handler(req, res, next)

    expect(mockRuntimeRequest).toHaveBeenCalledWith('/v1/events', {
      method: 'GET',
      query: {
        event_type: undefined,
        capability_id: 'browser',
        limit: '50',
      },
      timeoutMs: 4000,
    })
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      items: [
        expect.objectContaining({
          id: 'evt-1',
        }),
      ],
      page: '1',
      limit: '50',
      total: 1,
      next_cursor: null,
    })
    expect(next).not.toHaveBeenCalled()
  })
})
