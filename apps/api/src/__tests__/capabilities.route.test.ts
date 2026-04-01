import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function getRouteHandler(path: string, method: 'get' | 'post') {
  const { default: capabilitiesRouter } = await import('../routes/v1/capabilities')
  const layer = capabilitiesRouter.stack.find((item) => item.route?.path === path && item.route?.methods?.[method])
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

describe('capabilities route', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv, SEMIBOT_ENABLE_AUTH: 'false', RUNTIME_URL: 'http://runtime.test' }
    vi.restoreAllMocks()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('returns 200 when legacy capability install succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            resolution_mode: 'install',
            registry_name: 'foo/browser-helper@cli',
            install_result: { ok: true },
          },
        }),
      })
    )

    const response = await invokeRoute('/install', 'post', {
      body: {
        missingCapability: {
          intent: 'authenticated_browser_session',
          reason: 'Need a logged-in browser',
        },
      },
    })

    expect(response.statusCode).toBe(200)
    const payload = response.payload as {
      success: boolean
      data?: { resolution_mode?: string; registry_name?: string }
    }
    expect(payload.success).toBe(true)
    expect(payload.data?.resolution_mode).toBe('install')
    expect(payload.data?.registry_name).toBe('foo/browser-helper@cli')
  })

  it('falls back across runtime URLs for legacy install', async () => {
    process.env.RUNTIME_URL = 'http://runtime-a.test,http://runtime-b.test'
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('primary down'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            data: {
              resolution_mode: 'install',
              registry_name: 'foo/browser-helper@cli',
              install_result: { ok: true },
            },
          }),
        })
    )

    const response = await invokeRoute('/install', 'post', {
      body: {
        missingCapability: {
          intent: 'authenticated_browser_session',
          reason: 'Need a logged-in browser',
        },
      },
    })

    expect(response.statusCode).toBe(200)
    const payload = response.payload as {
      success: boolean
      data?: { resolution_mode?: string }
    }
    expect(payload.success).toBe(true)
    expect(payload.data?.resolution_mode).toBe('install')
  })

  it('proxies resolve-missing to runtime', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            install_request_id: 'cinst_123',
            resolution_mode: 'recommend',
            registry_name: 'foo/browser-helper@cli',
          },
        }),
      })
    )

    const response = await invokeRoute('/resolve-missing', 'post', {
      body: {
        missingCapability: {
          intent: 'authenticated_browser_session',
          reason: 'Need a logged-in browser',
        },
        taskId: 'task_1',
        sessionId: 'sess_1',
        taskText: 'find AI news',
        currentShortlistToolIds: ['builtin:file_io'],
      },
    })

    expect(response.statusCode).toBe(200)
    const payload = response.payload as {
      success: boolean
      data?: { install_request_id?: string; registry_name?: string }
    }
    expect(payload.success).toBe(true)
    expect(payload.data?.install_request_id).toBe('cinst_123')
    expect(payload.data?.registry_name).toBe('foo/browser-helper@cli')
  })

  it('proxies approve-install, install-status, install-history, and retry-task to runtime', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: { id: 'cinst_123', state: 'completed' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: { id: 'cinst_123', state: 'completed' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: { items: [{ id: 'cinst_123', state: 'completed' }] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: { id: 'cinst_123', state: 'completed', metadata: { retry_result: { status: 'success' } } },
        }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const approve = await invokeRoute('/approve-install', 'post', {
      body: { installRequestId: 'cinst_123', approved: true },
    })
    expect(approve.statusCode).toBe(200)
    expect(approve.payload as { success: boolean }).toMatchObject({ success: true })

    const statusRes = await invokeRoute('/install-status/:installRequestId', 'get', {
      params: { installRequestId: 'cinst_123' },
    })
    expect(statusRes.statusCode).toBe(200)
    expect(statusRes.payload as { success: boolean }).toMatchObject({ success: true })

    const historyRes = await invokeRoute('/install-history', 'get', {
      query: { sessionId: 'sess_1' },
    })
    expect(historyRes.statusCode).toBe(200)
    expect(historyRes.payload as { success: boolean }).toMatchObject({ success: true })

    const retry = await invokeRoute('/retry-task', 'post', {
      body: { installRequestId: 'cinst_123' },
    })
    expect(retry.statusCode).toBe(200)
    const retryPayload = retry.payload as {
      success: boolean
      data?: { metadata?: { retry_result?: { status?: string } } }
    }
    expect(retryPayload.success).toBe(true)
    expect(retryPayload.data?.metadata?.retry_result?.status).toBe('success')
  })

  it('maps structured install failures to HTTP errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({
          detail: {
            code: 'CAPABILITY_CANDIDATE_NOT_FOUND',
            message: 'no install candidate found for missing capability',
          },
        }),
      })
    )

    const response = await invokeRoute('/resolve-missing', 'post', {
      body: {
        missingCapability: {
          intent: 'authenticated_browser_session',
          reason: 'Need a logged-in browser',
        },
      },
    })

    expect(response.statusCode).toBe(404)
    const payload = response.payload as {
      success: boolean
      error?: { code?: string }
    }
    expect(payload.success).toBe(false)
    expect(payload.error?.code).toBe('CAPABILITY_CANDIDATE_NOT_FOUND')
  })
})
