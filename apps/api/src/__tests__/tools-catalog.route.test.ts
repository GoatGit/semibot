import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function getRouteHandler(path: string, method: 'get' | 'post') {
  const { default: toolsRouter } = await import('../routes/v1/tools')
  const layer = toolsRouter.stack.find((item) => item.route?.path === path && item.route?.methods?.[method])
  if (!layer?.route?.stack?.length) throw new Error(`route handler not found for ${method.toUpperCase()} ${path}`)
  return layer.route.stack[layer.route.stack.length - 1]?.handle
}

describe('tools catalog route', () => {
  const originalEnv = { ...process.env }

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

    const handler = await getRouteHandler('/catalog', 'get')
    const responseState: { statusCode: number; payload: unknown } = { statusCode: 200, payload: undefined }
    let settle: (() => void) | null = null
    const completed = new Promise<void>((resolve) => {
      settle = resolve
    })
    const req = {} as never
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

    handler(req, res, (error?: unknown) => {
      if (error) throw error
    })
    await completed

    expect(responseState.statusCode).toBe(200)
    const payload = responseState.payload as {
      success: boolean
      data?: { items?: Array<{ toolId?: string }>; generatedAt?: string }
    }
    expect(payload.success).toBe(true)
    expect(payload.data?.items?.[0]?.toolId).toBe('builtin:search')
    expect(payload.data?.generatedAt).toBe('2026-03-23T00:00:00.000Z')
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

    const createHandler = await getRouteHandler('/import-cli', 'post')
    const createState: { statusCode: number; payload: unknown } = { statusCode: 200, payload: undefined }
    let createDone: (() => void) | null = null
    const createCompleted = new Promise<void>((resolve) => {
      createDone = resolve
    })
    createHandler(
      {
        body: {
          command: ['opencli', 'xiaohongshu'],
          shape: 'group',
          source: 'web',
        },
      } as never,
      {
        status(code: number) {
          createState.statusCode = code
          return this
        },
        json(payload: unknown) {
          createState.payload = payload
          createDone?.()
          return this
        },
      } as never,
      (error?: unknown) => {
        if (error) throw error
      }
    )
    await createCompleted

    expect(createState.statusCode).toBe(200)
    const createPayload = createState.payload as { success: boolean; data?: { status?: string } }
    expect(createPayload.success).toBe(true)
    expect(createPayload.data?.status).toBe('awaiting_approval')

    const decisionHandler = await getRouteHandler('/import-cli/:id/decision', 'post')
    const decisionState: { statusCode: number; payload: unknown } = { statusCode: 200, payload: undefined }
    let decisionDone: (() => void) | null = null
    const decisionCompleted = new Promise<void>((resolve) => {
      decisionDone = resolve
    })
    decisionHandler(
      {
        params: { id: 'cimp_1' },
        body: { approved: true },
      } as never,
      {
        status(code: number) {
          decisionState.statusCode = code
          return this
        },
        json(payload: unknown) {
          decisionState.payload = payload
          decisionDone?.()
          return this
        },
      } as never,
      (error?: unknown) => {
        if (error) throw error
      }
    )
    await decisionCompleted

    expect(decisionState.statusCode).toBe(200)
    const decisionPayload = decisionState.payload as { success: boolean; data?: { status?: string } }
    expect(decisionPayload.success).toBe(true)
    expect(decisionPayload.data?.status).toBe('registered')
  })
})
