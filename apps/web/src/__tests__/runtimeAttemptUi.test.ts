import { describe, expect, it } from 'vitest'
import type { ApprovalRecord, EventRecord } from '@/types'
import {
  extractApprovalAttemptId,
  extractApprovalSessionId,
  getEventAttemptId,
  getEventSessionId,
  tailId,
} from '@/lib/runtime-attempt-ui'

describe('runtime attempt ui helpers', () => {
  it('extracts approval session and attempt ids from explicit fields', () => {
    const approval: ApprovalRecord = {
      id: 'appr-1',
      sessionId: 'sess-1234567890',
      attemptId: 'att-abcdef123456',
      status: 'pending',
      riskLevel: 'medium',
      createdAt: '2026-03-30T00:00:00.000Z',
    }

    expect(extractApprovalSessionId(approval)).toBe('sess-1234567890')
    expect(extractApprovalAttemptId(approval)).toBe('att-abcdef123456')
  })

  it('extracts approval session and attempt ids from context fallback keys', () => {
    const approval: ApprovalRecord = {
      id: 'appr-2',
      status: 'pending',
      riskLevel: 'high',
      createdAt: '2026-03-30T00:00:00.000Z',
      context: {
        runtime_session_id: 'sess-runtime-1',
        attempt_id: 'att-runtime-1',
      },
    }

    expect(extractApprovalSessionId(approval)).toBe('sess-runtime-1')
    expect(extractApprovalAttemptId(approval)).toBe('att-runtime-1')
  })

  it('extracts session and attempt ids from runtime event payloads', () => {
    const event: EventRecord = {
      id: 'evt-1',
      eventType: 'task.completed',
      source: 'runtime',
      createdAt: '2026-03-30T00:00:00.000Z',
      payload: {
        session_id: 'sess-evt-1',
        attempt_id: 'att-evt-1',
      },
    }

    expect(getEventSessionId(event)).toBe('sess-evt-1')
    expect(getEventAttemptId(event)).toBe('att-evt-1')
  })

  it('formats long ids as tails', () => {
    expect(tailId('abcdef1234567890', 6)).toBe('…567890')
    expect(tailId('short', 6)).toBe('short')
  })
})
