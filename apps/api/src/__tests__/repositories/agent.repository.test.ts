/**
 * Agent Repository 测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { v4 as uuid } from 'uuid'

// Mock sql as tagged template literal function with .json helper
const { mockSql } = vi.hoisted(() => {
  const mockSql = Object.assign(vi.fn(), {
    json: vi.fn((val: unknown) => val),
  })
  return { mockSql }
})

vi.mock('../../lib/db', () => ({
  sql: mockSql,
}))

// Mock logger
vi.mock('../../lib/logger', () => ({
  logPaginationLimit: vi.fn(),
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import * as agentRepository from '../../repositories/agent.repository'

describe('AgentRepository', () => {
  const testOrgId = uuid()
  const testUserId = uuid()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('create', () => {
    it('应该成功创建 Agent', async () => {
      const mockAgent = {
        id: uuid(),
        org_id: testOrgId,
        name: 'Test Agent',
        description: 'Test description',
        system_prompt: 'You are a helpful assistant',
        config: {},
        skills: [],
        sub_agents: [],
        version: 1,
        is_active: true,
        is_public: false,
        is_system: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      mockSql.mockResolvedValueOnce([mockAgent])

      const result = await agentRepository.create({
        orgId: testOrgId,
        name: 'Test Agent',
        description: 'Test description',
        systemPrompt: 'You are a helpful assistant',
        config: {},
      })

      expect(result).toBeDefined()
      expect(result.name).toBe('Test Agent')
      expect(result.org_id).toBe(testOrgId)
      expect(mockSql).toHaveBeenCalled()
    })

    it('应该设置默认值', async () => {
      const mockAgent = {
        id: uuid(),
        org_id: testOrgId,
        name: 'Test Agent',
        description: null,
        system_prompt: 'prompt',
        config: {},
        skills: [],
        sub_agents: [],
        version: 1,
        is_active: true,
        is_public: false,
        is_system: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      mockSql.mockResolvedValueOnce([mockAgent])

      const result = await agentRepository.create({
        orgId: testOrgId,
        name: 'Test Agent',
        systemPrompt: 'prompt',
        config: {},
      })

      expect(result.is_active).toBe(true)
      expect(result.version).toBe(1)
    })
  })

  describe('findById', () => {
    it('应该返回存在的 Agent', async () => {
      const agentId = uuid()
      const mockAgent = {
        id: agentId,
        org_id: testOrgId,
        name: 'Test Agent',
        is_active: true,
      }

      mockSql.mockResolvedValueOnce([mockAgent])

      const result = await agentRepository.findById(agentId)

      expect(result).toBeDefined()
      expect(result?.id).toBe(agentId)
    })

    it('应该返回 null 如果不存在', async () => {
      mockSql.mockResolvedValueOnce([])

      const result = await agentRepository.findById(uuid())

      expect(result).toBeNull()
    })
  })

  describe('findByIdAndOrg', () => {
    it('应该只返回属于指定组织的 Agent', async () => {
      const agentId = uuid()
      const mockAgent = {
        id: agentId,
        org_id: testOrgId,
        name: 'Test Agent',
      }

      mockSql.mockResolvedValueOnce([mockAgent])

      const result = await agentRepository.findByIdAndOrg(agentId, testOrgId)

      expect(result).toBeDefined()
      expect(result?.org_id).toBe(testOrgId)
    })

    it('应该返回系统 Agent（org_id 不匹配但 is_system=true）', async () => {
      const agentId = uuid()
      const mockAgent = {
        id: agentId,
        org_id: null,
        name: 'System Agent',
        is_system: true,
      }

      mockSql.mockResolvedValueOnce([mockAgent])

      const result = await agentRepository.findByIdAndOrg(agentId, testOrgId)

      expect(result).toBeDefined()
      expect(result?.is_system).toBe(true)
    })

    it('应该返回 null 如果组织不匹配', async () => {
      mockSql.mockResolvedValueOnce([])

      const result = await agentRepository.findByIdAndOrg(uuid(), uuid())

      expect(result).toBeNull()
    })
  })

  describe('findByOrg', () => {
    it('应该返回分页结果', async () => {
      const mockAgents = Array.from({ length: 10 }, (_, i) => ({
        id: uuid(),
        org_id: testOrgId,
        name: `Agent ${i}`,
      }))

      // Mock count query
      mockSql.mockResolvedValueOnce([{ total: '15' }])
      // Mock data query
      mockSql.mockResolvedValueOnce(mockAgents)

      const result = await agentRepository.findByOrg({
        orgId: testOrgId,
        page: 1,
        limit: 10,
      })

      expect(result.data).toHaveLength(10)
      expect(result.meta.total).toBe(15)
      expect(result.meta.totalPages).toBe(2)
    })

    it('应该支持搜索', async () => {
      const mockAgents = [
        { id: uuid(), org_id: testOrgId, name: 'Alpha Agent' },
      ]

      mockSql.mockResolvedValueOnce([{ total: '1' }])
      mockSql.mockResolvedValueOnce(mockAgents)

      const result = await agentRepository.findByOrg({
        orgId: testOrgId,
        search: 'Alpha',
      })

      expect(result.data).toHaveLength(1)
      expect(result.data[0].name).toBe('Alpha Agent')
    })
  })

  describe('update', () => {
    it('应该更新 Agent', async () => {
      const agentId = uuid()
      const existingAgent = {
        id: agentId,
        org_id: testOrgId,
        name: 'Old Name',
        description: null,
        system_prompt: 'prompt',
        config: {},
        skills: [],
        sub_agents: [],
        version: 1,
        is_active: true,
        is_public: false,
        is_system: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      const updatedAgent = {
        ...existingAgent,
        name: 'Updated Name',
        version: 2,
      }

      // findByIdAndOrg 查询
      mockSql.mockResolvedValueOnce([existingAgent])
      // UPDATE 查询
      mockSql.mockResolvedValueOnce([updatedAgent])

      const result = await agentRepository.update(agentId, testOrgId, {
        name: 'Updated Name',
      })

      expect(result?.name).toBe('Updated Name')
      expect(result?.version).toBe(2)
    })

    it('应该返回 null 如果不存在', async () => {
      // findByIdAndOrg 返回空
      mockSql.mockResolvedValueOnce([])

      const result = await agentRepository.update(uuid(), testOrgId, {
        name: 'Updated',
      })

      expect(result).toBeNull()
    })

    it('系统 Agent 不可修改', async () => {
      const agentId = uuid()
      const systemAgent = {
        id: agentId,
        org_id: null,
        name: 'System Agent',
        is_system: true,
        version: 1,
      }

      // findByIdAndOrg 返回系统 Agent
      mockSql.mockResolvedValueOnce([systemAgent])

      const result = await agentRepository.update(agentId, testOrgId, {
        name: 'Hacked',
      })

      // 系统 Agent 更新应返回 null（is_system 守卫）
      expect(result).toBeNull()
      // 只调用了 findByIdAndOrg，没有执行 UPDATE
      expect(mockSql).toHaveBeenCalledTimes(1)
    })
  })

  describe('softDelete', () => {
    it('应该软删除 Agent', async () => {
      const agentId = uuid()

      mockSql.mockResolvedValueOnce([{ id: agentId }])

      const result = await agentRepository.softDelete(agentId, testOrgId, testUserId)

      expect(result).toBe(true)
    })

    it('应该返回 false 如果不存在', async () => {
      mockSql.mockResolvedValueOnce([])

      const result = await agentRepository.softDelete(uuid(), testOrgId, testUserId)

      expect(result).toBe(false)
    })
  })

  describe('countByOrg', () => {
    it('应该返回组织的 Agent 数量', async () => {
      mockSql.mockResolvedValueOnce([{ count: '5' }])

      const result = await agentRepository.countByOrg(testOrgId)

      expect(result).toBe(5)
    })
  })

  describe('findSystemDefault', () => {
    it('应该返回系统默认 Agent', async () => {
      const mockAgent = {
        id: '00000000-0000-0000-0000-000000000001',
        org_id: null,
        name: 'System Default Agent',
        is_system: true,
      }

      mockSql.mockResolvedValueOnce([mockAgent])

      const result = await agentRepository.findSystemDefault()

      expect(result).toBeDefined()
      expect(result?.is_system).toBe(true)
    })

    it('应该返回 null 如果不存在', async () => {
      mockSql.mockResolvedValueOnce([])

      const result = await agentRepository.findSystemDefault()

      expect(result).toBeNull()
    })
  })
})
