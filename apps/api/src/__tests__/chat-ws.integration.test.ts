import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Response } from 'express'

const {
  mockSessionService,
  mockAgentService,
  mockMcpService,
  mockWs,
  mockVMScheduler,
} = vi.hoisted(() => ({
  mockSessionService: {
    getSession: vi.fn(),
    addMessage: vi.fn(),
    getSessionMessages: vi.fn(),
  },
  mockAgentService: {
    getAgent: vi.fn(),
  },
  mockMcpService: {
    getMcpServersForRuntime: vi.fn(),
  },
  mockWs: {
    isUserReady: vi.fn(),
    sendStartSession: vi.fn(),
    sendUserMessage: vi.fn(),
    sendCancel: vi.fn(),
  },
  mockVMScheduler: {
    ensureUserVM: vi.fn(),
    getUserVMStatus: vi.fn(),
    forceRebootstrap: vi.fn(),
  },
}))

vi.mock('../services/session.service', () => mockSessionService)
vi.mock('../services/agent.service', () => mockAgentService)
vi.mock('../services/mcp.service', () => mockMcpService)
vi.mock('../ws/ws-server', () => ({
  getWSServer: () => mockWs,
}))
vi.mock('../scheduler/vm-scheduler', () => mockVMScheduler)

import { handleChat } from '../services/chat.service'

function createMockRes(): Response {
  const listeners: Record<string, (() => void)[]> = {}
  const res = {
    req: { headers: {} },
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn().mockReturnValue(true),
    on: vi.fn((event: string, cb: () => void) => {
      listeners[event] ??= []
      listeners[event].push(cb)
      return res
    }),
    end: vi.fn(),
    _emit: (event: string) => {
      for (const cb of listeners[event] ?? []) cb()
    },
  } as unknown as Response & { _emit: (event: string) => void }
  return res
}

describe('chat ws integration (mocked)', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mockWs.isUserReady.mockReturnValue(true)
    mockVMScheduler.ensureUserVM.mockResolvedValue({ ready: true, status: 'ready' })

    mockSessionService.getSession.mockResolvedValue({
      id: 'sess-1',
      agentId: 'agent-1',
      runtimeType: 'semigraph',
    })

    mockAgentService.getAgent.mockResolvedValue({
      id: 'agent-1',
      name: 'agent',
      systemPrompt: 'hi',
      config: { model: 'gpt-4o', temperature: 0.2, maxTokens: 2000 },
      skills: [],
      runtimeType: 'semigraph',
    })

    mockSessionService.addMessage.mockResolvedValue({ id: 'msg-u-1' })
    mockSessionService.getSessionMessages.mockResolvedValue([
      { role: 'user', content: 'hello' },
    ])

    mockMcpService.getMcpServersForRuntime.mockResolvedValue([])
  })

  it('sends start_session + user_message through ws path', async () => {
    const res = createMockRes()

    await handleChat('org-1', 'user-1', 'sess-1', { message: 'hello' }, res)

    expect(mockWs.isUserReady).toHaveBeenCalledWith('user-1')
    expect(mockVMScheduler.ensureUserVM).toHaveBeenCalledWith('user-1', 'org-1', { wsReady: true })
    expect(mockWs.sendStartSession).toHaveBeenCalledTimes(1)
    expect(mockWs.sendStartSession.mock.calls[0][0]).toBe('user-1')
    expect(mockWs.sendStartSession.mock.calls[0][1]).toMatchObject({
      session_id: 'sess-1',
      runtime_type: 'semigraph',
      agent_id: 'agent-1',
    })

    expect(mockWs.sendUserMessage).toHaveBeenCalledWith(
      'user-1',
      'sess-1',
      expect.objectContaining({ message: 'hello' })
    )
  })

  it('throws when execution plane is not connected', async () => {
    mockWs.isUserReady.mockReturnValue(false)
    mockVMScheduler.ensureUserVM.mockResolvedValue({ ready: false, status: 'disconnected', retryAfterMs: 3500 })
    const res = createMockRes()

    await expect(handleChat('org-1', 'user-1', 'sess-1', { message: 'hello' }, res)).rejects.toMatchObject({
      code: 'LLM_UNAVAILABLE',
      message: expect.stringContaining('建议 4 秒后重试'),
    })
    expect(mockWs.sendStartSession).not.toHaveBeenCalled()
  })
})
