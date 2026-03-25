import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function startTestServer(): Promise<{
  baseUrl: string
  close: () => Promise<void>
}> {
  const { default: toolsRouter } = await import('../routes/v1/tools')
  const app = express()
  app.use(express.json())
  app.use(toolsRouter)
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('failed to bind test server')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}

describe('tools catalog route', () => {
  const originalEnv = { ...process.env }
  const realFetch = globalThis.fetch

  beforeEach(() => {
    process.env = { ...originalEnv, SEMIBOT_ENABLE_AUTH: 'false', RUNTIME_URL: 'http://runtime.test' }
    vi.restoreAllMocks()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('proxies runtime tool catalog', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          items: [
            {
              toolId: 'builtin:search',
              toolName: 'search',
              displayName: 'search',
              sourceType: 'builtin',
            },
          ],
          generated_at: '2026-03-23T00:00:00.000Z',
        }),
      })
    )

    const server = await startTestServer()
    try {
      const response = await realFetch(`${server.baseUrl}/catalog`)
      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        success: boolean
        data?: { items?: Array<{ toolId?: string }>; generatedAt?: string }
      }
      expect(payload.success).toBe(true)
      expect(payload.data?.items?.[0]?.toolId).toBe('builtin:search')
      expect(payload.data?.generatedAt).toBe('2026-03-23T00:00:00.000Z')
    } finally {
      await server.close()
    }
  })

  it('proxies cli import creation and decision routes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            id: 'cimp_1',
            status: 'awaiting_approval',
            tool_name: 'opencli_xhs',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            id: 'cimp_1',
            status: 'registered',
            tool_name: 'opencli_xhs',
          },
        }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const server = await startTestServer()
    try {
      const createResp = await realFetch(`${server.baseUrl}/import-cli`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: ['opencli', 'xiaohongshu'],
          shape: 'group',
          source: 'web',
        }),
      })
      expect(createResp.status).toBe(200)
      const createPayload = (await createResp.json()) as { success: boolean; data?: { status?: string } }
      expect(createPayload.success).toBe(true)
      expect(createPayload.data?.status).toBe('awaiting_approval')

      const decisionResp = await realFetch(`${server.baseUrl}/import-cli/cimp_1/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      })
      expect(decisionResp.status).toBe(200)
      const decisionPayload = (await decisionResp.json()) as { success: boolean; data?: { status?: string } }
      expect(decisionPayload.success).toBe(true)
      expect(decisionPayload.data?.status).toBe('registered')
    } finally {
      await server.close()
    }
  })
})
