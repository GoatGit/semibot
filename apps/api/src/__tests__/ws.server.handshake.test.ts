import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WSServer } from '../ws/ws-server'

type Handler = (...args: unknown[]) => void

class FakeWS {
  sent: string[] = []
  closed: Array<{ code?: number; reason?: string }> = []
  onceHandlers = new Map<string, Handler>()
  onHandlers = new Map<string, Handler[]>()

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason })
  }

  once(event: string, handler: Handler): void {
    this.onceHandlers.set(event, handler)
  }

  on(event: string, handler: Handler): void {
    const arr = this.onHandlers.get(event) ?? []
    arr.push(handler)
    this.onHandlers.set(event, arr)
  }

  async emitOnce(event: string, ...args: unknown[]): Promise<void> {
    const h = this.onceHandlers.get(event)
    if (h) await h(...args)
  }
}

describe('ws-server handshake', () => {
  const originalOpenAI = process.env.OPENAI_API_KEY
  const originalAnthropic = process.env.ANTHROPIC_API_KEY
  const originalGoogle = process.env.GOOGLE_AI_API_KEY
  const originalCustom = process.env.CUSTOM_LLM_API_KEY
  const originalOpenAIBase = process.env.OPENAI_API_BASE_URL
  const originalCustomBase = process.env.CUSTOM_LLM_API_BASE_URL
  const originalDefaultModel = process.env.DEFAULT_LLM_MODEL
  const originalFallbackModel = process.env.FALLBACK_LLM_MODEL
  const originalNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.NODE_ENV = 'test'
    process.env.OPENAI_API_KEY = 'sk-openai-test'
    process.env.ANTHROPIC_API_KEY = 'sk-anthropic-test'
    process.env.GOOGLE_AI_API_KEY = 'sk-google-test'
    process.env.CUSTOM_LLM_API_KEY = 'sk-custom-test'
    process.env.OPENAI_API_BASE_URL = 'https://api.openai.com/v1'
    process.env.CUSTOM_LLM_API_BASE_URL = 'https://custom.example.com/v1'
    process.env.DEFAULT_LLM_MODEL = 'gpt-4o'
    process.env.FALLBACK_LLM_MODEL = 'gpt-4.1-mini'
  })

  afterEach(() => {
    if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalOpenAI

    if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = originalAnthropic

    if (originalGoogle === undefined) delete process.env.GOOGLE_AI_API_KEY
    else process.env.GOOGLE_AI_API_KEY = originalGoogle

    if (originalCustom === undefined) delete process.env.CUSTOM_LLM_API_KEY
    else process.env.CUSTOM_LLM_API_KEY = originalCustom

    if (originalOpenAIBase === undefined) delete process.env.OPENAI_API_BASE_URL
    else process.env.OPENAI_API_BASE_URL = originalOpenAIBase

    if (originalCustomBase === undefined) delete process.env.CUSTOM_LLM_API_BASE_URL
    else process.env.CUSTOM_LLM_API_BASE_URL = originalCustomBase

    if (originalDefaultModel === undefined) delete process.env.DEFAULT_LLM_MODEL
    else process.env.DEFAULT_LLM_MODEL = originalDefaultModel

    if (originalFallbackModel === undefined) delete process.env.FALLBACK_LLM_MODEL
    else process.env.FALLBACK_LLM_MODEL = originalFallbackModel

    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
  })

  it('sends init with api_keys after auth', async () => {
    const server = Object.create(WSServer.prototype) as any
    server.connections = new Map()
    server.validateAuth = vi.fn().mockResolvedValue({ userId: 'user-1', orgId: 'org-1', token: 'jwt-token' })

    const ws = new FakeWS()

    server.handleConnection(ws as any, '/ws/vm?user_id=user-1')
    await ws.emitOnce('message', JSON.stringify({ type: 'auth', token: 'jwt-token' }))

    expect(ws.sent.length).toBe(1)
    const init = JSON.parse(ws.sent[0])
    expect(init.type).toBe('init')
    expect(init.data).toMatchObject({
      user_id: 'user-1',
      org_id: 'org-1',
    })
    expect(init.data.api_keys.openai.alg).toBe('aes-256-gcm')
    expect(typeof init.data.api_keys.openai.iv).toBe('string')
    expect(typeof init.data.api_keys.openai.tag).toBe('string')
    expect(typeof init.data.api_keys.openai.ciphertext).toBe('string')
    expect(init.data.api_keys.openai.ciphertext).not.toContain('sk-openai-test')
    expect(init.data.api_keys.anthropic.alg).toBe('aes-256-gcm')
    expect(init.data.api_keys.google.alg).toBe('aes-256-gcm')
    expect(init.data.api_keys.custom.alg).toBe('aes-256-gcm')
    expect(init.data.llm_config).toMatchObject({
      default_model: 'gpt-4o',
      fallback_model: 'gpt-4.1-mini',
      providers: {
        openai: { base_url: 'https://api.openai.com/v1' },
        custom: { base_url: 'https://custom.example.com/v1' },
      },
    })
  })

  it('rejects connection when user_id is missing', () => {
    const server = Object.create(WSServer.prototype) as any
    const ws = new FakeWS()

    server.handleConnection(ws as any, '/ws/vm')

    expect(ws.closed).toEqual([{ code: 4001, reason: 'user_id is required' }])
    expect(ws.sent).toEqual([])
  })
})
