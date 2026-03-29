import { afterEach, describe, expect, it, vi } from 'vitest'

describe('runtime-attempt-commit.service', () => {
  afterEach(async () => {
    const { closeLocalDb } = await import('../lib/db-local')
    closeLocalDb()
    delete process.env.SEMIBOT_DB_PATH
    vi.resetModules()
  })

  it('commits awaiting_approval state with checkpoint and active session projection', async () => {
    process.env.SEMIBOT_DB_PATH = `/tmp/semibot-attempt-commit-${Date.now()}.sqlite`
    vi.resetModules()

    const store = await import('../lib/session-local-store')
    const commitService = await import('../services/runtime-attempt-commit.service')

    const session = store.localCreateSession({
      agentId: 'agent-1',
      userId: 'user-1',
      title: 'commit state',
    })
    const user = store.localCreateMessage({
      sessionId: session.id,
      role: 'user',
      content: '请执行高风险操作',
    })
    const attempt = store.localCreateRuntimeAttempt({
      sessionId: session.id,
      userMessageId: user.id,
      agentId: 'agent-1',
      status: 'running',
    })

    const committed = await commitService.commitAttemptState({
      attemptId: attempt.id,
      sessionId: session.id,
      userMessageId: user.id,
      status: 'awaiting_approval',
      approvalBlockCount: 1,
      approvalSetRevision: 1,
      checkpointPayload: {
        pending_approval_ids: ['appr_1'],
      },
    })

    expect(committed.status).toBe('awaiting_approval')
    expect(committed.latestRevision).toBe(1)
    const currentAttempt = store.localFindRuntimeAttemptById(attempt.id)
    expect(currentAttempt?.checkpoint_id).toBeTruthy()
    expect(currentAttempt?.latest_revision).toBe(1)
    expect(currentAttempt?.leased_by).toBeNull()
    expect(store.localFindSessionById(session.id)?.status).toBe('active')
    const eventOutbox = store.localListEventOutboxByAttemptId(attempt.id)
    const checkpointOutbox = store.localListCheckpointOutboxByAttemptId(attempt.id)
    expect(eventOutbox).toHaveLength(1)
    expect(eventOutbox[0]?.event_type).toBe('task.awaiting_approval')
    expect(eventOutbox[0]?.revision).toBe(1)
    expect(checkpointOutbox).toHaveLength(1)
    expect(checkpointOutbox[0]?.revision).toBe(1)
  })

  it('commits completed terminal with session projection and artifact binding', async () => {
    process.env.SEMIBOT_DB_PATH = `/tmp/semibot-attempt-terminal-${Date.now()}.sqlite`
    vi.resetModules()

    const store = await import('../lib/session-local-store')
    const commitService = await import('../services/runtime-attempt-commit.service')

    const session = store.localCreateSession({
      agentId: 'agent-1',
      userId: 'user-1',
      title: 'commit terminal',
    })
    const user = store.localCreateMessage({
      sessionId: session.id,
      role: 'user',
      content: '搜索最新 AI 动态',
    })
    const attempt = store.localCreateRuntimeAttempt({
      sessionId: session.id,
      userMessageId: user.id,
      agentId: 'agent-1',
      status: 'running',
    })
    const assistant = store.localCreateMessage({
      sessionId: session.id,
      attemptId: attempt.id,
      userMessageId: user.id,
      role: 'assistant',
      content: '总结结果',
    })

    const committed = await commitService.commitAttemptTerminal({
      attemptId: attempt.id,
      sessionId: session.id,
      userMessageId: user.id,
      status: 'completed',
      terminalReason: 'completed_normally',
      artifactMessageId: assistant.id,
      checkpointPayload: {
        final_response: '总结结果',
      },
    })

    expect(committed.status).toBe('completed')
    expect(committed.latestRevision).toBe(1)
    expect(committed.artifactMessageId).toBe(assistant.id)
    expect(store.localFindSessionById(session.id)?.status).toBe('completed')
    expect(store.localFindRuntimeAttemptById(attempt.id)?.checkpoint_id).toBeTruthy()
    expect(store.localFindRuntimeAttemptById(attempt.id)?.latest_revision).toBe(1)
    const eventOutbox = store.localListEventOutboxByAttemptId(attempt.id)
    const checkpointOutbox = store.localListCheckpointOutboxByAttemptId(attempt.id)
    expect(eventOutbox).toHaveLength(1)
    expect(eventOutbox[0]?.event_type).toBe('task.completed')
    expect(eventOutbox[0]?.revision).toBe(1)
    expect(checkpointOutbox).toHaveLength(1)
    expect(checkpointOutbox[0]?.revision).toBe(1)
  })
})
