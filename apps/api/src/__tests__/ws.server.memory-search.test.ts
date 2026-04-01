import { beforeEach, describe, expect, it, vi } from 'vitest'

const memoryService = vi.hoisted(() => ({
  searchSimilarMemories: vi.fn(),
  listMemories: vi.fn(),
}))

vi.mock('../services/memory.service', () => memoryService)

import { WSServer } from '../ws/ws-server'

describe('ws-server memory_search request', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses vector search when embedding is available', async () => {
    memoryService.searchSimilarMemories.mockResolvedValueOnce([
      {
        content: 'memory via vector',
        similarity: 0.92,
        metadata: { source: 'vector' },
        createdAt: '2026-01-01T00:00:00.000Z',
        memoryType: 'semantic',
      },
    ])

    const sent: Array<Record<string, unknown>> = []
    const server = Object.create(WSServer.prototype) as any
    server.generateOpenAIEmbedding = vi.fn().mockResolvedValue([0.01, 0.02, 0.03])
    server.cacheRequestResult = vi.fn()

    const conn = {
      ws: { send: (raw: string) => sent.push(JSON.parse(raw)) },
      requestResults: new Map(),
    }

    await server.handleRequest(conn, {
      type: 'request',
      id: 'req-1',
      session_id: 'sess-1',
      method: 'memory_search',
      params: { query: 'what is this', top_k: 3, agent_id: 'agent-1', memory_type: 'semantic' },
    })

    expect(server.generateOpenAIEmbedding).toHaveBeenCalledWith('what is this')
    expect(memoryService.searchSimilarMemories).toHaveBeenCalledWith({
      agentId: 'agent-1',
      embedding: [0.01, 0.02, 0.03],
      limit: 3,
      minSimilarity: 0.5,
    })
    expect(sent[0]).toMatchObject({
      type: 'response',
      id: 'req-1',
      error: null,
      result: {
        results: [
          {
            content: 'memory via vector',
            score: 0.92,
            metadata: { source: 'vector', created_at: '2026-01-01T00:00:00.000Z' },
          },
        ],
      },
    })
  })

  it('falls back to list filtering when embedding is unavailable', async () => {
    memoryService.listMemories.mockResolvedValueOnce({
      data: [
        {
          content: 'memory via ilike',
          metadata: {},
          createdAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    })

    const sent: Array<Record<string, unknown>> = []
    const server = Object.create(WSServer.prototype) as any
    server.generateOpenAIEmbedding = vi.fn().mockResolvedValue(null)
    server.cacheRequestResult = vi.fn()

    const conn = {
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

    expect(memoryService.listMemories).toHaveBeenCalledWith({
      agentId: undefined,
      memoryType: undefined,
      limit: 5,
    })
    expect(sent[0]).toMatchObject({
      type: 'response',
      id: 'req-2',
      error: null,
      result: { results: [] },
    })
  })

  it('ignores unsupported memory_type filters', async () => {
    memoryService.listMemories.mockResolvedValueOnce({
      data: [
        {
          content: 'what is this exactly',
          metadata: {},
          createdAt: '2026-01-03T00:00:00.000Z',
        },
      ],
    })

    const sent: Array<Record<string, unknown>> = []
    const server = Object.create(WSServer.prototype) as any
    server.generateOpenAIEmbedding = vi.fn().mockResolvedValue(null)
    server.cacheRequestResult = vi.fn()

    const conn = {
      ws: { send: (raw: string) => sent.push(JSON.parse(raw)) },
      requestResults: new Map(),
    }

    await server.handleRequest(conn, {
      type: 'request',
      id: 'req-4',
      session_id: 'sess-1',
      method: 'memory_search',
      params: { query: 'what is this', top_k: 3, memory_type: 'invalid_type' },
    })

    expect(memoryService.listMemories).toHaveBeenCalledWith({
      agentId: undefined,
      memoryType: undefined,
      limit: 3,
    })
    expect(sent[0]).toMatchObject({ type: 'response', id: 'req-4', error: null })
  })

  it('returns empty results for blank query without service access', async () => {
    const sent: Array<Record<string, unknown>> = []
    const server = Object.create(WSServer.prototype) as any
    server.generateOpenAIEmbedding = vi.fn()
    server.cacheRequestResult = vi.fn()

    const conn = {
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
    expect(memoryService.searchSimilarMemories).not.toHaveBeenCalled()
    expect(memoryService.listMemories).not.toHaveBeenCalled()
    expect(sent[0]).toMatchObject({
      type: 'response',
      id: 'req-3',
      error: null,
      result: { results: [] },
    })
  })
})
