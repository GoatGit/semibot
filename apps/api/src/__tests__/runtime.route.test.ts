import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function startTestServer(): Promise<{
  baseUrl: string
  close: () => Promise<void>
}> {
  const { default: runtimeRouter } = await import('../routes/v1/runtime')
  const app = express()
  app.use(express.json())
  app.use(runtimeRouter)
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind test server')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}

describe('runtime route', () => {
  const realFetch = globalThis.fetch

  beforeEach(() => {
    process.env.SEMIBOT_ENABLE_AUTH = 'false'
    process.env.RUNTIME_URL = 'http://runtime.test'
    vi.restoreAllMocks()
  })

  afterEach(() => {
    delete process.env.SEMIBOT_ENABLE_AUTH
    delete process.env.RUNTIME_URL
  })

  it('surfaces latestRun missing capability in conversations payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              conversation_id: 'conv_1',
              provider: 'channel',
              gateway_key: 'gateway',
              status: 'active',
              updated_at: '2026-03-23T00:00:00Z',
              latest_run: {
                run_id: 'run_1',
                runtime_session_id: 'session_1',
                snapshot_version: 3,
                status: 'done',
                result_summary: 'Need a logged-in browser',
                result_metadata: {
                  missing_capability: {
                    type: 'missing_capability',
                    version: '1',
                    intent: 'authenticated_browser_session',
                  },
                },
                missing_capability: {
                  type: 'missing_capability',
                  version: '1',
                  intent: 'authenticated_browser_session',
                },
                updated_at: '2026-03-23T00:00:01Z',
              },
            },
          ],
        }),
      })
    )

    const server = await startTestServer()
    try {
      const response = await realFetch(`${server.baseUrl}/channels/conversations?limit=10`)
      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        success: boolean
        data?: {
          conversations?: Array<{
            latestRun?: {
              missingCapability?: { intent?: string } | null
              resultMetadata?: Record<string, unknown>
            } | null
          }>
        }
      }
      expect(payload.success).toBe(true)
      expect(payload.data?.conversations?.[0]?.latestRun?.missingCapability?.intent).toBe(
        'authenticated_browser_session'
      )
      expect(payload.data?.conversations?.[0]?.latestRun?.resultMetadata).toMatchObject({
        missing_capability: { version: '1' },
      })
    } finally {
      await server.close()
    }
  })

  it('surfaces missing capability in runs payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              run_id: 'run_1',
              runtime_session_id: 'session_1',
              snapshot_version: 3,
              status: 'done',
              result_summary: 'Need a logged-in browser',
              result_metadata: {
                missing_capability: {
                  type: 'missing_capability',
                  version: '1',
                  intent: 'authenticated_browser_session',
                },
              },
              missing_capability: {
                type: 'missing_capability',
                version: '1',
                intent: 'authenticated_browser_session',
              },
              updated_at: '2026-03-23T00:00:01Z',
            },
          ],
        }),
      })
    )

    const server = await startTestServer()
    try {
      const response = await realFetch(`${server.baseUrl}/channels/conversations/conv_1/runs?limit=10`)
      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        success: boolean
        data?: {
          runs?: Array<{
            missingCapability?: { intent?: string } | null
            resultMetadata?: Record<string, unknown>
          }>
        }
      }
      expect(payload.success).toBe(true)
      expect(payload.data?.runs?.[0]?.missingCapability?.intent).toBe('authenticated_browser_session')
      expect(payload.data?.runs?.[0]?.resultMetadata).toMatchObject({
        missing_capability: { version: '1' },
      })
    } finally {
      await server.close()
    }
  })
})
