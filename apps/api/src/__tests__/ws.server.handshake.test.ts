import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/runtime-config-client', () => ({
  getRuntimeLlmConfig: vi.fn().mockResolvedValue({
    default_model: 'gpt-4o',
    default_provider_key: 'openai',
    fallback_model: 'gpt-4.1-mini',
    fallback_provider_key: 'openai',
    providers: {
      openai: { api_key: 'sk-openai-test', base_url: 'https://api.openai.com/v1' },
      anthropic: { api_key: 'sk-anthropic-test', base_url: 'https://api.anthropic.com/v1' },
      google: { api_key: 'sk-google-test', base_url: '' },
      custom: { api_key: 'sk-custom-test', base_url: 'https://custom.example.com/v1' },
    },
  }),
}))

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
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NODE_ENV = 'test'
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
