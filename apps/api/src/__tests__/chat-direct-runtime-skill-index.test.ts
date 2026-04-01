import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Response } from 'express'

const {
  mockSessionService,
  mockRuntimeAttemptCommitService,
  mockAgentService,
  mockMcpService,
} = vi.hoisted(() => ({
  mockSessionService: {
    getSession: vi.fn(),
    addMessage: vi.fn(),
    createRuntimeAttempt: vi.fn(),
    updateRuntimeAttempt: vi.fn(),
    claimRuntimeAttemptLease: vi.fn(),
    heartbeatRuntimeAttempt: vi.fn(),
    listStalledRuntimeAttempts: vi.fn(),
    getSessionMessages: vi.fn(),
    createSession: vi.fn(),
    updateSessionStatus: vi.fn(),
  },
  mockRuntimeAttemptCommitService: {
    appendRuntimeAttemptCheckpointCommitted: vi.fn(),
    commitAttemptState: vi.fn(),
    commitAttemptTerminal: vi.fn(),
  },
  mockAgentService: {
    getAgent: vi.fn(),
    resolveRuntimeAgentConfig: vi.fn(),
  },
  mockMcpService: {
    getMcpServersForRuntime: vi.fn(),
  },
}))

vi.mock('../services/session.service', () => mockSessionService)
vi.mock('../services/runtime-attempt-commit.service', () => mockRuntimeAttemptCommitService)
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
    mockSessionService.createRuntimeAttempt.mockResolvedValue({
      id: 'att-1',
      sessionId: 'sess-1',
      userMessageId: 'msg-user-1',
      agentId: 'agent-system',
      status: 'running',
    })
    mockSessionService.updateRuntimeAttempt.mockResolvedValue({ id: 'att-1', status: 'completed' })
    mockSessionService.claimRuntimeAttemptLease.mockResolvedValue({ id: 'att-1', status: 'running' })
    mockSessionService.heartbeatRuntimeAttempt.mockResolvedValue({ id: 'att-1', status: 'running' })
    mockSessionService.listStalledRuntimeAttempts.mockResolvedValue([])
    mockRuntimeAttemptCommitService.appendRuntimeAttemptCheckpointCommitted.mockResolvedValue({ checkpointId: 'chk-1' })
    mockRuntimeAttemptCommitService.commitAttemptState.mockResolvedValue({ id: 'att-1', status: 'awaiting_approval' })
    mockRuntimeAttemptCommitService.commitAttemptTerminal.mockResolvedValue({ id: 'att-1', status: 'completed' })
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
    mockAgentService.resolveRuntimeAgentConfig.mockResolvedValue({
      model: 'gpt-4o',
      modelProviderKey: 'openai',
      temperature: 0.7,
      maxTokens: 4096,
      fallbackModel: undefined,
      fallbackProviderKey: undefined,
      modelRoles: undefined,
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
      if (input.endsWith('/v1/tools/catalog')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                tool_id: 'builtin:search',
                tool_name: 'search',
                actual_tool_name: 'search',
                display_name: 'search',
                description: 'Builtin search',
                source_type: 'builtin',
                provider_id: 'builtin',
                parameters: { type: 'object', properties: { query: { type: 'string' } } },
                metadata: { risk_level: 'low', requires_approval: false },
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
    await handleChat(
      'user-1',
      'sess-1',
      { message: '使用deep-research技能研究腾讯股票', userInvoked: true, userInvokedSkillIds: ['deep-research'] },
      createMockRes()
    )

    const runtimeCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/v1/chat/sessions/'))
    expect(runtimeCall).toBeTruthy()
    const body = JSON.parse(String(runtimeCall?.[1]?.body || '{}')) as {
      skill_index?: Array<{ id?: string }>
      capabilities?: Array<{ id?: string }>
      skillContext?: Array<{ skillId?: string }>
      attempt_id?: string
      user_message_id?: string
      user_invoked?: boolean
      user_invoked_skill_ids?: string[]
    }
    const ids = Array.isArray(body.skill_index) ? body.skill_index.map((row) => String(row.id || '')) : []
    const capabilityIds = Array.isArray(body.capabilities) ? body.capabilities.map((row) => String(row.id || '')) : []
    const skillContextIds = Array.isArray(body.skillContext) ? body.skillContext.map((row) => String(row.skillId || '')) : []
    expect(ids).toContain('deep-research')
    expect(skillContextIds).toContain('deep-research')
    expect(capabilityIds).toContain('builtin:search')
    expect(body.attempt_id).toBe('att-1')
    expect(body.user_message_id).toBe('msg-user-1')
    expect(body.user_invoked).toBe(true)
    expect(body.user_invoked_skill_ids).toEqual(['deep-research'])
    expect(mockSessionService.claimRuntimeAttemptLease).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'att-1',
      expectedStatuses: ['queued', 'running'],
    }))
    expect(mockSessionService.heartbeatRuntimeAttempt).toHaveBeenCalled()
  })

  it('sends runtime sub_agents for configured sub-agents in direct mode', async () => {
    mockAgentService.getAgent.mockImplementation(async (agentId: string) => {
      if (agentId === 'agent-system') {
        return {
          id: 'agent-system',
          name: '系统助手',
          systemPrompt: 'You are a helpful AI assistant.',
          config: { model: 'gpt-4o', temperature: 0.7, maxTokens: 4096 },
          skills: [],
          subAgents: ['sub-1'],
          isSystem: true,
        }
      }
      if (agentId === 'sub-1') {
        return {
          id: 'sub-1',
          name: 'Research SubAgent',
          description: 'Research helper',
          systemPrompt: 'Research deeply.',
          config: { model: 'gpt-4o-mini', temperature: 0.2, maxTokens: 2048 },
          skills: ['deep-research'],
          subAgents: [],
          isSystem: false,
        }
      }
      throw new Error(`unexpected agent: ${agentId}`)
    })

    const fetchMock = vi.fn(async (input: string) => {
      if (input.endsWith('/v1/skills')) {
        return new Response(JSON.stringify({ metadata: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (input.endsWith('/v1/tools/catalog')) {
        return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (input.includes('/api/v1/chat/sessions/')) {
        return new Response(
          JSON.stringify({ status: 'completed', final_response: 'ok', error: null, runtime_events: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      throw new Error(`unexpected fetch url: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { handleChat } = await import('../services/chat.service')
    await handleChat('user-1', 'sess-1', { message: 'delegate this task' }, createMockRes())

    const runtimeCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/v1/chat/sessions/'))
    const body = JSON.parse(String(runtimeCall?.[1]?.body || '{}')) as {
      sub_agents?: Array<{ id?: string; name?: string }>
      capabilities?: Array<{
        id?: string
        constraints?: { timeoutMs?: number }
        metadata?: { system_prompt?: string; model?: string; skills?: string[] }
      }>
    }
    expect(body.sub_agents?.map((item) => item.id)).toContain('sub-1')
    expect(body.capabilities?.map((item) => item.id)).toContain('agent:sub-1')
    const subAgentCapability = body.capabilities?.find((item) => item.id === 'agent:sub-1')
    expect(subAgentCapability?.constraints?.timeoutMs).toBe(120000)
    expect(subAgentCapability?.metadata?.system_prompt).toBe('Research deeply.')
    expect(subAgentCapability?.metadata?.model).toBe('gpt-4o')
    expect(subAgentCapability?.metadata?.skills).toEqual(['deep-research'])
  })

  it('injects chunk expansion block from prior session document context', async () => {
    mockSessionService.getSessionMessages.mockResolvedValue([
      {
        role: 'user',
        content: '先读文档',
        metadata: {
          document_context: {
            docs: [
              {
                docId: 'doc-001',
                version: 1,
                title: 'sample.txt',
                chunkCount: 1,
                summaryChars: 12,
                workspaceRootRelativePath: 'docs/doc-001/v1',
              },
            ],
          },
        },
      },
    ])

    const workspaceRoot = '/tmp/semibot-chat-expansion-home'
    process.env.SEMIBOT_HOME = workspaceRoot
    const fs = await import('fs-extra')
    await fs.ensureDir(`${workspaceRoot}/workspaces/sess-1/docs/doc-001/v1/chunks`)
    await fs.writeFile(
      `${workspaceRoot}/workspaces/sess-1/docs/doc-001/v1/chunks/c0001.txt`,
      '这是 chunk 原文。',
      'utf-8'
    )

    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/v1/skills')) {
        return new Response(JSON.stringify({ metadata: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
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
    await handleChat('user-1', 'sess-1', { message: '请展开 [chunk:c0001] 原文' }, createMockRes())

    const runtimeCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/v1/chat/sessions/'))
    expect(runtimeCall).toBeTruthy()
    const body = JSON.parse(String(runtimeCall?.[1]?.body || '{}')) as { message?: string }
    expect(String(body.message || '')).toContain('[DOCUMENT_CHUNK_EXPANSION_BEGIN]')
    expect(String(body.message || '')).toContain('chunk_id: c0001')
    expect(String(body.message || '')).toContain('这是 chunk 原文。')
  })

  it('does not treat awaiting_approval as runtime failure', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/v1/skills')) {
        return new Response(JSON.stringify({ metadata: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (input.includes('/api/v1/chat/sessions/')) {
        return new Response(
          JSON.stringify({
            status: 'awaiting_approval',
            final_response: '操作已提交审批，请确认。',
            error: null,
            revision: 7,
            pending_approval_ids: ['appr_123'],
            runtime_events: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      throw new Error(`unexpected fetch url: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { handleChat } = await import('../services/chat.service')
    await handleChat('user-1', 'sess-1', { message: '请执行高风险操作' }, createMockRes())

    expect(mockSessionService.addMessage).toHaveBeenCalledTimes(1)
    expect(mockRuntimeAttemptCommitService.commitAttemptState).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-1',
      status: 'awaiting_approval',
      revision: 7,
    }))
  })

  it('treats non-normalized awaiting_approval status as non-failure', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/v1/skills')) {
        return new Response(JSON.stringify({ metadata: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (input.includes('/api/v1/chat/sessions/')) {
        return new Response(
          JSON.stringify({
            status: ' Awaiting_Approval ',
            final_response: '等待审批中',
            error: null,
            revision: 8,
            pending_approval_ids: [],
            runtime_events: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      throw new Error(`unexpected fetch url: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { handleChat } = await import('../services/chat.service')
    await handleChat('user-1', 'sess-1', { message: '高风险操作' }, createMockRes())

    expect(mockSessionService.addMessage).toHaveBeenCalledTimes(1)
    expect(mockRuntimeAttemptCommitService.commitAttemptState).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-1',
      status: 'awaiting_approval',
      revision: 8,
    }))
  })

  it('does not persist failed runtime terminal text as assistant artifact', async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/v1/skills')) {
        return new Response(JSON.stringify({ metadata: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (input.includes('/api/v1/chat/sessions/')) {
        return new Response(
          JSON.stringify({
            status: 'failed',
            terminal_reason: 'graph_timeout',
            revision: 9,
            final_response: '',
            error: 'search quota exceeded',
            pending_approval_ids: [],
            runtime_events: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      throw new Error(`unexpected fetch url: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { handleChat } = await import('../services/chat.service')
    await handleChat('user-1', 'sess-1', { message: '搜索最新新闻' }, createMockRes())

    expect(mockSessionService.addMessage).toHaveBeenCalledTimes(1)
    expect(mockRuntimeAttemptCommitService.commitAttemptTerminal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-1',
      status: 'failed',
      terminalReason: 'graph_timeout',
      revision: 9,
    }))
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
      'data: {"event":"done","status":"completed","final_response":"研究完成","session_id":"sess-1","agent_id":"agent-system","revision":10}\n\n',
    ].join('')

    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
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
    await handleChat('user-1', 'sess-1', { message: '研究腾讯股票' }, mockRes)

    const writes = (mockRes.write as unknown as ReturnType<typeof vi.fn>).mock.calls.map((args) => String(args[0]))
    expect(writes.some((line) => line.includes('event: message'))).toBe(true)
    expect(writes.some((line) => line.includes('"type":"thinking"'))).toBe(true)
    expect(writes.some((line) => line.includes('"toolName":"planner_llm"'))).toBe(true)
    expect(writes.some((line) => line.includes('"toolName":"act_decision"'))).toBe(true)
    expect(writes.some((line) => line.includes('"type":"tool_call"'))).toBe(true)
    expect(writes.some((line) => line.includes('"type":"tool_result"'))).toBe(true)
    expect(writes.some((line) => line.includes('"content":"研究完成"'))).toBe(true)

    expect(mockSessionService.addMessage).toHaveBeenLastCalledWith('sess-1', expect.objectContaining({
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
    expect(mockRuntimeAttemptCommitService.commitAttemptTerminal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-1',
      status: 'completed',
      terminalReason: 'completed_normally',
      revision: 10,
      checkpointPayload: expect.objectContaining({
        execution_process: expect.objectContaining({
          version: 1,
          messages: expect.any(Array),
        }),
      }),
    }))
  })

  it('does not persist raw web_fetch json as final assistant content', async () => {
    const mockRes = createMockRes()
    mockSessionService.addMessage
      .mockResolvedValueOnce({ id: 'msg-user-1' })
      .mockResolvedValueOnce({ id: 'msg-assistant-1' })

    const rawPayload = JSON.stringify({
      url: 'https://example.com/ai',
      status_code: 200,
      content_type: 'text/html',
      title: '',
      text: 'raw fetched page body',
    })

    const sseFrames = [
      'data: {"event":"start","session_id":"sess-1","agent_id":"agent-system"}\n\n',
      'data: {"event":"thinking","data":{"content":"正在整理"}}\n\n',
      `data: {"event":"done","status":"completed","final_response":${JSON.stringify(rawPayload)},"session_id":"sess-1","agent_id":"agent-system","revision":11}\n\n`,
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
    await handleChat('user-1', 'sess-1', { message: '搜索最新的 AI 行业动态并总结' }, mockRes)

    expect(mockSessionService.addMessage).toHaveBeenLastCalledWith('sess-1', expect.objectContaining({
      role: 'assistant',
      content: '任务已执行完成。',
    }))
    expect(mockRuntimeAttemptCommitService.commitAttemptTerminal).toHaveBeenCalledWith(expect.objectContaining({
      checkpointPayload: expect.objectContaining({
        final_response: '',
      }),
    }))
  })

  it('does not persist concatenated raw web_fetch json blocks as final assistant content', async () => {
    const mockRes = createMockRes()
    mockSessionService.addMessage
      .mockResolvedValueOnce({ id: 'msg-user-1' })
      .mockResolvedValueOnce({ id: 'msg-assistant-1' })

    const firstPayload = JSON.stringify({
      url: 'https://example.com/ai-1',
      status_code: 200,
      content_type: 'text/html',
      title: '',
      text: 'first raw fetched page body',
    })
    const secondPayload = JSON.stringify({
      url: 'https://example.com/ai-2',
      status_code: 200,
      content_type: 'text/html',
      title: '',
      text: 'second raw fetched page body',
    })
    const rawPayload = `${firstPayload}\n\n${secondPayload}`

    const sseFrames = [
      'data: {"event":"start","session_id":"sess-1","agent_id":"agent-system"}\n\n',
      `data: {"event":"done","status":"completed","final_response":${JSON.stringify(rawPayload)},"session_id":"sess-1","agent_id":"agent-system","revision":12}\n\n`,
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
    await handleChat('user-1', 'sess-1', { message: '搜索最新的 AI 行业动态并总结' }, mockRes)

    expect(mockSessionService.addMessage).toHaveBeenLastCalledWith('sess-1', expect.objectContaining({
      role: 'assistant',
      content: '任务已执行完成。',
    }))
    expect(mockRuntimeAttemptCommitService.commitAttemptTerminal).toHaveBeenCalledWith(expect.objectContaining({
      checkpointPayload: expect.objectContaining({
        final_response: '',
      }),
    }))
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

    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
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
    await handleChat('user-1', 'sess-1', { message: '研究腾讯股票' }, mockRes)

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
    await handleChat('user-1', 'sess-1', { message: '打开新闻网站' }, mockRes)

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
    await handleChat('user-1', 'sess-1', { message: '打开新闻网站' }, mockRes)

    expect(mockSessionService.addMessage).toHaveBeenLastCalledWith(
      'sess-1',
      expect.objectContaining({
        role: 'assistant',
        content: expect.stringContaining('appr_pending_1'),
      })
    )
  })

  it('approving a pending approval resumes the same chat run via the approvals API path', async () => {
    const mockRes = createMockRes()
    mockSessionService.addMessage
      .mockResolvedValueOnce({ id: 'msg-user-1' })
      .mockResolvedValueOnce({ id: 'msg-assistant-pending' })
      .mockResolvedValueOnce({ id: 'msg-assistant-resumed' })

    const pendingFrames = [
      'data: {"event":"start","session_id":"sess-1","agent_id":"agent-system"}\n\n',
      'data: {"event":"tool.exec.pending_approval","approval_id":"appr_pending_1","data":{"tool_name":"web_fetch","approval_id":"appr_pending_1","status":"pending","message":"需要人工审批"}}\n\n',
      'data: {"event":"done","status":"completed","final_response":"操作需要人工审批后继续。","session_id":"sess-1","agent_id":"agent-system"}\n\n',
    ].join('')
    const resumedFrames = [
      'data: {"event":"start","session_id":"sess-1","agent_id":"agent-system"}\n\n',
      'data: {"event":"done","status":"completed","final_response":"审批后已继续执行。","session_id":"sess-1","agent_id":"agent-system"}\n\n',
    ].join('')

    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/v1/skills')) {
        return new Response(JSON.stringify({ metadata: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (input.endsWith('/v1/approvals/appr_pending_1/approve')) {
        const body = JSON.parse(String(init?.body || '{}')) as { resume?: boolean }
        expect(body.resume).toBe(false)
        return new Response(JSON.stringify({ approval_id: 'appr_pending_1', status: 'approved' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (input.includes('/api/v1/chat/sessions/')) {
        const callIndex = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/v1/chat/sessions/')).length
        const body = callIndex === 1 ? pendingFrames : resumedFrames
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      throw new Error(`unexpected fetch url: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { handleChat, resolveApprovalAndMaybeResume } = await import('../services/chat.service')
    await handleChat('user-1', 'sess-1', { message: '打开新闻网站' }, mockRes)

    const resolved = await resolveApprovalAndMaybeResume('appr_pending_1', 'approve')

    expect(resolved.resumed).toBe(true)
    expect(resolved.sessionId).toBe('sess-1')
    expect(mockSessionService.addMessage).toHaveBeenLastCalledWith(
      'sess-1',
      expect.objectContaining({
        role: 'assistant',
        content: '审批后已继续执行。',
      })
    )
  })
})
