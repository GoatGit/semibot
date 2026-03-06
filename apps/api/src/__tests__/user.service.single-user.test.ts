import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/db', () => ({
  sql: vi.fn(),
}))

import { sql } from '../lib/db'

const mockSql = sql as unknown as ReturnType<typeof vi.fn>

describe('User Service single-user fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.SEMIBOT_ENABLE_AUTH
    delete process.env.SEMIBOT_DISABLE_AUTH
    delete process.env.SEMIBOT_SINGLE_ORG_ID
  })

  it('returns organization preferences when single-user mode has no user row', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ settings: { theme: 'light', language: 'en-US' } }])

    const { getUserPreferences } = await import('../services/user.service')
    const result = await getUserPreferences('22222222-2222-2222-2222-222222222222')

    expect(result).toEqual({
      theme: 'light',
      language: 'en-US',
    })
  })

  it('updates organization preferences when single-user mode has no user row', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ settings: { theme: 'system', language: 'zh-CN' } }])

    const { updateUserPreferences } = await import('../services/user.service')
    const result = await updateUserPreferences('22222222-2222-2222-2222-222222222222', {
      theme: 'system',
    })

    expect(result).toEqual({
      theme: 'system',
      language: 'zh-CN',
    })
  })
})
