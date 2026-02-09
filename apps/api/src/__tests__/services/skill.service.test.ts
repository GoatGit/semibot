/**
 * Skill Service 测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as skillService from '../../services/skill.service'
import * as skillRepository from '../../repositories/skill.repository'

// Mock dependencies
vi.mock('../../repositories/skill.repository')
vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

const mockSkillRepository = vi.mocked(skillRepository)

describe('Skill Service', () => {
  const orgId = 'org-123'
  const userId = 'user-123'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createSkill', () => {
    it('应该成功创建 Skill', async () => {
      const input: skillService.CreateSkillInput = {
        name: 'Test Skill',
        description: 'A test skill',
        triggerKeywords: ['test', 'demo'],
      }

      const mockRow = {
        id: 'skill-123',
        org_id: orgId,
        name: 'Test Skill',
        description: 'A test skill',
        trigger_keywords: ['test', 'demo'],
        tools: [],
        config: {},
        is_builtin: false,
        is_active: true,
        created_by: userId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      mockSkillRepository.findAll.mockResolvedValue({
        data: [],
        meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
      })
      mockSkillRepository.create.mockResolvedValue(mockRow as any)

      const result = await skillService.createSkill(orgId, userId, input)

      expect(result.id).toBe('skill-123')
      expect(result.name).toBe('Test Skill')
      expect(result.isBuiltin).toBe(false)
    })

    it('超过配额时应该抛出错误', async () => {
      mockSkillRepository.findAll.mockResolvedValue({
        data: [],
        meta: { total: 100, page: 1, limit: 20, totalPages: 5 },
      })

      const input: skillService.CreateSkillInput = {
        name: 'Test Skill',
      }

      await expect(skillService.createSkill(orgId, userId, input)).rejects.toThrow()
    })
  })

  describe('getSkill', () => {
    it('应该返回组织的 Skill', async () => {
      const mockRow = {
        id: 'skill-123',
        org_id: orgId,
        name: 'Test Skill',
        description: null,
        trigger_keywords: [],
        tools: [],
        config: {},
        is_builtin: false,
        is_active: true,
        created_by: userId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      mockSkillRepository.findById.mockResolvedValue(mockRow as any)

      const result = await skillService.getSkill(orgId, 'skill-123')

      expect(result.id).toBe('skill-123')
      expect(result.name).toBe('Test Skill')
    })

    it('应该返回内置 Skill', async () => {
      const mockRow = {
        id: 'builtin-skill',
        org_id: null,
        name: 'Builtin Skill',
        description: null,
        trigger_keywords: [],
        tools: [],
        config: {},
        is_builtin: true,
        is_active: true,
        created_by: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      mockSkillRepository.findById.mockResolvedValue(mockRow as any)

      const result = await skillService.getSkill(orgId, 'builtin-skill')

      expect(result.isBuiltin).toBe(true)
    })

    it('不存在时应该抛出 SKILL_NOT_FOUND', async () => {
      mockSkillRepository.findById.mockResolvedValue(null)

      await expect(skillService.getSkill(orgId, 'nonexistent')).rejects.toThrow()
    })

    it('其他组织的非内置 Skill 应该抛出错误', async () => {
      const mockRow = {
        id: 'skill-123',
        org_id: 'other-org',
        name: 'Other Skill',
        description: null,
        trigger_keywords: [],
        tools: [],
        config: {},
        is_builtin: false,
        is_active: true,
        created_by: 'other-user',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      mockSkillRepository.findById.mockResolvedValue(mockRow as any)

      await expect(skillService.getSkill(orgId, 'skill-123')).rejects.toThrow()
    })
  })

  describe('listSkills', () => {
    it('应该返回分页的 Skills 列表', async () => {
      const mockRows = [
        {
          id: 'skill-1',
          org_id: orgId,
          name: 'Skill 1',
          description: null,
          trigger_keywords: [],
          tools: [],
          config: {},
          is_builtin: false,
          is_active: true,
          created_by: userId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          id: 'skill-2',
          org_id: null,
          name: 'Builtin Skill',
          description: null,
          trigger_keywords: [],
          tools: [],
          config: {},
          is_builtin: true,
          is_active: true,
          created_by: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]

      mockSkillRepository.findAll.mockResolvedValue({
        data: mockRows as any,
        meta: { total: 2, page: 1, limit: 20, totalPages: 1 },
      })

      const result = await skillService.listSkills(orgId, { includeBuiltin: true })

      expect(result.data).toHaveLength(2)
      expect(result.meta.total).toBe(2)
    })
  })

  describe('updateSkill', () => {
    it('应该成功更新 Skill', async () => {
      const existingRow = {
        id: 'skill-123',
        org_id: orgId,
        name: 'Old Name',
        description: null,
        trigger_keywords: [],
        tools: [],
        config: {},
        is_builtin: false,
        is_active: true,
        created_by: userId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      const updatedRow = {
        ...existingRow,
        name: 'New Name',
        description: 'Updated description',
      }

      mockSkillRepository.findById.mockResolvedValue(existingRow as any)
      mockSkillRepository.update.mockResolvedValue(updatedRow as any)

      const result = await skillService.updateSkill(orgId, 'skill-123', {
        name: 'New Name',
        description: 'Updated description',
      })

      expect(result.name).toBe('New Name')
      expect(result.description).toBe('Updated description')
    })

    it('内置 Skill 不可修改', async () => {
      const builtinRow = {
        id: 'builtin-skill',
        org_id: null,
        name: 'Builtin',
        description: null,
        trigger_keywords: [],
        tools: [],
        config: {},
        is_builtin: true,
        is_active: true,
        created_by: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      mockSkillRepository.findById.mockResolvedValue(builtinRow as any)

      await expect(
        skillService.updateSkill(orgId, 'builtin-skill', { name: 'New Name' })
      ).rejects.toThrow()
    })
  })

  describe('deleteSkill', () => {
    it('应该成功软删除 Skill', async () => {
      const existingRow = {
        id: 'skill-123',
        org_id: orgId,
        name: 'Test Skill',
        description: null,
        trigger_keywords: [],
        tools: [],
        config: {},
        is_builtin: false,
        is_active: true,
        created_by: userId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      mockSkillRepository.findById.mockResolvedValue(existingRow as any)
      mockSkillRepository.softDelete.mockResolvedValue(true)

      await expect(skillService.deleteSkill(orgId, 'skill-123')).resolves.toBeUndefined()
    })

    it('内置 Skill 不可删除', async () => {
      const builtinRow = {
        id: 'builtin-skill',
        org_id: null,
        name: 'Builtin',
        description: null,
        trigger_keywords: [],
        tools: [],
        config: {},
        is_builtin: true,
        is_active: true,
        created_by: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      mockSkillRepository.findById.mockResolvedValue(builtinRow as any)

      await expect(skillService.deleteSkill(orgId, 'builtin-skill')).rejects.toThrow()
    })
  })

  describe('getActiveSkillsByIds', () => {
    it('应该批量获取活跃的 Skills', async () => {
      const mockRows = [
        {
          id: 'skill-1',
          org_id: orgId,
          name: 'Skill 1',
          description: null,
          trigger_keywords: [],
          tools: [],
          config: {},
          is_builtin: false,
          is_active: true,
          created_by: userId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]

      mockSkillRepository.findActiveByIdsAndOrg.mockResolvedValue(mockRows as any)

      const result = await skillService.getActiveSkillsByIds(orgId, ['skill-1', 'skill-2'])

      expect(result).toHaveLength(1)
      expect(mockSkillRepository.findActiveByIdsAndOrg).toHaveBeenCalledWith(
        ['skill-1', 'skill-2'],
        orgId
      )
    })

    it('空数组应该返回空结果', async () => {
      const result = await skillService.getActiveSkillsByIds(orgId, [])

      expect(result).toHaveLength(0)
      expect(mockSkillRepository.findActiveByIdsAndOrg).not.toHaveBeenCalled()
    })

    it('应该去重 Skill IDs', async () => {
      mockSkillRepository.findActiveByIdsAndOrg.mockResolvedValue([])

      await skillService.getActiveSkillsByIds(orgId, ['skill-1', 'skill-1', 'skill-2'])

      expect(mockSkillRepository.findActiveByIdsAndOrg).toHaveBeenCalledWith(
        ['skill-1', 'skill-2'],
        orgId
      )
    })
  })
})
