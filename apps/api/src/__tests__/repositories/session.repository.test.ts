/**
 * Session Repository 测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { v4 as uuid } from 'uuid'

// Mock sql
vi.mock('../../lib/db', () => ({
  sql: vi.fn(),
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

import { sql } from '../../lib/db'
import * as sessionRepository from '../../repositories/session.repository'

describe('SessionRepository', () => {
  const mockSql = sql as unknown as ReturnType<typeof vi.fn>
  const testOrgId = uuid()
  const testUserId = uuid()
  const testAgentId = uuid()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('create', () => {
    it('应该成功创建 Session', async () => {
      const mockSession = {
        id: uuid(),
        org_id: testOrgId,
        user_id: testUserId,
        agent_id: testAgentId,
        title: 'Test Session',
        is_active: true,
        created_at: new Date().toISOString(),
      }

      mockSql.mockResolvedValueOnce([mockSession])

      const result = await sessionRepository.create({
        orgId: testOrgId,
        userId: testUserId,
        agentId: testAgentId,
        title: 'Test Session',
      })

      expect(result).toBeDefined()
      expect(result.title).toBe('Test Session')
      expect(result.org_id).toBe(testOrgId)
    })
  })

  describe('findById', () => {
    it('应该返回存在的 Session', async () => {
      const sessionId = uuid()
      const mockSession = {
        id: sessionId,
        org_id: testOrgId,
        title: 'Test Session',
      }

      mockSql.mockResolvedValueOnce([mockSession])

      const result = await sessionRepository.findById(sessionId)

      expect(result).toBeDefined()
      expect(result?.id).toBe(sessionId)
    })

    it('应该返回 null 如果不存在', async () => {
      mockSql.mockResolvedValueOnce([])

      const result = await sessionRepository.findById(uuid())

      expect(result).toBeNull()
    })
  })

  describe('findByIdAndOrg', () => {
    it('应该只返回属于指定组织的 Session', async () => {
      const sessionId = uuid()
      const mockSession = {
        id: sessionId,
        org_id: testOrgId,
        title: 'Test Session',
      }

      mockSql.mockResolvedValueOnce([mockSession])

      const result = await sessionRepository.findByIdAndOrg(sessionId, testOrgId)

      expect(result).toBeDefined()
      expect(result?.org_id).toBe(testOrgId)
    })

    it('应该返回 null 如果组织不匹配', async () => {
      mockSql.mockResolvedValueOnce([])

      const result = await sessionRepository.findByIdAndOrg(uuid(), uuid())

      expect(result).toBeNull()
    })
  })

  describe('findByUserAndOrg', () => {
    it('应该返回用户的所有 Session', async () => {
      const mockSessions = [
        { id: uuid(), org_id: testOrgId, user_id: testUserId, title: 'Session 1' },
        { id: uuid(), org_id: testOrgId, user_id: testUserId, title: 'Session 2' },
      ]

      // sql 片段构建调用（whereClause）
      mockSql.mockReturnValueOnce([])
      // 实际查询：COUNT + SELECT
      mockSql.mockResolvedValueOnce([{ total: '2' }])
      mockSql.mockResolvedValueOnce(mockSessions)

      const result = await sessionRepository.findByUserAndOrg({
        orgId: testOrgId,
        userId: testUserId,
      })

      expect(result.data).toHaveLength(2)
      expect(result.meta.total).toBe(2)
    })

    it('应该支持分页', async () => {
      const mockSessions = Array.from({ length: 10 }, (_, i) => ({
        id: uuid(),
        org_id: testOrgId,
        user_id: testUserId,
        title: `Session ${i}`,
      }))

      // sql 片段构建调用（whereClause）
      mockSql.mockReturnValueOnce([])
      // 实际查询：COUNT + SELECT
      mockSql.mockResolvedValueOnce([{ total: '25' }])
      mockSql.mockResolvedValueOnce(mockSessions)

      const result = await sessionRepository.findByUserAndOrg({
        orgId: testOrgId,
        userId: testUserId,
        page: 1,
        limit: 10,
      })

      expect(result.data).toHaveLength(10)
      expect(result.meta.totalPages).toBe(3)
    })
  })

  describe('updateTitle', () => {
    it('应该更新 Session', async () => {
      const sessionId = uuid()
      const mockSession = {
        id: sessionId,
        org_id: testOrgId,
        title: 'Updated Title',
      }

      mockSql.mockResolvedValueOnce([mockSession])

      const result = await sessionRepository.updateTitle(sessionId, testOrgId,
        'Updated Title',
      )

      expect(result?.title).toBe('Updated Title')
    })
  })

  describe('softDelete', () => {
    it('应该软删除 Session', async () => {
      const sessionId = uuid()

      mockSql.mockResolvedValueOnce([{ id: sessionId }])

      const result = await sessionRepository.softDelete(sessionId, testOrgId, testUserId)

      expect(result).toBe(true)
    })

    it('应该返回 false 如果不存在', async () => {
      mockSql.mockResolvedValueOnce([])

      const result = await sessionRepository.softDelete(uuid(), testOrgId, testUserId)

      expect(result).toBe(false)
    })
  })
})
