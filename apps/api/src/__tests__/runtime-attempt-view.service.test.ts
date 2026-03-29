import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/runtime-client', () => ({
  runtimeRequest: vi.fn(async () => {
    throw new Error('runtime unavailable')
  }),
}))

describe('runtime attempt view service', () => {
  afterEach(async () => {
    const { closeLocalDb } = await import('../lib/db-local')
    closeLocalDb()
    delete process.env.SEMIBOT_DB_PATH
    vi.resetModules()
  })

  it('returns latestCheckpoint and outbox projection for attempt detail view', async () => {
    process.env.SEMIBOT_DB_PATH = `/tmp/semibot-attempt-view-${Date.now()}.sqlite`
    vi.resetModules()

    const store = await import('../lib/session-local-store')
    const commitService = await import('../services/runtime-attempt-commit.service')
    const sessionService = await import('../services/session.service')

    const session = store.localCreateSession({
      agentId: 'agent-1',
      userId: 'user-1',
      title: 'attempt view',
    })
    const user = store.localCreateMessage({
      sessionId: session.id,
      role: 'user',
      content: '搜索并总结',
    })
    const attempt = store.localCreateRuntimeAttempt({
      sessionId: session.id,
      userMessageId: user.id,
      agentId: 'agent-1',
      status: 'running',
    })

    await commitService.commitAttemptState({
      attemptId: attempt.id,
      sessionId: session.id,
      userMessageId: user.id,
      status: 'awaiting_approval',
      approvalBlockCount: 1,
      approvalSetRevision: 1,
      revision: 5,
      checkpointPayload: {
        status: 'awaiting_approval',
        pending_approval_ids: ['appr_1'],
      },
    })

    const view = await sessionService.getRuntimeAttemptView(attempt.id)
    expect(view.attempt.id).toBe(attempt.id)
    expect(view.attempt.latestRevision).toBe(5)
    expect(view.latestCheckpoint).toMatchObject({
      attemptId: attempt.id,
      revision: 5,
      status: 'awaiting_approval',
    })
    expect(view.eventOutbox).toEqual([
      expect.objectContaining({
        revision: 5,
        eventType: 'task.awaiting_approval',
        status: 'pending',
      }),
    ])
    expect(view.checkpointOutbox).toEqual([
      expect.objectContaining({
        revision: 5,
        checkpointId: expect.any(String),
        projectionTarget: 'local_file',
        status: 'pending',
      }),
    ])
  })
})
