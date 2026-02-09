/**
 * Skill Repository 测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { v4 as uuid } from 'uuid'

// Mock sql
vi.mock('../../lib/db', () => ({
  sql: vi.fn(),
}))

import { sql } from '../../lib/db'
import * as skillRepository from '../../repositories/skill.repository'

describe('SkillRepository', () => {
  const mockSql = sql as unknown as ReturnType<typeof vi.fn>
  const testOrgId = uuid()
  const testUserId = uuid()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('create', () => {
    it('应该成功创建 Skill', async () => {
      const mockSkill = {
        id: uuid(),
        org_id: testOrgId,
        name: 'Test Skill',
        description: 'Test description',
        trigger_keywords: ['test', 'skill'],
        tools: [],
        config: {},
        is_builtin: false,
        is_active: true,
        created_by: testUserId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      mockSql.mockResolvedValueOnce([mockSkill])

      const result = await skillRepository.create({
        orgId: testOrgId,
        name: 'Test Skill',
        description: 'Test description',
        triggerKeywords: ['test', 'skill'],
        createdBy: testUserId,
      })

      expect(result).toBeDefined()
      expect(result.name).toBe('Test Skill')
      expect(result.org_id).toBe(testOrgId)
    })

    it('应该创建内置 Skill', async () => {
      const mockSkill = {
        id: uuid(),
        org_id: null,
        name: 'Builtin Skill',
        is_builtin: true,
        is_active: true,
      }

      mockSql.mockResolvedValueOnce([mockSkill])

      const result = await skillRepository.create({
        orgId: null,
        name: 'Builtin Skill',
        isBuiltin: true,
      })

      expect(result.is_builtin).toBe(true)
      expect(result.org_id).toBeNull()
    })
  })

  describe('findById', () => {
    it('应该返回存在的 Skill', async () => {
      const skillId = uuid()
      const mockSkill = {
        id: skillId,
        org_id: testOrgId,
        name: 'Test Skill',
      }

      mockSql.mockResolvedValueOnce([mockSkill])

      const result = await skillRepository.findById(skillId)

      expect(result).toBeDefined()
      expect(result?.id).toBe(skillId)
    })

    it('应该返回 null 如果不存在', async () => {
      mockSql.mockResolvedValueOnce([])

      const result = await skillRepository.findById(uuid())

      expect(result).toBeNull()
    })
  })

  describe('findByIdAndOrg', () => {
    it('应该返回属于指定组织的 Skill', async () => {
      const skillId = uuid()
      const mockSkill = {
        id: skillId,
        org_id: testOrgId,
        name: 'Test Skill',
        is_builtin: false,
      }

      mockSql.mockResolvedValueOnce([mockSkill])

      const result = await skillRepository.findByIdAndOrg(skillId, testOrgId)

      expect(result).toBeDefined()
      expect(result?.org_id).toBe(testOrgId)
    })

    it('应该返回内置 Skill（跨组织）', async () => {
      const skillId = uuid()
      const mockSkill = {
        id: skillId,
        org_id: null,
        name: 'Builtin Skill',
        is_builtin: true,
      }

      mockSql.mockResolvedValueOnce([mockSkill])

      const result = await skillRepository.findByIdAndOrg(skillId, testOrgId)

      expect(result).toBeDefined()
      expect(result?.is_builtin).toBe(true)
    })

    it('应该返回 null 如果组织不匹配且不是内置', async () => {
      mockSql.mockResolvedValueOnce([])

      const result = await skillRepository.findByIdAndOrg(uuid(), uuid())

      expect(result).toBeNull()
    })
  })

  describe('findAll', () => {
    it('应该返回分页结果', async () => {
      const mockSkills = Array.from({ length: 10 }, (_, i) => ({
        id: uuid(),
        org_id: testOrgId,
        name: `Skill ${i}`,
      }))

      mockSql.mockResolvedValueOnce([{ total: '15' }])
      mockSql.mockResolvedValueOnce(mockSkills)

      const result = await skillRepository.findAll({
        orgId: testOrgId,
        page: 1,
        limit: 10,
      })

      expect(result.data).toHaveLength(10)
      expect(result.meta.total).toBe(15)
      expect(result.meta.totalPages).toBe(2)
    })

    it('应该支持搜索', async () => {
      const mockSkills = [
        { id: uuid(), org_id: testOrgId, name: 'Search Skill' },
      ]

      mockSql.mockResolvedValueOnce([{ total: '1' }])
      mockSql.mockResolvedValueOnce(mockSkills)

      const result = await skillRepository.findAll({
        orgId: testOrgId,
        search: 'Search',
      })

      expect(result.data).toHaveLength(1)
      expect(result.data[0].name).toContain('Search')
    })

    it('应该包含内置 Skill 当 includeBuiltin=true', async () => {
      const mockSkills = [
        { id: uuid(), org_id: testOrgId, name: 'Custom', is_builtin: false },
        { id: uuid(), org_id: null, name: 'Builtin', is_builtin: true },
      ]

      mockSql.mockResolvedValueOnce([{ total: '2' }])
      mockSql.mockResolvedValueOnce(mockSkills)

      const result = await skillRepository.findAll({
        orgId: testOrgId,
        includeBuiltin: true,
      })

      expect(result.data).toHaveLength(2)
    })
  })

  describe('update', () => {
    it('应该更新 Skill', async () => {
      const skillId = uuid()
      const existingSkill = {
        id: skillId,
        org_id: testOrgId,
        name: 'Old Name',
        description: 'Old description',
        trigger_keywords: [],
        tools: [],
        config: {},
        is_active: true,
      }
      const updatedSkill = {
        ...existingSkill,
        name: 'New Name',
      }

      // findById call
      mockSql.mockResolvedValueOnce([existingSkill])
      // update call
      mockSql.mockResolvedValueOnce([updatedSkill])

      const result = await skillRepository.update(skillId, { name: 'New Name' })

      expect(result?.name).toBe('New Name')
    })

    it('应该返回 null 如果不存在', async () => {
      mockSql.mockResolvedValueOnce([])

      const result = await skillRepository.update(uuid(), { name: 'New Name' })

      expect(result).toBeNull()
    })
  })

  describe('softDelete', () => {
    it('应该软删除 Skill', async () => {
      const skillId = uuid()

      mockSql.mockResolvedValueOnce([{ id: skillId }])

      const result = await skillRepository.softDelete(skillId)

      expect(result).toBe(true)
    })

    it('应该返回 false 如果不存在', async () => {
      mockSql.mockResolvedValueOnce([])

      const result = await skillRepository.softDelete(uuid())

      expect(result).toBe(false)
    })
  })
})
