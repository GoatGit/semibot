/**
 * Agent Service 测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as agentService from '../../services/agent.service'
import * as agentRepository from '../../repositories/agent.repository'

// Mock dependencies
vi.mock('../../repositories/agent.repository')
vi.mock('../../services/llm.service', () => ({
  getAvailableModels: vi.fn().mockResolvedValue(['gpt-4o', 'gpt-4o-mini']),
}))
vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

const mockAgentRepository = vi.mocked(agentRepository)

describe('Agent Service', () => {
  const orgId = 'org-123'
  const userId = 'user-123'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createAgent', () => {
    it('应该成功创建 Agent', async () => {
      const input = {
        name: 'Test Agent',
        description: 'A test agent',
        systemPrompt: 'You are a helpful assistant',
      }

      const mockRow = {
        id: 'agent-123',
        org_id: orgId,
        name: 'Test Agent',
        description: 'A test agent',
        system_prompt: 'You are a helpful assistant',
        config: { model: 'gpt-4o' },
        skills: [],
        sub_agents: [],
        is_active: true,
        is_public: false,
        created_by: userId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        version: 1,
      }

      mockAgentRepository.countByOrg.mockResolvedValue(0)
      mockAgentRepository.create.mockResolvedValue(mockRow as any)

      const result = await agentService.createAgent(orgId, input as any)

      expect(result.id).toBe('agent-123')
      expect(result.name).toBe('Test Agent')
    })
  })

  describe('getAgent', () => {
    it('应该返回组织的 Agent', async () => {
      const mockRow = {
        id: 'agent-123',
        org_id: orgId,
        name: 'Test Agent',
        description: null,
        system_prompt: 'System prompt',
        config: { model: 'gpt-4o' },
        skills: [],
        sub_agents: [],
        is_active: true,
        is_public: false,
        created_by: userId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        version: 1,
      }

      mockAgentRepository.findByIdAndOrg.mockResolvedValue(mockRow as any)

      const result = await agentService.getAgent(orgId, 'agent-123')

      expect(result.id).toBe('agent-123')
      expect(result.name).toBe('Test Agent')
    })

    it('不存在时应该抛出 AGENT_NOT_FOUND', async () => {
      mockAgentRepository.findByIdAndOrg.mockResolvedValue(null)

      await expect(agentService.getAgent(orgId, 'nonexistent')).rejects.toThrow()
    })
  })

  describe('listAgents', () => {
    it('应该返回分页的 Agents 列表', async () => {
      const mockRows = [
        {
          id: 'agent-1',
          org_id: orgId,
          name: 'Agent 1',
          description: null,
          system_prompt: 'Prompt 1',
          config: { model: 'gpt-4o' },
          skills: [],
          sub_agents: [],
          is_active: true,
          is_public: false,
          created_by: userId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          version: 1,
        },
        {
          id: 'agent-2',
          org_id: orgId,
          name: 'Agent 2',
          description: null,
          system_prompt: 'Prompt 2',
          config: { model: 'gpt-4o' },
          skills: [],
          sub_agents: [],
          is_active: true,
          is_public: false,
          created_by: userId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          version: 1,
        },
      ]

      mockAgentRepository.findByOrg.mockResolvedValue({
        data: mockRows as any,
        meta: { total: 2, page: 1, limit: 20, totalPages: 1 },
      })

      const result = await agentService.listAgents(orgId)

      expect(result.data).toHaveLength(2)
      expect(result.meta.total).toBe(2)
    })
  })

  describe('updateAgent', () => {
    it('应该成功更新 Agent', async () => {
      const existingRow = {
        id: 'agent-123',
        org_id: orgId,
        name: 'Old Name',
        description: null,
        system_prompt: 'Old prompt',
        config: { model: 'gpt-4o' },
        skills: [],
        sub_agents: [],
        is_active: true,
        is_public: false,
        created_by: userId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        version: 1,
      }

      const updatedRow = {
        ...existingRow,
        name: 'New Name',
        version: 2,
      }

      mockAgentRepository.findByIdAndOrg.mockResolvedValue(existingRow as any)
      mockAgentRepository.update.mockResolvedValue(updatedRow as any)

      const result = await agentService.updateAgent(orgId, 'agent-123', {
        name: 'New Name',
      })

      expect(result.name).toBe('New Name')
    })

    it('不存在时应该抛出错误', async () => {
      mockAgentRepository.findByIdAndOrg.mockResolvedValue(null)

      await expect(
        agentService.updateAgent(orgId, 'nonexistent', { name: 'New Name' })
      ).rejects.toThrow()
    })
  })

  describe('deleteAgent', () => {
    it('应该成功软删除 Agent', async () => {
      const existingRow = {
        id: 'agent-123',
        org_id: orgId,
        name: 'Test Agent',
        description: null,
        system_prompt: 'Prompt',
        config: { model: 'gpt-4o' },
        skills: [],
        sub_agents: [],
        is_active: true,
        is_public: false,
        created_by: userId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        version: 1,
      }

      mockAgentRepository.findByIdAndOrg.mockResolvedValue(existingRow as any)
      mockAgentRepository.softDelete.mockResolvedValue(true)

      await expect(agentService.deleteAgent(orgId, 'agent-123')).resolves.toBeUndefined()
    })
  })
})
