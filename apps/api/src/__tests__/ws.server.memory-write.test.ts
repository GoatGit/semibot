import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSql } = vi.hoisted(() => {
  const fn = vi.fn()
  ;(fn as any).json = (value: unknown) => value
  return { mockSql: fn }
})

vi.mock('../lib/db', () => ({
  sql: mockSql,
}))

import { WSServer } from '../ws/ws-server'

describe('ws-server memory_write fire_and_forget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('normalizes long_term to semantic and keeps __memory__ in metadata', async () => {
    mockSql.mockResolvedValueOnce([])

    const server = Object.create(WSServer.prototype) as any
    server.generateOpenAIEmbedding = vi.fn().mockResolvedValue(null)

    await server.handleFireAndForget(
      { orgId: 'org-1', userId: 'user-1' },
      {
        type: 'fire_and_forget',
        session_id: '__memory__',
        method: 'memory_write',
        params: {
          agent_id: 'agent-1',
          target_session_id: '2e256a78-74f5-4df4-ae1c-1a2f1fb4c123',
          content: 'remember this',
          memory_type: 'long_term',
          importance: 0.8,
          metadata: { source: 'execution_plane' },
        },
      }
    )

    expect(mockSql).toHaveBeenCalledTimes(1)
    const values = mockSql.mock.calls[0].slice(1)
    expect(values).toContain('2e256a78-74f5-4df4-ae1c-1a2f1fb4c123') // session_id normalized from explicit param
    expect(values).toContain('semantic') // memory_type normalized
    expect(values.some((v) => typeof v === 'object' && v !== null)).toBe(true)
  })

  it('falls back unknown memory_type to episodic', async () => {
    mockSql.mockResolvedValueOnce([])

    const server = Object.create(WSServer.prototype) as any
    server.generateOpenAIEmbedding = vi.fn().mockResolvedValue(null)

    await server.handleFireAndForget(
      { orgId: 'org-1', userId: 'user-1' },
      {
        type: 'fire_and_forget',
        session_id: '__memory__',
        method: 'memory_write',
        params: {
          agent_id: 'agent-1',
          content: 'remember this too',
          memory_type: 'invalid_type',
        },
      }
    )

    const values = mockSql.mock.calls[0].slice(1)
    expect(values).toContain('episodic')
  })
})
