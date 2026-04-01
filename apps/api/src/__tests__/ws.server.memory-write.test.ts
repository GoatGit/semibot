import { beforeEach, describe, expect, it, vi } from 'vitest'

const memoryService = vi.hoisted(() => ({
  createMemory: vi.fn(),
}))

vi.mock('../services/memory.service', () => memoryService)

import { WSServer } from '../ws/ws-server'

describe('ws-server memory_write fire_and_forget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    memoryService.createMemory.mockResolvedValue(undefined)
  })

  it('normalizes long_term to semantic and keeps runtime session metadata when target session is invalid', async () => {
    const server = Object.create(WSServer.prototype) as any
    server.generateOpenAIEmbedding = vi.fn().mockResolvedValue(null)

    await server.handleFireAndForget(
      { userId: 'user-1' },
      {
        type: 'fire_and_forget',
        session_id: '__memory__',
        method: 'memory_write',
        params: {
          agent_id: 'agent-1',
          target_session_id: 'not-a-uuid',
          content: 'remember this',
          memory_type: 'long_term',
          importance: 0.8,
          metadata: { source: 'execution_plane' },
        },
      }
    )

    expect(memoryService.createMemory).toHaveBeenCalledWith({
      agentId: 'agent-1',
      sessionId: undefined,
      userId: 'user-1',
      content: 'remember this',
      embedding: undefined,
      memoryType: 'semantic',
      importance: 0.8,
      metadata: { source: 'execution_plane', runtime_session_id: '__memory__' },
    })
  })

  it('uses explicit target session id and falls back unknown memory_type to episodic', async () => {
    const server = Object.create(WSServer.prototype) as any
    server.generateOpenAIEmbedding = vi.fn().mockResolvedValue([0.1, 0.2])

    await server.handleFireAndForget(
      { userId: 'user-1' },
      {
        type: 'fire_and_forget',
        session_id: '__memory__',
        method: 'memory_write',
        params: {
          agent_id: 'agent-1',
          target_session_id: '2e256a78-74f5-4df4-ae1c-1a2f1fb4c123',
          content: 'remember this too',
          memory_type: 'invalid_type',
        },
      }
    )

    expect(memoryService.createMemory).toHaveBeenCalledWith({
      agentId: 'agent-1',
      sessionId: '2e256a78-74f5-4df4-ae1c-1a2f1fb4c123',
      userId: 'user-1',
      content: 'remember this too',
      embedding: [0.1, 0.2],
      memoryType: 'episodic',
      importance: 0.5,
      metadata: {},
    })
  })
})
