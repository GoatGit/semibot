import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSessionService } = vi.hoisted(() => ({
  mockSessionService: {
    getSessionView: vi.fn(),
    getRuntimeAttemptView: vi.fn(),
    getSessionMessages: vi.fn(),
    getSession: vi.fn(),
    createSession: vi.fn(),
    updateSession: vi.fn(),
    deleteSession: vi.fn(),
    addMessage: vi.fn(),
  },
}))

vi.mock('../services/session.service', () => mockSessionService)

vi.mock('../services/document-context.service', () => ({
  resolveDocumentChunk: vi.fn(),
}))

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
  validate: () => (_req: any, _res: any, next: any) => next(),
}))

import sessionsRouter from '../routes/v1/sessions'

function getRouteHandler(path: string, method: 'get' | 'post' | 'put' | 'delete') {
  const stack = (sessionsRouter as unknown as { stack: any[] }).stack ?? []
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

describe('sessions route behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('GET /:id/view returns structured SessionView payload', async () => {
    mockSessionService.getSessionView.mockResolvedValue({
      session: {
        id: 'sess-1',
        agentId: 'agent-1',
        userId: 'user-1',
        status: 'active',
        title: 'Test Session',
        createdAt: '2026-03-29T12:00:00.000Z',
        startedAt: '2026-03-29T12:00:00.000Z',
      },
      messages: [
        {
          id: 'msg-user-1',
          sessionId: 'sess-1',
          role: 'user',
          content: '搜索最新的 AI 行业动态并总结',
          createdAt: '2026-03-29T12:00:00.000Z',
        },
      ],
      currentAttempt: {
        id: 'att-1',
        sessionId: 'sess-1',
        userMessageId: 'msg-user-1',
        agentId: 'agent-1',
        attemptSeq: 1,
        executionMode: 'unknown',
        status: 'awaiting_approval',
        approvalSetRevision: 1,
        approvalBlockCount: 1,
        resumeCount: 0,
        startedAt: '2026-03-29T12:00:00.000Z',
        updatedAt: '2026-03-29T12:01:00.000Z',
      },
      attemptsSummary: [],
      runState: {
        sessionId: 'sess-1',
        status: 'awaiting_approval',
        pendingApprovalIds: ['appr_1'],
        updatedAt: '2026-03-29T12:01:00.000Z',
      },
      notices: [
        {
          kind: 'awaiting_approval',
          code: 'AWAITING_APPROVAL',
          message: '操作需要人工审批后继续。',
          approvalIds: ['appr_1'],
        },
      ],
      processTrace: {
        version: 1,
        messages: [{ id: 'proc-1', type: 'thinking', data: { text: '分析中' } }],
      },
    })

    const handler = getRouteHandler('/:id/view', 'get')
    const req = { params: { id: 'sess-1' }, user: { userId: 'user-1' } }
    const res = { json: vi.fn() }
    const next = vi.fn()

    await handler(req, res, next)

    expect(mockSessionService.getSessionView).toHaveBeenCalledWith('sess-1')
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: expect.objectContaining({
        session: expect.objectContaining({ id: 'sess-1' }),
        messages: [
          expect.objectContaining({
            id: 'msg-user-1',
            role: 'user',
          }),
        ],
        runState: expect.objectContaining({
          status: 'awaiting_approval',
          pendingApprovalIds: ['appr_1'],
        }),
        notices: [
          expect.objectContaining({
            kind: 'awaiting_approval',
            approvalIds: ['appr_1'],
          }),
        ],
        processTrace: expect.objectContaining({
          version: 1,
        }),
      }),
    })
    expect(next).not.toHaveBeenCalled()
  })

  it('GET /attempts/:attemptId returns attempt scoped payload', async () => {
    mockSessionService.getRuntimeAttemptView.mockResolvedValue({
      attempt: {
        id: 'att-1',
        sessionId: 'sess-1',
        userMessageId: 'msg-user-1',
        agentId: 'agent-1',
        attemptSeq: 1,
        executionMode: 'unknown',
        status: 'running',
        approvalSetRevision: 0,
        approvalBlockCount: 0,
        resumeCount: 0,
        startedAt: '2026-03-29T12:00:00.000Z',
        updatedAt: '2026-03-29T12:00:05.000Z',
      },
      session: {
        id: 'sess-1',
        agentId: 'agent-1',
        userId: 'user-1',
        status: 'active',
        createdAt: '2026-03-29T12:00:00.000Z',
        startedAt: '2026-03-29T12:00:00.000Z',
      },
      messages: [],
      latestCheckpoint: {
        checkpointId: 'chk-1',
        attemptId: 'att-1',
        sessionId: 'sess-1',
        userMessageId: 'msg-user-1',
        status: 'running',
        revision: 3,
        payload: {
          status: 'running',
        },
        createdAt: '2026-03-29T12:00:05.000Z',
      },
      eventOutbox: [
        {
          id: 'evt-out-1',
          revision: 3,
          eventType: 'task.running',
          status: 'delivered',
          createdAt: '2026-03-29T12:00:05.000Z',
        },
      ],
      checkpointOutbox: [
        {
          id: 'chk-out-1',
          checkpointId: 'chk-1',
          revision: 3,
          projectionTarget: 'local_file',
          status: 'delivered',
          createdAt: '2026-03-29T12:00:05.000Z',
        },
      ],
      runState: null,
      notices: [],
      processTrace: null,
    })

    const handler = getRouteHandler('/attempts/:attemptId', 'get')
    const req = { params: { attemptId: 'att-1' }, user: { userId: 'user-1' } }
    const res = { json: vi.fn() }
    const next = vi.fn()

    await handler(req, res, next)

    expect(mockSessionService.getRuntimeAttemptView).toHaveBeenCalledWith('att-1')
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: expect.objectContaining({
        attempt: expect.objectContaining({ id: 'att-1' }),
        session: expect.objectContaining({ id: 'sess-1' }),
        latestCheckpoint: expect.objectContaining({ checkpointId: 'chk-1', revision: 3 }),
        eventOutbox: [expect.objectContaining({ id: 'evt-out-1', eventType: 'task.running' })],
        checkpointOutbox: [expect.objectContaining({ id: 'chk-out-1', checkpointId: 'chk-1' })],
      }),
    })
    expect(next).not.toHaveBeenCalled()
  })
})
