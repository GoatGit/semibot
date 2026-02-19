/**
 * Skill Repository 测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { v4 as uuid } from 'uuid'

// Mock sql: 需要同时支持 tagged template 调用和普通函数调用（用于动态表名/SQL 片段）
const { mockSql, queryQueue } = vi.hoisted(() => {
  // 存储 tagged template 的返回值队列（仅用于"真正的查询"）
  const queryQueue: any[] = []

  // 跟踪是否在构建 SQL 片段（非异步查询）
  // sql`...` 用于构建 whereClause 片段时返回的是同步值
  // sql`SELECT ...` 用于实际查询时返回的是 Promise

  const mockSql: any = function (...args: any[]) {
    // 普通函数调用 sql(tableName) — 返回标识符片段
    if (args.length >= 1 && typeof args[0] === 'string' && !Array.isArray(args[0])) {
      return args[0]
    }
    // sql(values, col1, col2, ...) — 用于 INSERT 批量
    if (args.length >= 1 && Array.isArray(args[0]) && !args[0].raw) {
      return args[0]
    }
    // Tagged template literal 调用 sql`...`
    if (Array.isArray(args[0]) && args[0].raw) {
      const templateStr = args[0].join('')
      // 判断是否是实际查询（包含 SELECT/INSERT/UPDATE/DELETE/information_schema）
      const isQuery = /\b(SELECT|INSERT|UPDATE|DELETE|information_schema)\b/i.test(templateStr)
      if (isQuery) {
        const result = queryQueue.shift()
        return Promise.resolve(result ?? [])
      }
      // SQL 片段构建（如 whereClause 拼接），返回一个标记对象
      return { __sqlFragment: true, template: args[0], values: args.slice(1) }
    }
    // 其他情况
    return args[0]
  }

  mockSql.json = vi.fn((val: any) => val)

  mockSql.enqueue = (val: any) => {
    queryQueue.push(val)
    return mockSql
  }

  mockSql.clearQueue = () => {
    queryQueue.length = 0
  }

  return { mockSql, queryQueue }
})

vi.mock('../../lib/db', () => ({
  sql: mockSql,
}))

vi.mock('../../lib/logger', () => ({
  logPaginationLimit: vi.fn(),
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  repositoryLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

import * as skillRepository from '../../repositories/skill.repository'

describe('SkillRepository', () => {
  const testOrgId = uuid()
  const testUserId = uuid()

  beforeEach(() => {
    mockSql.clearQueue()
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

      mockSql.enqueue([mockSkill])

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

      mockSql.enqueue([mockSkill])

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

      // hasSkillsDeletedAtColumn 查询 (information_schema)
      mockSql.enqueue([{ '1': 1 }])
      // findById 查询 (SELECT)
      mockSql.enqueue([mockSkill])

      const result = await skillRepository.findById(skillId)

      expect(result).toBeDefined()
      expect(result?.id).toBe(skillId)
    })

    it('应该返回 null 如果不存在', async () => {
      // hasSkillsDeletedAtColumn 已缓存
      // findById 查询 (SELECT)
      mockSql.enqueue([])

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

      // findByIdAndOrg 查询 (SELECT)
      mockSql.enqueue([mockSkill])

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

      mockSql.enqueue([mockSkill])

      const result = await skillRepository.findByIdAndOrg(skillId, testOrgId)

      expect(result).toBeDefined()
      expect(result?.is_builtin).toBe(true)
    })

    it('应该返回 null 如果组织不匹配且不是内置', async () => {
      mockSql.enqueue([])

      const result = await skillRepository.findByIdAndOrg(uuid(), uuid())

      expect(result).toBeNull()
    })
  })

  describe('findAll', () => {
    it('应该返��分页结果', async () => {
      const mockSkills = Array.from({ length: 10 }, (_, i) => ({
        id: uuid(),
        org_id: testOrgId,
        name: `Skill ${i}`,
      }))

      // COUNT 查询 (SELECT COUNT)
      mockSql.enqueue([{ total: '15' }])
      // SELECT 查询
      mockSql.enqueue(mockSkills)

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

      // COUNT 查询
      mockSql.enqueue([{ total: '1' }])
      // SELECT 查询
      mockSql.enqueue(mockSkills)

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

      // COUNT 查询
      mockSql.enqueue([{ total: '2' }])
      // SELECT 查询
      mockSql.enqueue(mockSkills)

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

      // findById 查询 (SELECT)
      mockSql.enqueue([existingSkill])
      // UPDATE 查询
      mockSql.enqueue([updatedSkill])

      const result = await skillRepository.update(skillId, { name: 'New Name' })

      expect(result?.name).toBe('New Name')
    })

    it('应该返回 null 如果不存在', async () => {
      // findById 查询 (SELECT)
      mockSql.enqueue([])

      const result = await skillRepository.update(uuid(), { name: 'New Name' })

      expect(result).toBeNull()
    })
  })

  describe('softDelete', () => {
    it('应该软删除 Skill', async () => {
      const skillId = uuid()

      // softDelete 查询 (UPDATE)
      mockSql.enqueue([{ id: skillId }])

      const result = await skillRepository.softDelete(skillId)

      expect(result).toBe(true)
    })

    it('应该返回 false 如果不存在', async () => {
      // softDelete 查询 (UPDATE/DELETE)
      mockSql.enqueue([])

      const result = await skillRepository.softDelete(uuid())

      expect(result).toBe(false)
    })
  })
})
