import { describe, expect, it } from 'vitest'
import type { RuntimeAttemptView } from '@/types'
import { buildAttemptDetailContent, buildAttemptDetailTitle } from '@/lib/runtime-attempt-detail'

describe('runtime attempt detail helper', () => {
  it('builds attempt detail payload with checkpoint and outbox summary', () => {
    const view: RuntimeAttemptView = {
      attempt: {
        id: 'att-1234567890',
        sessionId: 'sess-1',
        userMessageId: 'msg-user-1',
        agentId: 'agent-1',
        attemptSeq: 1,
        executionMode: 'direct_reasoning',
        status: 'awaiting_approval',
        approvalSetRevision: 2,
        approvalBlockCount: 1,
        resumeCount: 1,
        latestRevision: 4,
        startedAt: '2026-03-30T00:00:00.000Z',
        updatedAt: '2026-03-30T00:01:00.000Z',
      },
      session: {
        id: 'sess-1',
        agentId: 'agent-1',
        userId: 'user-1',
        status: 'active',
        createdAt: '2026-03-30T00:00:00.000Z',
        startedAt: '2026-03-30T00:00:00.000Z',
        metadata: {},
      },
      messages: [],
      latestCheckpoint: {
        checkpointId: 'chk-1',
        attemptId: 'att-1234567890',
        sessionId: 'sess-1',
        userMessageId: 'msg-user-1',
        status: 'awaiting_approval',
        revision: 4,
        createdAt: '2026-03-30T00:01:00.000Z',
      },
      eventOutbox: [{ id: 'evt-1', revision: 4, eventType: 'task.awaiting_approval', status: 'pending', createdAt: '2026-03-30T00:01:00.000Z' }],
      checkpointOutbox: [{ id: 'chk-out-1', checkpointId: 'chk-1', revision: 4, projectionTarget: 'local_file', status: 'delivered', createdAt: '2026-03-30T00:01:00.000Z' }],
      runState: null,
      notices: [{ kind: 'awaiting_approval', code: 'AWAITING_APPROVAL', message: '操作需要人工审批后继续。' }],
      processTrace: null,
    }

    const detail = buildAttemptDetailContent(view, 'zh-CN')
    expect(detail.kind).toBe('runtime-attempt')
    expect(detail.attemptId).toBe('att-1234567890')
    expect(detail.status).toBe('awaiting_approval')
    expect(detail.pendingEventOutboxCount).toBe(1)
    expect(detail.notices[0]?.message).toContain('操作需要人工审批后继续')
    expect(buildAttemptDetailTitle('att-1234567890')).toBe('Attempt …34567890')
  })
})
