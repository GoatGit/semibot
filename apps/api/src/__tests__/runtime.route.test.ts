import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function getRouteHandler(path: string, method: 'get' | 'post') {
  const { default: runtimeRouter } = await import('../routes/v1/runtime')
  const layer = runtimeRouter.stack.find((item) => item.route?.path === path && item.route?.methods?.[method])
  if (!layer?.route?.stack?.length) {
    throw new Error(`route handler not found for ${method.toUpperCase()} ${path}`)
  }
  return layer.route.stack[layer.route.stack.length - 1]?.handle
}

async function invokeRoute(
  path: string,
  method: 'get' | 'post',
  req: Record<string, unknown> = {}
): Promise<{ statusCode: number; payload: unknown }> {
  const handler = await getRouteHandler(path, method)
  const responseState: { statusCode: number; payload: unknown } = {
    statusCode: 200,
    payload: undefined,
  }
  let settle: (() => void) | null = null
  const completed = new Promise<void>((resolve) => {
    settle = resolve
  })
  const res = {
    status(code: number) {
      responseState.statusCode = code
      return this
    },
    json(payload: unknown) {
      responseState.payload = payload
      settle?.()
      return this
    },
  } as never

  handler(req as never, res, (error?: unknown) => {
    if (error) throw error
  })
  await completed
  return responseState
}

describe('runtime route', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv, SEMIBOT_ENABLE_AUTH: 'false', RUNTIME_URL: 'http://runtime.test' }
    vi.restoreAllMocks()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
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

    const response = await invokeRoute('/channels/conversations', 'get', {
      query: { limit: '10' },
    })
    expect(response.statusCode).toBe(200)
    const payload = response.payload as {
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

    const response = await invokeRoute('/channels/conversations/:conversationId/runs', 'get', {
      params: { conversationId: 'conv_1' },
      query: { limit: '10' },
    })
    expect(response.statusCode).toBe(200)
    const payload = response.payload as {
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
  })

  it('maps gateway context version from runtime payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          conversation_id: 'conv_1',
          messages: [
            {
              id: 'msg_1',
              version: 42,
              role: 'user',
              content: 'hello',
              metadata: {},
              created_at: '2026-03-23T00:00:01Z',
            },
          ],
        }),
      })
    )

    const response = await invokeRoute('/channels/conversations/:conversationId/context', 'get', {
      params: { conversationId: 'conv_1' },
      query: { limit: '10' },
    })
    expect(response.statusCode).toBe(200)
    const payload = response.payload as {
      success: boolean
      data?: {
        messages?: Array<{ contextVersion?: number }>
      }
    }
    expect(payload.success).toBe(true)
    expect(payload.data?.messages?.[0]?.contextVersion).toBe(42)
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

    const response = await invokeRoute('/monitor', 'get', {
      query: { limit: '50' },
    })
    expect(response.statusCode).toBe(200)
    const payload = response.payload as {
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
    expect(typeof (payload.data?.staleSessions?.[0] as { ageSeconds?: unknown } | undefined)?.ageSeconds).toBe(
      'number'
    )
  })

  it('filters runtime monitor events by capability', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: string | URL) => {
        const url = String(input)
        if (url.includes('/v1/events')) {
          expect(url).toContain('capability_id=browser')
          return {
            ok: true,
            json: async () => ({
              items: [
                {
                  id: 'evt_browser',
                  event_type: 'runtime.signal',
                  source: 'runtime',
                  payload: { capability_id: 'mcp:browser.open_url', session_id: 'sess_browser' },
                  created_at: '2026-03-26T00:00:02Z',
                },
                {
                  id: 'evt_bash',
                  event_type: 'runtime.signal',
                  source: 'runtime',
                  payload: { capability_id: 'tool:bash.exec', session_id: 'sess_bash' },
                  created_at: '2026-03-26T00:00:01Z',
                },
              ],
            }),
          }
        }
        throw new Error(`unexpected url: ${url}`)
      })
    )

    const response = await invokeRoute('/monitor', 'get', {
      query: { limit: '50', capability: 'browser' },
    })
    expect(response.statusCode).toBe(200)
    const payload = response.payload as {
      success: boolean
      data?: {
        timeline?: Array<{ id: string; payload?: { capability_id?: string } }>
        summary?: { signalCount?: number }
      }
    }
    expect(payload.success).toBe(true)
    expect(payload.data?.summary?.signalCount).toBe(1)
    expect(payload.data?.timeline?.map((item) => item.id)).toEqual(['evt_browser'])
    expect(payload.data?.timeline?.[0]?.payload?.capability_id).toBe('mcp:browser.open_url')
  })

  it('filters runtime monitor events by capability id', async () => {
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
                  id: 'evt_browser',
                  event_type: 'runtime.failure',
                  source: 'runtime',
                  payload: { capability_id: 'mcp:browser.open_url', session_id: 'sess_browser' },
                  created_at: '2026-03-26T00:00:01Z',
                },
                {
                  id: 'evt_bash',
                  event_type: 'runtime.failure',
                  source: 'runtime',
                  payload: { capability_id: 'tool:bash.exec', session_id: 'sess_bash' },
                  created_at: '2026-03-26T00:00:02Z',
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
                call_count: 0,
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
              },
            }),
          }
        }
        throw new Error(`unexpected url: ${url}`)
      })
    )

    const response = await invokeRoute('/monitor', 'get', {
      query: { limit: '50', capability: 'browser' },
    })
    expect(response.statusCode).toBe(200)
    const payload = response.payload as {
      success: boolean
      data?: {
        summary?: {
          failureCount?: number
          activeSessionCount?: number
        }
        timeline?: Array<{ id: string; payload?: { capability_id?: string } }>
        failures?: Array<{ id: string }>
      }
    }
    expect(payload.success).toBe(true)
    expect(payload.data?.summary).toMatchObject({
      failureCount: 1,
      activeSessionCount: 1,
    })
    expect(payload.data?.timeline?.map((item) => item.id)).toEqual(['evt_browser'])
    expect(payload.data?.failures?.map((item) => item.id)).toEqual(['evt_browser'])
  })
})
