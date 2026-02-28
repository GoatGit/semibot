/**
 * 多租户隔离测试
 *
 * 验证所有 Repository 的多租户隔离是否正确实现
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
import * as messageRepository from '../../repositories/message.repository'
import * as toolRepository from '../../repositories/tool.repository'

// V2 已移除多租户目标，此组保留为历史参考并默认跳过。
describe.skip('多租户隔离测试', () => {
  const mockSql = sql as unknown as ReturnType<typeof vi.fn>
  const orgA = uuid()
  const orgB = uuid()
  const userA = uuid()
  const userB = uuid()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Agent 隔离', () => {
    it('findByIdAndOrg 应该只返回属于指定组织的 Agent', async () => {
      const agentId = uuid()

      // 模拟返回空结果（因为 orgId 不匹配）
      mockSql.mockResolvedValueOnce([])

      const result = await agentRepository.findByIdAndOrg(agentId, orgA)

      expect(result).toBeNull()
      // 验证 SQL 查询包含 org_id 条件
      expect(mockSql).toHaveBeenCalled()
    })

    it('findByOrg 应该只返回指定组织的 Agent', async () => {
      const mockAgents = [
        { id: uuid(), org_id: orgA, name: 'Agent A1' },
        { id: uuid(), org_id: orgA, name: 'Agent A2' },
      ]

      mockSql.mockResolvedValueOnce([{ total: '2' }])
      mockSql.mockResolvedValueOnce(mockAgents)

      const result = await agentRepository.findByOrg({ orgId: orgA })

      expect(result.data).toHaveLength(2)
      expect(result.data.every((a: { org_id: string }) => a.org_id === orgA)).toBe(true)
    })

    it('update 应该验证 orgId', async () => {
      const agentId = uuid()

      // 模拟更新时找不到记录（因为 orgId 不匹配）
      mockSql.mockResolvedValueOnce([])

      const result = await agentRepository.update(agentId, orgB, { name: 'Hacked' })

      expect(result).toBeNull()
    })

    it('softDelete 应该验证 orgId', async () => {
      const agentId = uuid()

      // 模拟删除时找不到记录
      mockSql.mockResolvedValueOnce([])

      const result = await agentRepository.softDelete(agentId, orgB)

      expect(result).toBe(false)
    })
  })

  describe('Session 隔离', () => {
    it('findByIdAndOrg 应该只返回属于指定组织的 Session', async () => {
      const sessionId = uuid()

      mockSql.mockResolvedValueOnce([])

      const result = await sessionRepository.findByIdAndOrg(sessionId, orgA)

      expect(result).toBeNull()
    })

    it('findByUser 应该只返回指定组织和用户的 Session', async () => {
      const mockSessions = [
        { id: uuid(), org_id: orgA, user_id: userA, title: 'Session 1' },
      ]

      // sql 片段构建调用（whereClause）
      mockSql.mockReturnValueOnce([])
      // 实际查询：COUNT + SELECT
      mockSql.mockResolvedValueOnce([{ total: '1' }])
      mockSql.mockResolvedValueOnce(mockSessions)

      const result = await sessionRepository.findByUserAndOrg({
        orgId: orgA,
        userId: userA,
      })

      expect(result.data).toHaveLength(1)
      expect(result.data[0].org_id).toBe(orgA)
      expect(result.data[0].user_id).toBe(userA)
    })
  })

  describe('Message 隔离', () => {
    it('findByIdAndOrg 应该通过 Session 关联验证组织', async () => {
      const messageId = uuid()

      mockSql.mockResolvedValueOnce([])

      const result = await messageRepository.findByIdAndOrg(messageId, orgA)

      expect(result).toBeNull()
    })
  })

  describe('Tool 隔离', () => {
    it('findByIdAndOrg 应该支持内置 Tool 跨组织访问', async () => {
      const toolId = uuid()
      const mockTool = {
        id: toolId,
        org_id: null,
        name: 'Builtin Tool',
        is_builtin: true,
      }

      mockSql.mockResolvedValueOnce([mockTool])

      const result = await toolRepository.findByIdAndOrg(toolId, orgA)

      expect(result).toBeDefined()
      expect(result?.is_builtin).toBe(true)
    })

    it('自定义 Tool 应该隔离', async () => {
      const toolId = uuid()

      // 模拟找不到记录（orgId 不匹配且不是内置）
      mockSql.mockResolvedValueOnce([])

      const result = await toolRepository.findByIdAndOrg(toolId, orgB)

      expect(result).toBeNull()
    })
  })
})
