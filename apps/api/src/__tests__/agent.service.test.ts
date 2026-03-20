/**
 * Agent Service 测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock 数据库
vi.mock('../lib/db', () => ({
  sql: vi.fn(),
}))

// Mock LLM 服务
vi.mock('../services/llm.service', () => ({
  getAvailableModels: vi.fn().mockResolvedValue(['gpt-4o', 'gpt-4o-mini']),
}))

// Mock repository
vi.mock('../repositories/agent.repository', () => ({
  countByOrg: vi.fn(),
  create: vi.fn(),
  findByIdAndOrg: vi.fn(),
  findById: vi.fn(),
  findByOrg: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
}))

import * as agentRepository from '../repositories/agent.repository'

const mockAgentRepo = agentRepository as {
  countByOrg: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  findByIdAndOrg: ReturnType<typeof vi.fn>
  findById: ReturnType<typeof vi.fn>
  findByOrg: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  softDelete: ReturnType<typeof vi.fn>
}

describe('Agent Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  describe('createAgent', () => {
    it('should create an agent with valid input', async () => {
      const mockAgentRow = {
        id: 'agent-123',
        org_id: 'org-123',
        name: 'Test Agent',
        description: 'A test agent',
        system_prompt: 'You are a helpful assistant',
        config: { model: 'gpt-4o', temperature: 0.7, maxTokens: 4096, timeoutSeconds: 120 },
        skills: [],
        sub_agents: [],
        version: 1,
        is_active: true,
        is_public: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      mockAgentRepo.countByOrg.mockResolvedValue(0)
      mockAgentRepo.create.mockResolvedValue(mockAgentRow)

      const { createAgent } = await import('../services/agent.service')

      const result = await createAgent('org-123', {
        name: 'Test Agent',
        description: 'A test agent',
        systemPrompt: 'You are a helpful assistant',
      })

      expect(result).toBeDefined()
      expect(result.name).toBe('Test Agent')
      expect(mockAgentRepo.create).toHaveBeenCalled()
    })
  })

  describe('getAgent', () => {
    it('should return agent when found', async () => {
      const mockAgentRow = {
        id: 'agent-123',
        org_id: 'org-123',
        name: 'Test Agent',
        description: 'A test agent',
        system_prompt: 'You are a helpful assistant',
        config: { model: 'gpt-4o', temperature: 0.7, maxTokens: 4096, timeoutSeconds: 120 },
        skills: [],
        sub_agents: [],
        version: 1,
        is_active: true,
        is_public: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      mockAgentRepo.findByIdAndOrg.mockResolvedValue(mockAgentRow)

      const { getAgent } = await import('../services/agent.service')

      const result = await getAgent('org-123', 'agent-123')

      expect(result).toBeDefined()
      expect(result.id).toBe('agent-123')
    })

    it('should throw error when agent not found', async () => {
      mockAgentRepo.findByIdAndOrg.mockResolvedValue(null)

      const { getAgent } = await import('../services/agent.service')

      await expect(getAgent('org-123', 'nonexistent')).rejects.toMatchObject({
        code: 'AGENT_NOT_FOUND',
      })
    })
  })

  describe('listAgents', () => {
    it('should return paginated list of agents', async () => {
      const mockAgentRows = [
        {
          id: 'agent-1',
          org_id: 'org-123',
          name: 'Agent 1',
          description: 'First agent',
          system_prompt: 'Prompt 1',
          config: { model: 'gpt-4o', temperature: 0.7, maxTokens: 4096, timeoutSeconds: 120 },
          skills: [],
          sub_agents: [],
          version: 1,
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
          config: { model: 'gpt-4o', temperature: 0.7, maxTokens: 4096, timeoutSeconds: 120 },
          skills: [],
          sub_agents: [],
          version: 1,
          is_active: true,
          is_public: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]

      mockAgentRepo.findByOrg.mockResolvedValue({
        data: mockAgentRows,
        meta: { total: 2, page: 1, limit: 10, totalPages: 1 },
      })

      const { listAgents } = await import('../services/agent.service')

      const result = await listAgents('org-123', { page: 1, limit: 10 })

      expect(result.data).toHaveLength(2)
      expect(result.meta.total).toBe(2)
    })
  })

  describe('updateAgent', () => {
    it('should update agent with valid input', async () => {
      const existingAgentRow = {
        id: 'agent-123',
        org_id: 'org-123',
        name: 'Original Name',
        description: 'Original description',
        system_prompt: 'Original prompt',
        config: { model: 'gpt-4o', temperature: 0.7, maxTokens: 4096, timeoutSeconds: 120 },
        skills: [],
        sub_agents: [],
        version: 1,
        is_active: true,
        is_public: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      const updatedAgentRow = {
        ...existingAgentRow,
        name: 'Updated Name',
        version: 2,
        updated_at: new Date().toISOString(),
      }

      mockAgentRepo.findByIdAndOrg.mockResolvedValue(existingAgentRow)
      mockAgentRepo.update.mockResolvedValue(updatedAgentRow)

      const { updateAgent } = await import('../services/agent.service')

      const result = await updateAgent('org-123', 'agent-123', {
        name: 'Updated Name',
      })

      expect(result.name).toBe('Updated Name')
    })
  })

  describe('deleteAgent', () => {
    it('should delete agent when found', async () => {
      mockAgentRepo.softDelete.mockResolvedValue(true)

      const { deleteAgent } = await import('../services/agent.service')

      await expect(deleteAgent('org-123', 'agent-123')).resolves.not.toThrow()
    })
  })

  describe('validateAgentForSession', () => {
    it('should pass validation for active agent', async () => {
      const mockAgentRow = {
        id: 'agent-123',
        org_id: 'org-123',
        name: 'Test Agent',
        description: null,
        system_prompt: 'You are helpful',
        config: { model: 'gpt-4o', temperature: 0.7, maxTokens: 4096, timeoutSeconds: 120 },
        skills: [],
        sub_agents: [],
        version: 1,
        is_active: true,
        is_public: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      mockAgentRepo.findByIdAndOrg.mockResolvedValue(mockAgentRow)

      const { validateAgentForSession } = await import('../services/agent.service')

      await expect(
        validateAgentForSession('org-123', 'agent-123')
      ).resolves.not.toThrow()
    })

    it('should throw error for inactive agent', async () => {
      const mockAgentRow = {
        id: 'agent-123',
        org_id: 'org-123',
        name: 'Test Agent',
        description: null,
        system_prompt: 'You are helpful',
        config: { model: 'gpt-4o', temperature: 0.7, maxTokens: 4096, timeoutSeconds: 120 },
        skills: [],
        sub_agents: [],
        version: 1,
        is_active: false,
        is_public: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      mockAgentRepo.findByIdAndOrg.mockResolvedValue(mockAgentRow)

      const { validateAgentForSession } = await import('../services/agent.service')

      await expect(
        validateAgentForSession('org-123', 'agent-123')
      ).rejects.toMatchObject({ code: 'AGENT_INACTIVE' })
    })
  })
})
