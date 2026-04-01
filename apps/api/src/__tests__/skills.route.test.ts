import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function getSkillsRouteHandler() {
  const { default: skillsRouter } = await import('../routes/v1/skills')
  const layer = skillsRouter.stack.find((item) => item.route?.path === '/' && item.route?.methods?.get)
  if (!layer?.route?.stack?.length) throw new Error('skills route handler not found')
  return layer.route.stack[layer.route.stack.length - 1]?.handle
}

describe('skills route', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv, SEMIBOT_ENABLE_AUTH: 'false', RUNTIME_URL: 'http://runtime.test' }
    vi.restoreAllMocks()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('proxies runtime skills inventory', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          skills: ['browser-helper'],
          metadata: [{ skill_id: 'browser-helper' }],
        }),
      })
    )

    const handler = await getSkillsRouteHandler()
    const req = {} as never
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

    handler(req, res, (error?: unknown) => {
      if (error) throw error
    })
    await completed

    expect(responseState.statusCode).toBe(200)
    const payload = responseState.payload as {
      success: boolean
      data?: { skills?: string[]; metadata?: Array<{ skill_id?: string }> }
    }
    expect(payload.success).toBe(true)
    expect(payload.data?.skills).toEqual(['browser-helper'])
    expect(payload.data?.metadata?.[0]?.skill_id).toBe('browser-helper')
  })
})
