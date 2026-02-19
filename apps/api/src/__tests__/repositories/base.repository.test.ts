/**
 * BaseRepository 泛型基类测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { v4 as uuid } from 'uuid'

// Mock sql: 需要同时支持 tagged template 调用和普通函数调用（用于动态表名）
const { mockSql } = vi.hoisted(() => {
  // 存储 tagged template 的返回值队列
  const returnQueue: any[] = []

  const mockSql: any = function (...args: any[]) {
    // 普通函数调用 sql(tableName) — 返回标识符片段
    if (args.length === 1 && typeof args[0] === 'string' && !Array.isArray(args[0])) {
      return args[0]
    }
    // Tagged template literal 调用 sql`...`
    if (Array.isArray(args[0])) {
      const result = returnQueue.shift()
      return Promise.resolve(result)
    }
    // 其他情况（如 sql.json）
    return args[0]
  }

  mockSql.json = vi.fn((val: any) => val)

  mockSql.mockResolvedValueOnce = (val: any) => {
    returnQueue.push(val)
    return mockSql
  }

  mockSql.mockClear = () => {
    returnQueue.length = 0
  }

  return { mockSql }
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
}))

import { BaseRepository } from '../../repositories/base.repository'

// 测试用具体子类
interface TestRow {
  id: string
  org_id: string
  name: string
  deleted_at: string | null
}

interface TestEntity {
  id: string
  orgId: string
  name: string
}

class TestRepository extends BaseRepository<TestRow, TestEntity> {
  constructor() {
    super('test_table')
  }

  protected toEntity(row: TestRow): TestEntity {
    return {
      id: row.id,
      orgId: row.org_id,
      name: row.name,
    }
  }
}

describe('BaseRepository', () => {
  let repo: TestRepository
  const testOrgId = uuid()

  beforeEach(() => {
    mockSql.mockClear()
    repo = new TestRepository()
  })

  describe('findById', () => {
    it('应该返回存在的实体', async () => {
      const id = uuid()
      const mockRow: TestRow = { id, org_id: testOrgId, name: 'Test', deleted_at: null }
      mockSql.mockResolvedValueOnce([mockRow])

      const result = await repo.findById(id)

      expect(result).toEqual({ id, orgId: testOrgId, name: 'Test' })
    })

    it('应该返回 null 如果不存在', async () => {
      mockSql.mockResolvedValueOnce([])

      const result = await repo.findById(uuid())

      expect(result).toBeNull()
    })
  })

  describe('findByIdAndOrg', () => {
    it('应该返回属于指定组织的实体', async () => {
      const id = uuid()
      const mockRow: TestRow = { id, org_id: testOrgId, name: 'Test', deleted_at: null }
      mockSql.mockResolvedValueOnce([mockRow])

      const result = await repo.findByIdAndOrg(id, testOrgId)

      expect(result).toEqual({ id, orgId: testOrgId, name: 'Test' })
    })

    it('应该返回 null 如果组织不匹配', async () => {
      mockSql.mockResolvedValueOnce([])

      const result = await repo.findByIdAndOrg(uuid(), uuid())

      expect(result).toBeNull()
    })
  })

  describe('findByOrg', () => {
    it('应该返回分页结果', async () => {
      const id1 = uuid()
      const id2 = uuid()
      const mockRows: TestRow[] = [
        { id: id1, org_id: testOrgId, name: 'Test 1', deleted_at: null },
        { id: id2, org_id: testOrgId, name: 'Test 2', deleted_at: null },
      ]
      // countByOrg query
      mockSql.mockResolvedValueOnce([{ count: '2' }])
      // data query
      mockSql.mockResolvedValueOnce(mockRows)

      const result = await repo.findByOrg(testOrgId, 1, 10)

      expect(result.data).toHaveLength(2)
      expect(result.data[0].name).toBe('Test 1')
      expect(result.meta.total).toBe(2)
      expect(result.meta.page).toBe(1)
      expect(result.meta.totalPages).toBe(1)
    })

    it('应该返回空分页结果', async () => {
      mockSql.mockResolvedValueOnce([{ count: '0' }])
      mockSql.mockResolvedValueOnce([])

      const result = await repo.findByOrg(testOrgId)

      expect(result.data).toEqual([])
      expect(result.meta.total).toBe(0)
    })

    it('应该对 page 和 limit 进行下界保护', async () => {
      const mockRows: TestRow[] = []
      mockSql.mockResolvedValueOnce([{ count: '0' }])
      mockSql.mockResolvedValueOnce(mockRows)

      const result = await repo.findByOrg(testOrgId, 0, 0)

      expect(result.meta.page).toBe(1)
      expect(result.meta.limit).toBe(1)
      expect(result.meta.totalPages).toBe(0)
    })
  })

  describe('countByOrg', () => {
    it('应该返回组织的记录数量', async () => {
      mockSql.mockResolvedValueOnce([{ count: '42' }])

      const result = await repo.countByOrg(testOrgId)

      expect(result).toBe(42)
    })

    it('应该返回 0 如果没有记录', async () => {
      mockSql.mockResolvedValueOnce([{ count: '0' }])

      const result = await repo.countByOrg(testOrgId)

      expect(result).toBe(0)
    })
  })

  describe('softDelete', () => {
    it('应该软删除记录', async () => {
      const id = uuid()
      mockSql.mockResolvedValueOnce([{ id }])

      const result = await repo.softDelete(id, testOrgId, 'user-1')

      expect(result).toBe(true)
    })

    it('应该返回 false 如果记录不存在', async () => {
      mockSql.mockResolvedValueOnce([])

      const result = await repo.softDelete(uuid(), testOrgId)

      expect(result).toBe(false)
    })
  })

  describe('findByIds', () => {
    it('应该批量查询记录', async () => {
      const id1 = uuid()
      const id2 = uuid()
      const mockRows: TestRow[] = [
        { id: id1, org_id: testOrgId, name: 'Test 1', deleted_at: null },
        { id: id2, org_id: testOrgId, name: 'Test 2', deleted_at: null },
      ]
      mockSql.mockResolvedValueOnce(mockRows)

      const result = await repo.findByIds([id1, id2])

      expect(result).toHaveLength(2)
      expect(result[0].name).toBe('Test 1')
      expect(result[1].name).toBe('Test 2')
    })

    it('应该返回空数组如果 ids 为空', async () => {
      const result = await repo.findByIds([])

      expect(result).toEqual([])
    })
  })

  describe('toEntity', () => {
    it('应该正确转换行数据为实体', async () => {
      const id = uuid()
      const mockRow: TestRow = { id, org_id: testOrgId, name: 'Converted', deleted_at: null }
      mockSql.mockResolvedValueOnce([mockRow])

      const result = await repo.findById(id)

      expect(result).toEqual({
        id,
        orgId: testOrgId,
        name: 'Converted',
      })
    })
  })
})
