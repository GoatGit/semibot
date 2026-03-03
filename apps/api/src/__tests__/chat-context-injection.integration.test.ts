import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Response } from 'express'

const {
  mockSessionService,
  mockAgentService,
  mockMcpService,
  mockWs,
  mockVMScheduler,
  mockContextPolicyService,
  mockEvolutionCapabilityService,
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
  mockContextPolicyService: {
    getActivePolicies: vi.fn(),
    buildPolicyInjectionBlock: vi.fn(),
  },
  mockEvolutionCapabilityService: {
    getActiveCapabilities: vi.fn(),
    buildCapabilityInjectionBlock: vi.fn(),
  },
}))

vi.mock('../services/session.service', () => mockSessionService)
vi.mock('../services/agent.service', () => mockAgentService)
vi.mock('../services/mcp.service', () => mockMcpService)
vi.mock('../scheduler/vm-scheduler', () => mockVMScheduler)
vi.mock('../services/context-policy.service', () => mockContextPolicyService)
vi.mock('../services/evolution-capability.service', () => mockEvolutionCapabilityService)
vi.mock('../ws/ws-server', () => ({
  getWSServer: () => mockWs,
}))

function createMockRes(): Response & { _emit: (event: string) => void } {
  const listeners: Record<string, Array<() => void>> = {}
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

describe('chat context injection (execution plane)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    process.env.CHAT_DIRECT_RUNTIME = 'false'

    mockWs.isUserReady.mockReturnValue(true)
    mockVMScheduler.ensureUserVM.mockResolvedValue({ ready: true, status: 'ready' })

    mockSessionService.getSession.mockResolvedValue({
      id: 'sess-1',
      agentId: 'agent-1',
      runtimeType: 'semigraph',
    })
    mockSessionService.addMessage.mockResolvedValue({ id: 'msg-user-1' })
    mockSessionService.getSessionMessages.mockResolvedValue([{ role: 'user', content: 'hello' }])

    mockAgentService.getAgent.mockResolvedValue({
      id: 'agent-1',
      name: 'agent',
      systemPrompt: 'base system prompt',
      config: { model: 'gpt-4o', temperature: 0.2, maxTokens: 1024 },
      skills: [],
      runtimeType: 'semigraph',
    })

    mockMcpService.getMcpServersForRuntime.mockResolvedValue([])
    mockContextPolicyService.getActivePolicies.mockResolvedValue([
      { docType: 'gene', content: 'GENE policy', version: 'v1', status: 'approved', id: '1', updatedAt: '' },
      { docType: 'agents', content: 'AGENTS policy', version: 'v1', status: 'approved', id: '2', updatedAt: '' },
      { docType: 'tools', content: 'TOOLS policy', version: 'v1', status: 'approved', id: '3', updatedAt: '' },
    ])
    mockContextPolicyService.buildPolicyInjectionBlock.mockReturnValue(
      '<policy_gene>GENE policy</policy_gene>\n<policy_agents>AGENTS policy</policy_agents>\n<policy_tools>TOOLS policy</policy_tools>'
    )
    mockEvolutionCapabilityService.getActiveCapabilities.mockResolvedValue([
      { capabilityType: 'mind', content: 'MIND content', version: 'v1', id: 'm1', updatedAt: '' },
      { capabilityType: 'guard', content: 'GUARD content', version: 'v1', id: 'g1', updatedAt: '' },
    ])
    mockEvolutionCapabilityService.buildCapabilityInjectionBlock.mockReturnValue(
      '<capability_mind>MIND content</capability_mind>\n<capability_guard>GUARD content</capability_guard>'
    )
  })

  it('injects context policy block into system_prompt for start_session', async () => {
    const { handleChat } = await import('../services/chat.service')
    const res = createMockRes()

    await handleChat('org-1', 'user-1', 'sess-1', { message: 'hello' }, res)

    expect(mockWs.sendStartSession).toHaveBeenCalledTimes(1)
    const payload = mockWs.sendStartSession.mock.calls[0][1]
    const systemPrompt = String(payload?.agent_config?.system_prompt || '')

    expect(mockContextPolicyService.getActivePolicies).toHaveBeenCalledWith('org-1')
    expect(mockEvolutionCapabilityService.getActiveCapabilities).toHaveBeenCalledWith('org-1')
    expect(systemPrompt).toContain('base system prompt')
    expect(systemPrompt).toContain('当前日期:')
    expect(systemPrompt).toContain('<policy_gene>')
    expect(systemPrompt).toContain('GENE policy')
    expect(systemPrompt).toContain('<policy_tools>')
    expect(systemPrompt).toContain('<capability_mind>')
    expect(systemPrompt).toContain('MIND content')

    res._emit('close')
  })
})
