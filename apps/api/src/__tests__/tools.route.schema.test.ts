import { describe, expect, it } from 'vitest'

import { updateToolSchema } from '../routes/v1/tools'

describe('tools route update schema', () => {
  it('accepts http auth fields and sql connections', () => {
    const parsed = updateToolSchema.parse({
      config: {
        authType: 'api_key',
        authHeader: 'X-API-Key',
        connections: {
          main: 'postgresql://user:pass@localhost:5432/db',
          analytics: 'sqlite:///tmp/analytics.db',
        },
      },
      isActive: true,
    })

    expect(parsed.config?.authType).toBe('api_key')
    expect(parsed.config?.authHeader).toBe('X-API-Key')
    expect(parsed.config?.connections).toMatchObject({
      main: 'postgresql://user:pass@localhost:5432/db',
      analytics: 'sqlite:///tmp/analytics.db',
    })
  })

  it('rejects unsupported authType', () => {
    const result = updateToolSchema.safeParse({
      config: {
        authType: 'token',
      },
    })

    expect(result.success).toBe(false)
  })

  it('rejects overly long authHeader', () => {
    const result = updateToolSchema.safeParse({
      config: {
        authType: 'api_key',
        authHeader: 'X'.repeat(101),
      },
    })

    expect(result.success).toBe(false)
  })
})
