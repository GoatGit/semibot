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

describe('ws-server memory_search request', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses vector search when embedding is available', async () => {
    mockSql.mockResolvedValueOnce([
      {
        content: 'memory via vector',
        score: 0.92,
        metadata: { source: 'vector' },
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ])

    const sent: Array<Record<string, unknown>> = []
    const server = Object.create(WSServer.prototype) as any
    server.generateOpenAIEmbedding = vi.fn().mockResolvedValue([0.01, 0.02, 0.03])
    server.cacheRequestResult = vi.fn()

    const conn = {
      orgId: 'org-1',
      ws: { send: (raw: string) => sent.push(JSON.parse(raw)) },
      requestResults: new Map(),
    }

    await server.handleRequest(conn, {
      type: 'request',
      id: 'req-1',
      session_id: 'sess-1',
      method: 'memory_search',
      params: { query: 'what is this', top_k: 3 },
    })

    expect(server.generateOpenAIEmbedding).toHaveBeenCalledWith('what is this')
    expect(mockSql).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'response',
      id: 'req-1',
      error: null,
      result: {
        results: [
          {
            content: 'memory via vector',
            score: 0.92,
            metadata: { source: 'vector' },
          },
        ],
      },
    })
  })

  it('falls back to ilike search when embedding is unavailable', async () => {
    mockSql.mockResolvedValueOnce([
      {
        content: 'memory via ilike',
        score: 0.31,
        metadata: null,
        created_at: '2026-01-02T00:00:00.000Z',
      },
    ])

    const sent: Array<Record<string, unknown>> = []
    const server = Object.create(WSServer.prototype) as any
    server.generateOpenAIEmbedding = vi.fn().mockResolvedValue(null)
    server.cacheRequestResult = vi.fn()

    const conn = {
      orgId: 'org-1',
      ws: { send: (raw: string) => sent.push(JSON.parse(raw)) },
      requestResults: new Map(),
    }

    await server.handleRequest(conn, {
      type: 'request',
      id: 'req-2',
      session_id: 'sess-1',
      method: 'memory_search',
      params: { query: 'fallback-query', top_k: 5 },
    })

    expect(server.generateOpenAIEmbedding).toHaveBeenCalledWith('fallback-query')
    expect(mockSql).toHaveBeenCalledTimes(1)
    expect(sent[0]).toMatchObject({
      type: 'response',
      id: 'req-2',
      error: null,
      result: {
        results: [
          {
            content: 'memory via ilike',
            score: 0.31,
            metadata: { created_at: '2026-01-02T00:00:00.000Z' },
          },
        ],
      },
    })
  })

  it('returns empty results for blank query without database access', async () => {
    const sent: Array<Record<string, unknown>> = []
    const server = Object.create(WSServer.prototype) as any
    server.generateOpenAIEmbedding = vi.fn()
    server.cacheRequestResult = vi.fn()

    const conn = {
      orgId: 'org-1',
      ws: { send: (raw: string) => sent.push(JSON.parse(raw)) },
      requestResults: new Map(),
    }

    await server.handleRequest(conn, {
      type: 'request',
      id: 'req-3',
      session_id: 'sess-1',
      method: 'memory_search',
      params: { query: '   ', top_k: 5 },
    })

    expect(server.generateOpenAIEmbedding).not.toHaveBeenCalled()
    expect(mockSql).not.toHaveBeenCalled()
    expect(sent[0]).toMatchObject({
      type: 'response',
      id: 'req-3',
      error: null,
      result: { results: [] },
    })
  })
})
