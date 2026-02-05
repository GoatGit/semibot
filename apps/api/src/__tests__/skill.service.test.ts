/**
 * Skill Service 单元测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as skillService from '../services/skill.service'
import * as skillRepository from '../repositories/skill.repository'

// Mock repository
vi.mock('../repositories/skill.repository')

const mockSkillRepository = skillRepository as typeof skillRepository & {
  findAll: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  findById: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  softDelete: ReturnType<typeof vi.fn>
}

describe('Skill Service', () => {
  const mockOrgId = 'org-123'
  const mockUserId = 'user-123'
  const mockSkillId = 'skill-123'

  const mockSkillRow: skillRepository.SkillRow = {
    id: mockSkillId,
    org_id: mockOrgId,
    name: 'Test Skill',
    description: 'A test skill',
    trigger_keywords: ['test', 'example'],
    tools: [{ name: 'testTool', type: 'function' }],
    config: { maxExecutionTime: 30000 },
    is_builtin: false,
    is_active: true,
    created_by: mockUserId,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createSkill', () => {
    it('should create a new skill successfully', async () => {
      mockSkillRepository.findAll.mockResolvedValue({
        data: [],
        meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
      })
      mockSkillRepository.create.mockResolvedValue(mockSkillRow)

      const input = {
        name: 'Test Skill',
        description: 'A test skill',
        triggerKeywords: ['test', 'example'],
      }

      const result = await skillService.createSkill(mockOrgId, mockUserId, input)

      expect(result).toBeDefined()
      expect(result.name).toBe('Test Skill')
      expect(result.orgId).toBe(mockOrgId)
      expect(mockSkillRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: mockOrgId,
          name: 'Test Skill',
          createdBy: mockUserId,
        })
      )
    })

    it('should throw error when skill limit exceeded', async () => {
      mockSkillRepository.findAll.mockResolvedValue({
        data: Array(50).fill(mockSkillRow),
        meta: { total: 50, page: 1, limit: 20, totalPages: 3 },
      })

      await expect(
        skillService.createSkill(mockOrgId, mockUserId, { name: 'New Skill' })
      ).rejects.toThrow()
    })
  })

  describe('getSkill', () => {
    it('should return skill when found', async () => {
      mockSkillRepository.findById.mockResolvedValue(mockSkillRow)

      const result = await skillService.getSkill(mockOrgId, mockSkillId)

      expect(result).toBeDefined()
      expect(result.id).toBe(mockSkillId)
      expect(result.name).toBe('Test Skill')
    })

    it('should throw error when skill not found', async () => {
      mockSkillRepository.findById.mockResolvedValue(null)

      await expect(skillService.getSkill(mockOrgId, 'non-existent')).rejects.toThrow()
    })

    it('should throw error when skill belongs to different org', async () => {
      mockSkillRepository.findById.mockResolvedValue({
        ...mockSkillRow,
        org_id: 'different-org',
        is_builtin: false,
      })

      await expect(skillService.getSkill(mockOrgId, mockSkillId)).rejects.toThrow()
    })

    it('should allow access to builtin skills from any org', async () => {
      mockSkillRepository.findById.mockResolvedValue({
        ...mockSkillRow,
        org_id: null,
        is_builtin: true,
      })

      const result = await skillService.getSkill(mockOrgId, mockSkillId)

      expect(result).toBeDefined()
      expect(result.isBuiltin).toBe(true)
    })
  })

  describe('listSkills', () => {
    it('should return paginated skills list', async () => {
      mockSkillRepository.findAll.mockResolvedValue({
        data: [mockSkillRow],
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
      })

      const result = await skillService.listSkills(mockOrgId, { page: 1, limit: 20 })

      expect(result.data).toHaveLength(1)
      expect(result.meta.total).toBe(1)
      expect(mockSkillRepository.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: mockOrgId,
          page: 1,
          limit: 20,
        })
      )
    })

    it('should support search filter', async () => {
      mockSkillRepository.findAll.mockResolvedValue({
        data: [],
        meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
      })

      await skillService.listSkills(mockOrgId, { search: 'test' })

      expect(mockSkillRepository.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          search: 'test',
        })
      )
    })
  })

  describe('updateSkill', () => {
    it('should update skill successfully', async () => {
      mockSkillRepository.findById.mockResolvedValue(mockSkillRow)
      mockSkillRepository.update.mockResolvedValue({
        ...mockSkillRow,
        name: 'Updated Skill',
      })

      const result = await skillService.updateSkill(mockOrgId, mockSkillId, {
        name: 'Updated Skill',
      })

      expect(result.name).toBe('Updated Skill')
      expect(mockSkillRepository.update).toHaveBeenCalledWith(
        mockSkillId,
        expect.objectContaining({ name: 'Updated Skill' })
      )
    })

    it('should throw error when updating builtin skill', async () => {
      mockSkillRepository.findById.mockResolvedValue({
        ...mockSkillRow,
        is_builtin: true,
      })

      await expect(
        skillService.updateSkill(mockOrgId, mockSkillId, { name: 'Updated' })
      ).rejects.toThrow()
    })

    it('should throw error when skill not found', async () => {
      mockSkillRepository.findById.mockResolvedValue(null)

      await expect(
        skillService.updateSkill(mockOrgId, 'non-existent', { name: 'Updated' })
      ).rejects.toThrow()
    })
  })

  describe('deleteSkill', () => {
    it('should delete skill successfully', async () => {
      mockSkillRepository.findById.mockResolvedValue(mockSkillRow)
      mockSkillRepository.softDelete.mockResolvedValue(true)

      await expect(skillService.deleteSkill(mockOrgId, mockSkillId)).resolves.not.toThrow()

      expect(mockSkillRepository.softDelete).toHaveBeenCalledWith(mockSkillId)
    })

    it('should throw error when deleting builtin skill', async () => {
      mockSkillRepository.findById.mockResolvedValue({
        ...mockSkillRow,
        is_builtin: true,
      })

      await expect(skillService.deleteSkill(mockOrgId, mockSkillId)).rejects.toThrow()
    })

    it('should throw error when skill not found', async () => {
      mockSkillRepository.findById.mockResolvedValue(null)

      await expect(skillService.deleteSkill(mockOrgId, 'non-existent')).rejects.toThrow()
    })
  })
})
