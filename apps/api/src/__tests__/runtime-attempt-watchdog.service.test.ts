import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockSessionService = vi.hoisted(() => ({
  listStalledRuntimeAttempts: vi.fn(),
  claimRuntimeAttemptLease: vi.fn(),
  commitAttemptTerminal: vi.fn(),
}))

vi.mock('../services/session.service', () => mockSessionService)

describe('runtime-attempt-watchdog.service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fails only stalled running attempts that can be claimed by watchdog', async () => {
    mockSessionService.listStalledRuntimeAttempts.mockResolvedValue([
      {
        id: 'att-running',
        sessionId: 'sess-1',
        userMessageId: 'msg-1',
        status: 'running',
      },
      {
        id: 'att-awaiting',
        sessionId: 'sess-1',
        userMessageId: 'msg-1',
        status: 'awaiting_approval',
      },
    ])
    mockSessionService.claimRuntimeAttemptLease
      .mockResolvedValueOnce({
        id: 'att-running',
        sessionId: 'sess-1',
        userMessageId: 'msg-1',
        status: 'running',
      })
      .mockResolvedValueOnce(null)
    mockSessionService.commitAttemptTerminal.mockResolvedValue({
      id: 'att-running',
      status: 'failed',
    })

    const { sweepStalledRuntimeAttempts } = await import('../services/runtime-attempt-watchdog.service')
    const result = await sweepStalledRuntimeAttempts()

    expect(result).toEqual({
      scanned: 2,
      failed: ['att-running'],
    })
    expect(mockSessionService.commitAttemptTerminal).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'att-running',
      status: 'failed',
      terminalReason: 'stalled_execution',
    }))
  })
})
