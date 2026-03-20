import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Response } from 'express'

const {
  mockSessionService,
  mockAgentService,
  mockMcpService,
} = vi.hoisted(() => ({
  mockSessionService: {
    getSession: vi.fn(),
    addMessage: vi.fn(),
    getSessionMessages: vi.fn(),
    createSession: vi.fn(),
    updateSessionStatus: vi.fn(),
  },
  mockAgentService: {
    getAgent: vi.fn(),
  },
  mockMcpService: {
    getMcpServersForRuntime: vi.fn(),
  },
}))

vi.mock('../services/session.service', () => mockSessionService)
vi.mock('../services/agent.service', () => mockAgentService)
vi.mock('../services/mcp.service', () => mockMcpService)
vi.mock('../services/context-policy.service', () => ({
  getActivePolicies: vi.fn().mockResolvedValue([]),
  buildPolicyInjectionBlock: vi.fn().mockReturnValue(''),
}))
vi.mock('../services/evolution-capability.service', () => ({
  getActiveCapabilities: vi.fn().mockResolvedValue([]),
  buildCapabilityInjectionBlock: vi.fn().mockReturnValue(''),
}))
vi.mock('../repositories/skill-definition.repository', () => ({
  findById: vi.fn(),
  findBySkillId: vi.fn(),
}))
vi.mock('../repositories/skill-package.repository', () => ({
  findByDefinition: vi.fn(),
}))
vi.mock('../ws/ws-server', () => ({
  getWSServer: () => ({
    isUserReady: vi.fn().mockReturnValue(true),
    sendStartSession: vi.fn(),
    sendUserMessage: vi.fn(),
    sendCancel: vi.fn(),
  }),
}))

function createMockRes(): Response {
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
  } as unknown as Response
  return res
}

describe('chat direct runtime skill index', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    process.env.CHAT_DIRECT_RUNTIME = 'true'
    process.env.RUNTIME_URL = 'http://127.0.0.1:8765'

    mockSessionService.getSession.mockResolvedValue({
      id: 'sess-1',
      agentId: 'agent-system',
    })
    mockSessionService.addMessage
      .mockResolvedValueOnce({ id: 'msg-user-1' })
      .mockResolvedValueOnce({ id: 'msg-assistant-1' })
    mockSessionService.updateSessionStatus.mockResolvedValue({
      id: 'sess-1',
      agentId: 'agent-system',
      status: 'completed',
    })
    mockSessionService.getSessionMessages.mockResolvedValue([{ role: 'user', content: 'hello' }])

    mockAgentService.getAgent.mockResolvedValue({
      id: 'agent-system',
      name: '系统助手',
      systemPrompt: 'You are a helpful AI assistant.',
      config: { model: 'gpt-4o', temperature: 0.7, maxTokens: 4096 },
      skills: [],
      isSystem: true,
    })

    mockMcpService.getMcpServersForRuntime.mockResolvedValue([])
  })

  it('sends runtime skill_index for system agent in direct mode', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/v1/skills')) {
        return new Response(
          JSON.stringify({
            metadata: [
              {
                skill_id: 'deep-research',
                name: 'deep-research',
                description: 'Deep research workflow',
                status: 'active',
                enabled: true,
                has_skill_md: true,
                script_files: ['scripts/research_engine.py', 'scripts/validate_report.py'],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      if (input.includes('/api/v1/chat/sessions/')) {
        return new Response(
          JSON.stringify({
            status: 'completed',
            final_response: 'ok',
            error: null,
            runtime_events: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      throw new Error(`unexpected fetch url: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { handleChat } = await import('../services/chat.service')
    await handleChat('org-1', 'user-1', 'sess-1', { message: '使用deep-research技能研究腾讯股票' }, createMockRes())

    const runtimeCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/v1/chat/sessions/'))
    expect(runtimeCall).toBeTruthy()
    const body = JSON.parse(String(runtimeCall?.[1]?.body || '{}')) as {
      skill_index?: Array<{ id?: string }>
    }
    const ids = Array.isArray(body.skill_index) ? body.skill_index.map((row) => String(row.id || '')) : []
    expect(ids).toContain('deep-research')
  })

  it('relays direct runtime stream events to SSE and stores execution process metadata', async () => {
    const mockRes = createMockRes()
    mockSessionService.addMessage
      .mockResolvedValueOnce({ id: 'msg-user-1' })
      .mockResolvedValueOnce({ id: 'msg-assistant-1' })

    const sseFrames = [
      'data: {"event":"start","session_id":"sess-1","agent_id":"agent-system"}\n\n',
      'data: {"event":"thinking","data":{"content":"正在分析"}}\n\n',
      'data: {"event":"planner.llm_call_started","data":{"turn_index":0,"model":"kimi-k2.5","tools_enabled":true,"compact_mode":false}}\n\n',
      'data: {"event":"planner.llm_call_completed","data":{"turn_index":0,"model":"kimi-k2.5","tools_enabled":true,"compact_mode":false,"duration_ms":12345,"finish_reason":"stop","usage":{"input_tokens":12,"output_tokens":34},"tool_call_count":1,"content_len":456}}\n\n',
      'data: {"event":"act_decision","data":{"step_id":"1","title":"Phase 1: SCOPE","planner_tool":"search","decision":"tool_call","tool_name":"code_executor","arguments":{"language":"python"}}}\n\n',
      'data: {"event":"tool.exec.started","data":{"tool_name":"search","params":{"query":"腾讯股票"}}}\n\n',
      'data: {"event":"tool.exec.completed","data":{"tool_name":"search","result":{"items":[1]},"success":true}}\n\n',
      'data: {"event":"done","status":"completed","final_response":"研究完成","session_id":"sess-1","agent_id":"agent-system"}\n\n',
    ].join('')

    const fetchMock = vi.fn(async (input: string) => {
      if (input.endsWith('/v1/skills')) {
        return new Response(JSON.stringify({ metadata: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (input.includes('/api/v1/chat/sessions/')) {
        return new Response(sseFrames, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      throw new Error(`unexpected fetch url: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { handleChat } = await import('../services/chat.service')
    await handleChat('org-1', 'user-1', 'sess-1', { message: '研究腾讯股票' }, mockRes)

    const writes = (mockRes.write as unknown as ReturnType<typeof vi.fn>).mock.calls.map((args) => String(args[0]))
    expect(writes.some((line) => line.includes('event: message'))).toBe(true)
    expect(writes.some((line) => line.includes('"stage":"planning"'))).toBe(true)
    expect(writes.some((line) => line.includes('"type":"thinking"'))).toBe(true)
    expect(writes.some((line) => line.includes('"toolName":"planner_llm"'))).toBe(true)
    expect(writes.some((line) => line.includes('"toolName":"act_decision"'))).toBe(true)
    expect(writes.some((line) => line.includes('"type":"tool_call"'))).toBe(true)
    expect(writes.some((line) => line.includes('"type":"tool_result"'))).toBe(true)
    expect(writes.some((line) => line.includes('"content":"研究完成"'))).toBe(true)

    expect(mockSessionService.addMessage).toHaveBeenLastCalledWith('org-1', 'sess-1', expect.objectContaining({
      role: 'assistant',
      content: '研究完成',
      metadata: expect.objectContaining({
        execution_process: expect.objectContaining({
          version: 1,
          messages: expect.arrayContaining([
            expect.objectContaining({ type: 'thinking' }),
            expect.objectContaining({
              type: 'tool_result',
              data: expect.objectContaining({ toolName: 'planner_llm' }),
            }),
            expect.objectContaining({
              type: 'tool_result',
              data: expect.objectContaining({ toolName: 'act_decision' }),
            }),
            expect.objectContaining({ type: 'tool_call' }),
            expect.objectContaining({ type: 'tool_result' }),
          ]),
        }),
      }),
    }))
    expect(mockSessionService.updateSessionStatus).toHaveBeenCalledWith('org-1', 'sess-1', 'completed')
  })

  it('relays failure_reflection as process tool_result', async () => {
    const mockRes = createMockRes()
    mockSessionService.addMessage
      .mockResolvedValueOnce({ id: 'msg-user-1' })
      .mockResolvedValueOnce({ id: 'msg-assistant-1' })

    const sseFrames = [
      'data: {"event":"start","session_id":"sess-1","agent_id":"agent-system"}\n\n',
      'data: {"event":"failure_reflection","data":{"content":"[SYSTEM] FAILURE REFLECTION\\n\\nObserved Failures\\n- file_io: File not found"}}\n\n',
      'data: {"event":"done","status":"completed","final_response":"已结束","session_id":"sess-1","agent_id":"agent-system"}\n\n',
    ].join('')

    const fetchMock = vi.fn(async (input: string) => {
      if (input.endsWith('/v1/skills')) {
        return new Response(JSON.stringify({ metadata: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (input.includes('/api/v1/chat/sessions/')) {
        return new Response(sseFrames, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      throw new Error(`unexpected fetch url: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { handleChat } = await import('../services/chat.service')
    await handleChat('org-1', 'user-1', 'sess-1', { message: '研究腾讯股票' }, mockRes)

    const writes = (mockRes.write as unknown as ReturnType<typeof vi.fn>).mock.calls.map((args) => String(args[0]))
    expect(writes.some((line) => line.includes('"toolName":"failure_reflection"'))).toBe(true)
  })

  it('relays approval.requested as approval-pending process message', async () => {
    const mockRes = createMockRes()
    mockSessionService.addMessage
      .mockResolvedValueOnce({ id: 'msg-user-1' })
      .mockResolvedValueOnce({ id: 'msg-assistant-1' })

    const sseFrames = [
      'data: {"event":"start","session_id":"sess-1","agent_id":"agent-system"}\n\n',
      'data: {"event":"approval.requested","data":{"approval_id":"appr_test","rule_id":"tool.semi_browser","risk_level":"high","status":"pending","context":{"tool_name":"semi_browser"}}}\n\n',
      'data: {"event":"done","status":"completed","final_response":"等待审批","session_id":"sess-1","agent_id":"agent-system"}\n\n',
    ].join('')

    const fetchMock = vi.fn(async (input: string) => {
      if (input.endsWith('/v1/skills')) {
        return new Response(JSON.stringify({ metadata: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (input.includes('/api/v1/chat/sessions/')) {
        return new Response(sseFrames, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      throw new Error(`unexpected fetch url: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { handleChat } = await import('../services/chat.service')
    await handleChat('org-1', 'user-1', 'sess-1', { message: '打开新闻网站' }, mockRes)

    const writes = (mockRes.write as unknown as ReturnType<typeof vi.fn>).mock.calls.map((args) => String(args[0]))
    expect(writes.some((line) => line.includes('"toolName":"approval"'))).toBe(true)
    expect(writes.some((line) => line.includes('"error":"approval_pending"'))).toBe(true)
  })

  it('persists waiting-for-approval assistant message when tool.exec.pending_approval is returned', async () => {
    const mockRes = createMockRes()
    mockSessionService.addMessage
      .mockResolvedValueOnce({ id: 'msg-user-1' })
      .mockResolvedValueOnce({ id: 'msg-assistant-1' })

    const sseFrames = [
      'data: {"event":"start","session_id":"sess-1","agent_id":"agent-system"}\n\n',
      'data: {"event":"tool.exec.pending_approval","approval_id":"appr_pending_1","data":{"tool_name":"semi_browser","approval_id":"appr_pending_1","status":"pending","message":"需要人工审批"}}\n\n',
      'data: {"event":"done","status":"completed","final_response":"操作需要人工审批后继续。","session_id":"sess-1","agent_id":"agent-system"}\n\n',
    ].join('')

    const fetchMock = vi.fn(async (input: string) => {
      if (input.endsWith('/v1/skills')) {
        return new Response(JSON.stringify({ metadata: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (input.includes('/api/v1/chat/sessions/')) {
        return new Response(sseFrames, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      throw new Error(`unexpected fetch url: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { handleChat } = await import('../services/chat.service')
    await handleChat('org-1', 'user-1', 'sess-1', { message: '打开新闻网站' }, mockRes)

    expect(mockSessionService.addMessage).toHaveBeenLastCalledWith(
      'org-1',
      'sess-1',
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining('appr_pending_1'),
      })
    )
  })
})
