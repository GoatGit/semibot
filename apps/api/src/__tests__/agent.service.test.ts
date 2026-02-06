/**
 * Agent Service 测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock 数据库
vi.mock('../lib/db', () => ({
  sql: vi.fn(),
}))

import { sql } from '../lib/db'

const mockSql = sql as unknown as ReturnType<typeof vi.fn>

describe('Agent Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createAgent', () => {
    it('should create an agent with valid input', async () => {
      const mockAgent = {
        id: 'agent-123',
        org_id: 'org-123',
        name: 'Test Agent',
        description: 'A test agent',
        system_prompt: 'You are a helpful assistant',
        config: {},
        skills: [],
        sub_agents: [],
        is_active: true,
        is_public: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      mockSql.mockResolvedValueOnce([mockAgent])

      const { createAgent } = await import('../services/agent.service')

      const result = await createAgent('org-123', {
        name: 'Test Agent',
        description: 'A test agent',
        systemPrompt: 'You are a helpful assistant',
      })

      expect(result).toBeDefined()
      expect(result.name).toBe('Test Agent')
    })
  })

  describe('getAgent', () => {
    it('should return agent when found', async () => {
      const mockAgent = {
        id: 'agent-123',
        org_id: 'org-123',
        name: 'Test Agent',
        description: 'A test agent',
        system_prompt: 'You are a helpful assistant',
        config: {},
        skills: [],
        sub_agents: [],
        is_active: true,
        is_public: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      mockSql.mockResolvedValueOnce([mockAgent])

      const { getAgent } = await import('../services/agent.service')

      const result = await getAgent('org-123', 'agent-123')

      expect(result).toBeDefined()
      expect(result.id).toBe('agent-123')
    })

    it('should throw error when agent not found', async () => {
      mockSql.mockResolvedValueOnce([])

      const { getAgent } = await import('../services/agent.service')

      await expect(getAgent('org-123', 'nonexistent')).rejects.toEqual({
        code: 'AGENT_NOT_FOUND',
      })
    })
  })

  describe('listAgents', () => {
    it('should return paginated list of agents', async () => {
      const mockAgents = [
        {
          id: 'agent-1',
          org_id: 'org-123',
          name: 'Agent 1',
          description: 'First agent',
          system_prompt: 'Prompt 1',
          config: {},
          skills: [],
          sub_agents: [],
          is_active: true,
          is_public: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          id: 'agent-2',
          org_id: 'org-123',
          name: 'Agent 2',
          description: 'Second agent',
          system_prompt: 'Prompt 2',
          config: {},
          skills: [],
          sub_agents: [],
          is_active: true,
          is_public: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]

      // Mock count query
      mockSql.mockResolvedValueOnce([{ count: '2' }])
      // Mock list query
      mockSql.mockResolvedValueOnce(mockAgents)

      const { listAgents } = await import('../services/agent.service')

      const result = await listAgents('org-123', { page: 1, limit: 10 })

      expect(result.data).toHaveLength(2)
      expect(result.meta.total).toBe(2)
    })
  })

  describe('updateAgent', () => {
    it('should update agent with valid input', async () => {
      const existingAgent = {
        id: 'agent-123',
        org_id: 'org-123',
        name: 'Original Name',
        description: 'Original description',
        system_prompt: 'Original prompt',
        config: {},
        skills: [],
        sub_agents: [],
        is_active: true,
        is_public: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      const updatedAgent = {
        ...existingAgent,
        name: 'Updated Name',
        updated_at: new Date().toISOString(),
      }

      // Mock get agent
      mockSql.mockResolvedValueOnce([existingAgent])
      // Mock update
      mockSql.mockResolvedValueOnce([updatedAgent])

      const { updateAgent } = await import('../services/agent.service')

      const result = await updateAgent('org-123', 'agent-123', {
        name: 'Updated Name',
      })

      expect(result.name).toBe('Updated Name')
    })
  })

  describe('deleteAgent', () => {
    it('should delete agent when found', async () => {
      const mockAgent = {
        id: 'agent-123',
        org_id: 'org-123',
        name: 'Test Agent',
        is_active: true,
      }

      // Mock get agent
      mockSql.mockResolvedValueOnce([mockAgent])
      // Mock delete
      mockSql.mockResolvedValueOnce([])

      const { deleteAgent } = await import('../services/agent.service')

      await expect(deleteAgent('org-123', 'agent-123')).resolves.not.toThrow()
    })
  })

  describe('validateAgentForSession', () => {
    it('should pass validation for active agent', async () => {
      const mockAgent = {
        id: 'agent-123',
        org_id: 'org-123',
        name: 'Test Agent',
        is_active: true,
      }

      mockSql.mockResolvedValueOnce([mockAgent])

      const { validateAgentForSession } = await import('../services/agent.service')

      await expect(
        validateAgentForSession('org-123', 'agent-123')
      ).resolves.not.toThrow()
    })

    it('should throw error for inactive agent', async () => {
      const mockAgent = {
        id: 'agent-123',
        org_id: 'org-123',
        name: 'Test Agent',
        is_active: false,
      }

      mockSql.mockResolvedValueOnce([mockAgent])

      const { validateAgentForSession } = await import('../services/agent.service')

      await expect(
        validateAgentForSession('org-123', 'agent-123')
      ).rejects.toEqual({ code: 'AGENT_INACTIVE' })
    })
  })
})
