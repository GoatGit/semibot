import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

describe('runtime-attempt-outbox.service', () => {
  afterEach(async () => {
    const { closeLocalDb } = await import('../lib/db-local')
    closeLocalDb()
    delete process.env.SEMIBOT_DB_PATH
    delete process.env.SEMIBOT_RUNTIME_ATTEMPT_OUTBOX_DIR
    vi.resetModules()
  })

  it('sweeps pending event_outbox and checkpoint_outbox to local projection files', async () => {
    process.env.SEMIBOT_DB_PATH = `/tmp/semibot-attempt-outbox-${Date.now()}.sqlite`
    process.env.SEMIBOT_RUNTIME_ATTEMPT_OUTBOX_DIR = `/tmp/semibot-attempt-outbox-files-${Date.now()}`
    vi.resetModules()

    const store = await import('../lib/session-local-store')
    const commitService = await import('../services/runtime-attempt-commit.service')
    const outboxService = await import('../services/runtime-attempt-outbox.service')

    const session = store.localCreateSession({
      agentId: 'agent-1',
      userId: 'user-1',
      title: 'outbox test',
    })
    const user = store.localCreateMessage({
      sessionId: session.id,
      role: 'user',
      content: '请总结最新 AI 动态',
    })
    const attempt = store.localCreateRuntimeAttempt({
      sessionId: session.id,
      userMessageId: user.id,
      agentId: 'agent-1',
      status: 'running',
    })
    const root = process.env.SEMIBOT_RUNTIME_ATTEMPT_OUTBOX_DIR!
    await fs.rm(path.join(root, 'events', attempt.id), { recursive: true, force: true })
    await fs.rm(path.join(root, 'checkpoints', attempt.id), { recursive: true, force: true })

    await commitService.commitAttemptState({
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

    const result = await outboxService.sweepRuntimeAttemptOutbox({ limit: 10 })
    expect(result.eventDelivered).toBe(1)
    expect(result.checkpointDelivered).toBe(1)

    const pendingEvents = store.localListPendingEventOutbox(10)
    const pendingCheckpoints = store.localListPendingCheckpointOutbox(10)
    expect(pendingEvents).toHaveLength(0)
    expect(pendingCheckpoints).toHaveLength(0)

    const eventDir = path.join(root, 'events', attempt.id)
    const checkpointDir = path.join(root, 'checkpoints', attempt.id)
    const eventFiles = await fs.readdir(eventDir)
    const checkpointFiles = await fs.readdir(checkpointDir)
    expect(eventFiles.some((name) => name.includes('task.awaiting_approval'))).toBe(true)
    expect(checkpointFiles.length).toBeGreaterThan(0)
  })
})
