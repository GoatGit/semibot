/**
 * Memory Service 单元测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as memoryService from '../services/memory.service'
import * as memoryRepository from '../repositories/memory.repository'

// Mock repository
vi.mock('../repositories/memory.repository')

const mockMemoryRepository = memoryRepository as typeof memoryRepository & {
  create: ReturnType<typeof vi.fn>
  findById: ReturnType<typeof vi.fn>
  findAll: ReturnType<typeof vi.fn>
  searchSimilar: ReturnType<typeof vi.fn>
  updateAccessStats: ReturnType<typeof vi.fn>
  deleteById: ReturnType<typeof vi.fn>
  deleteExpired: ReturnType<typeof vi.fn>
}

describe('Memory Service', () => {
  const mockOrgId = 'org-123'
  const mockAgentId = 'agent-123'
  const mockMemoryId = 'memory-123'

  const mockMemoryRow: memoryRepository.MemoryRow = {
    id: mockMemoryId,
    org_id: mockOrgId,
    agent_id: mockAgentId,
    session_id: null,
    user_id: null,
    content: 'Test memory content',
    embedding: null,
    memory_type: 'episodic',
    importance: 0.7,
    access_count: 0,
    last_accessed_at: null,
    metadata: {},
    expires_at: null,
    created_at: '2026-01-01T00:00:00Z',
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createMemory', () => {
    it('should create a new memory successfully', async () => {
      mockMemoryRepository.create.mockResolvedValue(mockMemoryRow)

      const input = {
        agentId: mockAgentId,
        content: 'Test memory content',
        memoryType: 'episodic' as const,
        importance: 0.7,
      }

      const result = await memoryService.createMemory(mockOrgId, input)

      expect(result).toBeDefined()
      expect(result.content).toBe('Test memory content')
      expect(result.orgId).toBe(mockOrgId)
      expect(result.agentId).toBe(mockAgentId)
      expect(mockMemoryRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: mockOrgId,
          agentId: mockAgentId,
          content: 'Test memory content',
        })
      )
    })

    it('should support optional embedding', async () => {
      const embedding = Array(1536).fill(0.1)
      mockMemoryRepository.create.mockResolvedValue({
        ...mockMemoryRow,
        embedding,
      })

      const result = await memoryService.createMemory(mockOrgId, {
        agentId: mockAgentId,
        content: 'Test content',
        embedding,
      })

      expect(result.embedding).toEqual(embedding)
    })
  })

  describe('getMemory', () => {
    it('should return memory when found', async () => {
      mockMemoryRepository.findById.mockResolvedValue(mockMemoryRow)
      mockMemoryRepository.updateAccessStats.mockResolvedValue()

      const result = await memoryService.getMemory(mockOrgId, mockMemoryId)

      expect(result).toBeDefined()
      expect(result.id).toBe(mockMemoryId)
      expect(mockMemoryRepository.updateAccessStats).toHaveBeenCalledWith(mockMemoryId)
    })

    it('should throw error when memory not found', async () => {
      mockMemoryRepository.findById.mockResolvedValue(null)

      await expect(memoryService.getMemory(mockOrgId, 'non-existent')).rejects.toThrow()
    })

    it('should throw error when memory belongs to different org', async () => {
      mockMemoryRepository.findById.mockResolvedValue({
        ...mockMemoryRow,
        org_id: 'different-org',
      })

      await expect(memoryService.getMemory(mockOrgId, mockMemoryId)).rejects.toThrow()
    })
  })

  describe('listMemories', () => {
    it('should return paginated memories list', async () => {
      mockMemoryRepository.findAll.mockResolvedValue({
        data: [mockMemoryRow],
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
      })

      const result = await memoryService.listMemories(mockOrgId, { page: 1, limit: 20 })

      expect(result.data).toHaveLength(1)
      expect(result.meta.total).toBe(1)
    })

    it('should support agent filter', async () => {
      mockMemoryRepository.findAll.mockResolvedValue({
        data: [],
        meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
      })

      await memoryService.listMemories(mockOrgId, { agentId: mockAgentId })

      expect(mockMemoryRepository.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: mockAgentId,
        })
      )
    })

    it('should support memory type filter', async () => {
      mockMemoryRepository.findAll.mockResolvedValue({
        data: [],
        meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
      })

      await memoryService.listMemories(mockOrgId, { memoryType: 'semantic' })

      expect(mockMemoryRepository.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          memoryType: 'semantic',
        })
      )
    })
  })

  describe('searchSimilarMemories', () => {
    it('should search similar memories using embedding', async () => {
      const embedding = Array(1536).fill(0.1)
      mockMemoryRepository.searchSimilar.mockResolvedValue([
        { ...mockMemoryRow, similarity: 0.95 },
      ])
      mockMemoryRepository.updateAccessStats.mockResolvedValue()

      const result = await memoryService.searchSimilarMemories(mockOrgId, {
        agentId: mockAgentId,
        embedding,
        limit: 10,
        minSimilarity: 0.7,
      })

      expect(result).toHaveLength(1)
      expect(result[0].similarity).toBe(0.95)
      expect(mockMemoryRepository.searchSimilar).toHaveBeenCalledWith(
        mockAgentId,
        embedding,
        10,
        0.7
      )
    })

    it('should update access stats for found memories', async () => {
      const embedding = Array(1536).fill(0.1)
      mockMemoryRepository.searchSimilar.mockResolvedValue([
        { ...mockMemoryRow, similarity: 0.95 },
      ])
      mockMemoryRepository.updateAccessStats.mockResolvedValue()

      await memoryService.searchSimilarMemories(mockOrgId, {
        agentId: mockAgentId,
        embedding,
      })

      expect(mockMemoryRepository.updateAccessStats).toHaveBeenCalledWith(mockMemoryId)
    })
  })

  describe('deleteMemory', () => {
    it('should delete memory successfully', async () => {
      mockMemoryRepository.findById.mockResolvedValue(mockMemoryRow)
      mockMemoryRepository.deleteById.mockResolvedValue(true)

      await expect(memoryService.deleteMemory(mockOrgId, mockMemoryId)).resolves.not.toThrow()

      expect(mockMemoryRepository.deleteById).toHaveBeenCalledWith(mockMemoryId)
    })

    it('should throw error when memory not found', async () => {
      mockMemoryRepository.findById.mockResolvedValue(null)

      await expect(memoryService.deleteMemory(mockOrgId, 'non-existent')).rejects.toThrow()
    })
  })

  describe('cleanupExpiredMemories', () => {
    it('should cleanup expired memories and return count', async () => {
      mockMemoryRepository.deleteExpired.mockResolvedValue(5)

      const result = await memoryService.cleanupExpiredMemories(mockOrgId)

      expect(result).toBe(5)
      expect(mockMemoryRepository.deleteExpired).toHaveBeenCalledWith(mockOrgId)
    })
  })
})
