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
  const realFetch = globalThis.fetch.bind(globalThis)

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

  it('aggregates runtime middleware events for runtime monitor', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: string | URL) => {
        const url = String(input)
        if (url.includes('/v1/events')) {
          return {
            ok: true,
            json: async () => ({
              items: [
                {
                  id: 'evt_heartbeat',
                  event_type: 'act.heartbeat',
                  source: 'runtime',
                  payload: { session_id: 'sess_1' },
                  created_at: '2026-03-26T00:00:00Z',
                },
                {
                  id: 'evt_failure',
                  event_type: 'runtime.failure',
                  source: 'runtime',
                  payload: { retryable: true, family: 'tool', message: 'tool timeout', session_id: 'sess_1' },
                  created_at: '2026-03-26T00:00:01Z',
                },
                {
                  id: 'evt_signal',
                  event_type: 'runtime.signal',
                  source: 'runtime',
                  payload: { reason: 'repeated_tool_loop', kind: 'warn', session_id: 'sess_1' },
                  created_at: '2026-03-26T00:00:02Z',
                },
                {
                  id: 'evt_usage',
                  event_type: 'llm.usage',
                  source: 'runtime',
                  payload: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, session_id: 'sess_1' },
                  created_at: '2026-03-26T00:00:03Z',
                },
                {
                  id: 'evt_route',
                  event_type: 'route.mode_selected',
                  source: 'runtime',
                  payload: { mode: 'direct_reasoning', reason: 'single-turn synthesis', session_id: 'sess_1' },
                  created_at: '2026-03-26T00:00:04Z',
                },
                {
                  id: 'evt_dr',
                  event_type: 'dr.completed',
                  source: 'runtime',
                  payload: { status: 'completed', session_id: 'sess_1' },
                  created_at: '2026-03-26T00:00:05Z',
                },
                {
                  id: 'evt_dr_upgrade',
                  event_type: 'observe_dr.upgrade_to_plan_act',
                  source: 'runtime',
                  payload: { reason: 'needs workflow', session_id: 'sess_1' },
                  created_at: '2026-03-26T00:00:06Z',
                },
              ],
            }),
          }
        }
        if (url.includes('/v1/stats/token-usage')) {
          return {
            ok: true,
            json: async () => ({
              totals: {
                call_count: 7,
                prompt_tokens: 700,
                completion_tokens: 140,
                total_tokens: 840,
              },
            }),
          }
        }
        throw new Error(`unexpected url: ${url}`)
      })
    )

    const server = await startTestServer()
    try {
      const response = await realFetch(`${server.baseUrl}/monitor?limit=50`)
      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        success: boolean
        data?: {
          available?: boolean
          summary?: {
            signalCount?: number
            failureCount?: number
            heartbeatCount?: number
            usageCallCount?: number
            routeDecisionCount?: number
            drRunCount?: number
            drUpgradeCount?: number
            loopAlertCount?: number
            retryableFailureCount?: number
            activeSessionCount?: number
          }
          timeline?: Array<{ id: string }>
          staleSessions?: Array<unknown>
        }
      }
      expect(payload.success).toBe(true)
      expect(payload.data?.available).toBe(true)
      expect(payload.data?.summary).toMatchObject({
        signalCount: 1,
        failureCount: 1,
        heartbeatCount: 1,
        usageCallCount: 7,
        routeDecisionCount: 1,
        drRunCount: 1,
        drUpgradeCount: 1,
        loopAlertCount: 1,
        retryableFailureCount: 1,
        activeSessionCount: 1,
      })
      expect(payload.data?.timeline?.map((item) => item.id)).toEqual([
        'evt_dr_upgrade',
        'evt_dr',
        'evt_route',
        'evt_usage',
        'evt_signal',
        'evt_failure',
        'evt_heartbeat',
      ])
      expect(payload.data?.staleSessions).toHaveLength(1)
      expect(payload.data?.staleSessions?.[0]).toMatchObject({
        sessionId: 'sess_1',
        lastHeartbeatAt: '2026-03-26T00:00:00Z',
      })
      expect(
        typeof (payload.data?.staleSessions?.[0] as { ageSeconds?: unknown } | undefined)?.ageSeconds
      ).toBe('number')
    } finally {
      await server.close()
    }
  })
})
