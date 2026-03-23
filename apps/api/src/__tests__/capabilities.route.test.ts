import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function startTestServer(): Promise<{
  baseUrl: string
  close: () => Promise<void>
}> {
  const { default: capabilitiesRouter } = await import('../routes/v1/capabilities')
  const app = express()
  app.use(express.json())
  app.use(capabilitiesRouter)
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

describe('capabilities route', () => {
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

    const server = await startTestServer()
    try {
      const response = await realFetch(`${server.baseUrl}/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          missingCapability: {
            intent: 'authenticated_browser_session',
            reason: 'Need a logged-in browser',
          },
        }),
      })

      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        success: boolean
        data?: { resolution_mode?: string; registry_name?: string }
      }
      expect(payload.success).toBe(true)
      expect(payload.data?.resolution_mode).toBe('install')
      expect(payload.data?.registry_name).toBe('foo/browser-helper@cli')
    } finally {
      await server.close()
    }
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

    const server = await startTestServer()
    try {
      const response = await realFetch(`${server.baseUrl}/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          missingCapability: {
            intent: 'authenticated_browser_session',
            reason: 'Need a logged-in browser',
          },
        }),
      })

      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        success: boolean
        data?: { resolution_mode?: string }
      }
      expect(payload.success).toBe(true)
      expect(payload.data?.resolution_mode).toBe('install')
    } finally {
      await server.close()
    }
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

    const server = await startTestServer()
    try {
      const response = await realFetch(`${server.baseUrl}/resolve-missing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          missingCapability: {
            intent: 'authenticated_browser_session',
            reason: 'Need a logged-in browser',
          },
          taskId: 'task_1',
          sessionId: 'sess_1',
          taskText: 'find AI news',
          currentShortlistToolIds: ['builtin:file_io'],
        }),
      })

      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        success: boolean
        data?: { install_request_id?: string; registry_name?: string }
      }
      expect(payload.success).toBe(true)
      expect(payload.data?.install_request_id).toBe('cinst_123')
      expect(payload.data?.registry_name).toBe('foo/browser-helper@cli')
    } finally {
      await server.close()
    }
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

    const server = await startTestServer()
    try {
      const approve = await realFetch(`${server.baseUrl}/approve-install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installRequestId: 'cinst_123', approved: true }),
      })
      expect(approve.status).toBe(200)
      expect((await approve.json()) as { success: boolean }).toMatchObject({ success: true })

      const statusRes = await realFetch(`${server.baseUrl}/install-status/cinst_123`)
      expect(statusRes.status).toBe(200)
      expect((await statusRes.json()) as { success: boolean }).toMatchObject({ success: true })

      const historyRes = await realFetch(`${server.baseUrl}/install-history?sessionId=sess_1`)
      expect(historyRes.status).toBe(200)
      expect((await historyRes.json()) as { success: boolean }).toMatchObject({ success: true })

      const retry = await realFetch(`${server.baseUrl}/retry-task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installRequestId: 'cinst_123' }),
      })
      expect(retry.status).toBe(200)
      const retryPayload = (await retry.json()) as {
        success: boolean
        data?: { metadata?: { retry_result?: { status?: string } } }
      }
      expect(retryPayload.success).toBe(true)
      expect(retryPayload.data?.metadata?.retry_result?.status).toBe('success')
    } finally {
      await server.close()
    }
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

    const server = await startTestServer()
    try {
      const response = await realFetch(`${server.baseUrl}/resolve-missing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          missingCapability: {
            intent: 'authenticated_browser_session',
            reason: 'Need a logged-in browser',
          },
        }),
      })

      expect(response.status).toBe(404)
      const payload = (await response.json()) as {
        success: boolean
        error?: { code?: string }
      }
      expect(payload.success).toBe(false)
      expect(payload.error?.code).toBe('CAPABILITY_CANDIDATE_NOT_FOUND')
    } finally {
      await server.close()
    }
  })
})
