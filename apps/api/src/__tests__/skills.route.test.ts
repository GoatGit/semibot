import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function startTestServer(): Promise<{
  baseUrl: string
  close: () => Promise<void>
}> {
  const { default: skillsRouter } = await import('../routes/v1/skills')
  const app = express()
  app.use(express.json())
  app.use(skillsRouter)
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

describe('skills route', () => {
  const originalEnv = { ...process.env }
  const realFetch = globalThis.fetch

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

    const server = await startTestServer()
    try {
      const response = await realFetch(`${server.baseUrl}/`)
      expect(response.status).toBe(200)
      const payload = (await response.json()) as {
        success: boolean
        data?: { skills?: string[]; metadata?: Array<{ skill_id?: string }> }
      }
      expect(payload.success).toBe(true)
      expect(payload.data?.skills).toEqual(['browser-helper'])
      expect(payload.data?.metadata?.[0]?.skill_id).toBe('browser-helper')
    } finally {
      await server.close()
    }
  })
})
