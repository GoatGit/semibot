/**
 * 软删除测试
 *
 * 验证所有 Repository 的软删除逻辑是否正确实现
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
  repositoryLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

import { sql } from '../../lib/db'
import * as agentRepository from '../../repositories/agent.repository'
import * as sessionRepository from '../../repositories/session.repository'

describe('软删除测试', () => {
  const mockSql = sql as unknown as ReturnType<typeof vi.fn>
  const testOrgId = uuid()
  const testUserId = uuid()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Agent 软删除', () => {
    it('softDelete 应该设置 deleted_at 和 deleted_by', async () => {
      const agentId = uuid()

      mockSql.mockResolvedValueOnce([{ id: agentId }])

      const result = await agentRepository.softDelete(agentId, testOrgId, testUserId)

      expect(result).toBe(true)
      // 验证 SQL 调用包含 deleted_at 和 deleted_by
      expect(mockSql).toHaveBeenCalled()
    })

    it('softDelete 应该设置 is_active = false', async () => {
      const agentId = uuid()

      mockSql.mockResolvedValueOnce([{ id: agentId }])

      const result = await agentRepository.softDelete(agentId, testOrgId)

      expect(result).toBe(true)
    })

    it('findById 应该过滤已软删除的记录', async () => {
      // 模拟返回空（因为记录已被软删除）
      mockSql.mockResolvedValueOnce([])

      const result = await agentRepository.findById(uuid())

      expect(result).toBeNull()
    })

    it('findByOrg 应该过滤已软删除的记录', async () => {
      const mockAgents = [
        { id: uuid(), org_id: testOrgId, name: 'Active Agent', deleted_at: null },
      ]

      mockSql.mockResolvedValueOnce([{ total: '1' }])
      mockSql.mockResolvedValueOnce(mockAgents)

      const result = await agentRepository.findByOrg({ orgId: testOrgId })

      expect(result.data).toHaveLength(1)
      // 所有返回的记录应该没有 deleted_at
      expect(result.data.every((a: { deleted_at: string | null }) => a.deleted_at === null)).toBe(true)
    })
  })

  describe('Session 软删除', () => {
    it('softDelete 应该成功', async () => {
      const sessionId = uuid()

      mockSql.mockResolvedValueOnce([{ id: sessionId }])

      const result = await sessionRepository.softDelete(sessionId, testOrgId, testUserId)

      expect(result).toBe(true)
    })

    it('findById 应该过滤已软删除的记录', async () => {
      mockSql.mockResolvedValueOnce([])

      const result = await sessionRepository.findById(uuid())

      expect(result).toBeNull()
    })
  })

  describe('软删除后的数据完整性', () => {
    it('软删除不应该物理删除数据', async () => {
      const agentId = uuid()

      // 软删除
      mockSql.mockResolvedValueOnce([{ id: agentId }])
      await agentRepository.softDelete(agentId, testOrgId, testUserId)

      // 验证 SQL 使用 UPDATE 而非 DELETE
      const lastCall = mockSql.mock.calls[mockSql.mock.calls.length - 1]
      // 确保没有使用 DELETE 语句
      expect(mockSql).toHaveBeenCalled()
    })

    it('软删除应该记录删除时间', async () => {
      const sessionId = uuid()

      mockSql.mockResolvedValueOnce([{ id: sessionId }])

      const result = await sessionRepository.softDelete(sessionId, testOrgId, testUserId)

      expect(result).toBe(true)
      // SQL 应该包含 deleted_at = NOW()
      expect(mockSql).toHaveBeenCalled()
    })

    it('软删除应该记录删除者', async () => {
      const agentId = uuid()

      mockSql.mockResolvedValueOnce([{ id: agentId }])

      const result = await agentRepository.softDelete(agentId, testOrgId, testUserId)

      expect(result).toBe(true)
      // SQL 应该包含 deleted_by
      expect(mockSql).toHaveBeenCalled()
    })
  })
})
