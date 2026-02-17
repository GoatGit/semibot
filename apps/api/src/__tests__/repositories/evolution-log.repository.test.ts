/**
 * evolution-log.repository 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockSql } = vi.hoisted(() => {
  const mockSql = Object.assign(vi.fn(), {
    json: vi.fn((val: unknown) => val),
  })
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

import { v4 as uuid } from 'uuid'

const testOrgId = uuid()
const testAgentId = uuid()
const testSessionId = uuid()

const mockLogRow = {
  id: uuid(),
  org_id: testOrgId,
  agent_id: testAgentId,
  session_id: testSessionId,
  stage: 'extract',
  status: 'completed',
  evolved_skill_id: null,
  input_data: { reflection: { success: true } },
  output_data: { skill_name: '查询订单' },
  error_message: null,
  duration_ms: 1200,
  tokens_used: 500,
  created_at: new Date().toISOString(),
}

describe('evolution-log.repository', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  describe('create', () => {
    it('应成功创建进化日志', async () => {
      mockSql.mockResolvedValueOnce([mockLogRow])

      const { create } = await import(
        '../../repositories/evolution-log.repository'
      )

      const result = await create({
        orgId: testOrgId,
        agentId: testAgentId,
        sessionId: testSessionId,
        stage: 'extract',
        status: 'completed',
        outputData: { skill_name: '查询订单' },
        durationMs: 1200,
        tokensUsed: 500,
      })

      expect(result).toBeDefined()
      expect(result.stage).toBe('extract')
      expect(result.status).toBe('completed')
      expect(mockSql).toHaveBeenCalledTimes(1)
    })

    it('应记录失败日志', async () => {
      const failedLog = {
        ...mockLogRow,
        status: 'failed',
        error_message: 'LLM 超时',
      }
      mockSql.mockResolvedValueOnce([failedLog])

      const { create } = await import(
        '../../repositories/evolution-log.repository'
      )

      const result = await create({
        orgId: testOrgId,
        agentId: testAgentId,
        sessionId: testSessionId,
        stage: 'extract',
        status: 'failed',
        errorMessage: 'LLM 超时',
      })

      expect(result.status).toBe('failed')
      expect(result.error_message).toBe('LLM 超时')
    })
  })

  describe('findByOrg', () => {
    it('应返回分页日志列表', async () => {
      mockSql.mockReturnValueOnce([])  // where fragment
      mockSql.mockResolvedValueOnce([{ total: '2' }])
      mockSql.mockResolvedValueOnce([mockLogRow, { ...mockLogRow, id: uuid() }])

      const { findByOrg } = await import(
        '../../repositories/evolution-log.repository'
      )

      const result = await findByOrg({
        orgId: testOrgId,
        page: 1,
        limit: 10,
      })

      expect(result.meta.total).toBe(2)
      expect(result.data).toHaveLength(2)
    })

    it('按 agentId 过滤', async () => {
      mockSql.mockReturnValueOnce([])  // base where
      mockSql.mockReturnValueOnce([])  // agentId where
      mockSql.mockResolvedValueOnce([{ total: '1' }])
      mockSql.mockResolvedValueOnce([mockLogRow])

      const { findByOrg } = await import(
        '../../repositories/evolution-log.repository'
      )

      const result = await findByOrg({
        orgId: testOrgId,
        agentId: testAgentId,
        page: 1,
        limit: 10,
      })

      expect(result.meta.total).toBe(1)
    })

    it('按 stage 过滤', async () => {
      mockSql.mockReturnValueOnce([])  // base where
      mockSql.mockReturnValueOnce([])  // stage where
      mockSql.mockResolvedValueOnce([{ total: '1' }])
      mockSql.mockResolvedValueOnce([mockLogRow])

      const { findByOrg } = await import(
        '../../repositories/evolution-log.repository'
      )

      const result = await findByOrg({
        orgId: testOrgId,
        stage: 'extract',
        page: 1,
        limit: 10,
      })

      expect(result.meta.total).toBe(1)
      expect(result.data[0].stage).toBe('extract')
    })
  })

  describe('findBySession', () => {
    it('应返回会话的进化日志', async () => {
      mockSql.mockResolvedValueOnce([mockLogRow])

      const { findBySession } = await import(
        '../../repositories/evolution-log.repository'
      )

      const result = await findBySession(testSessionId, testOrgId)
      expect(result).toHaveLength(1)
      expect(result[0].session_id).toBe(testSessionId)
    })

    it('无日志时返回空数组', async () => {
      mockSql.mockResolvedValueOnce([])

      const { findBySession } = await import(
        '../../repositories/evolution-log.repository'
      )

      const result = await findBySession(uuid(), testOrgId)
      expect(result).toHaveLength(0)
    })
  })

  describe('findByEvolvedSkillId', () => {
    it('应返回技能相关日志', async () => {
      const skillId = uuid()
      const logWithSkill = { ...mockLogRow, evolved_skill_id: skillId }
      mockSql.mockResolvedValueOnce([logWithSkill])

      const { findByEvolvedSkillId } = await import(
        '../../repositories/evolution-log.repository'
      )

      const result = await findByEvolvedSkillId(skillId)
      expect(result).toHaveLength(1)
      expect(result[0].evolved_skill_id).toBe(skillId)
    })
  })
})
