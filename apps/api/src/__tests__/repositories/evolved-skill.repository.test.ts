/**
 * evolved-skill.repository 单元测试
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

const mockSkillRow = {
  id: uuid(),
  org_id: testOrgId,
  agent_id: testAgentId,
  session_id: testSessionId,
  name: '查询订单状态',
  description: '根据订单号查询订单当前状态',
  trigger_keywords: ['订单', '查询'],
  steps: [{ order: 1, action: '查询', tool: 'order_query' }],
  tools_used: ['order_query'],
  parameters: { order_id: { type: 'string', required: true } },
  preconditions: { required_tools: ['order_query'] },
  expected_outcome: '返回订单状态',
  embedding: null,
  quality_score: 0.82,
  reusability_score: 0.85,
  status: 'pending_review',
  use_count: 10,
  success_count: 8,
  last_used_at: null,
  reviewed_by: null,
  reviewed_at: null,
  review_comment: null,
  version: 1,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  deleted_at: null,
  deleted_by: null,
}

describe('evolved-skill.repository', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  describe('create', () => {
    it('应成功创建进化技能', async () => {
      mockSql.mockResolvedValueOnce([mockSkillRow])

      const { create } = await import(
        '../../repositories/evolved-skill.repository'
      )

      const result = await create({
        orgId: testOrgId,
        agentId: testAgentId,
        sessionId: testSessionId,
        name: '查询订单状态',
        description: '根据订单号查询订单当前状态',
        steps: [{ order: 1, action: '查询', tool: 'order_query' }],
        toolsUsed: ['order_query'],
        qualityScore: 0.82,
        reusabilityScore: 0.85,
        status: 'pending_review',
      })

      expect(result).toBeDefined()
      expect(result.name).toBe('查询订单状态')
      expect(result.org_id).toBe(testOrgId)
      expect(mockSql).toHaveBeenCalledTimes(1)
    })
  })

  describe('findByIdAndOrg', () => {
    it('应返回指定技能', async () => {
      mockSql.mockResolvedValueOnce([mockSkillRow])

      const { findByIdAndOrg } = await import(
        '../../repositories/evolved-skill.repository'
      )

      const result = await findByIdAndOrg(mockSkillRow.id, testOrgId)
      expect(result).toBeDefined()
      expect(result!.id).toBe(mockSkillRow.id)
    })

    it('技能不存在时返回 null', async () => {
      mockSql.mockResolvedValueOnce([])

      const { findByIdAndOrg } = await import(
        '../../repositories/evolved-skill.repository'
      )

      const result = await findByIdAndOrg(uuid(), testOrgId)
      expect(result).toBeNull()
    })

    it('不同 org 无法访问其他 org 的技能', async () => {
      mockSql.mockResolvedValueOnce([])

      const { findByIdAndOrg } = await import(
        '../../repositories/evolved-skill.repository'
      )

      const result = await findByIdAndOrg(mockSkillRow.id, uuid())
      expect(result).toBeNull()
    })
  })

  describe('findByOrg', () => {
    it('应返回分页列表', async () => {
      // whereClause fragment + COUNT + SELECT
      mockSql.mockReturnValueOnce([])  // sql fragment
      mockSql.mockResolvedValueOnce([{ total: '3' }])
      mockSql.mockResolvedValueOnce([mockSkillRow, mockSkillRow, mockSkillRow])

      const { findByOrg } = await import(
        '../../repositories/evolved-skill.repository'
      )

      const result = await findByOrg({
        orgId: testOrgId,
        page: 1,
        limit: 10,
      })

      expect(result.meta.total).toBe(3)
      expect(result.data).toHaveLength(3)
    })

    it('按状态过滤', async () => {
      mockSql.mockReturnValueOnce([])  // base where
      mockSql.mockReturnValueOnce([])  // status where
      mockSql.mockResolvedValueOnce([{ total: '1' }])
      mockSql.mockResolvedValueOnce([{ ...mockSkillRow, status: 'approved' }])

      const { findByOrg } = await import(
        '../../repositories/evolved-skill.repository'
      )

      const result = await findByOrg({
        orgId: testOrgId,
        status: 'approved',
        page: 1,
        limit: 10,
      })

      expect(result.meta.total).toBe(1)
      expect(result.data[0].status).toBe('approved')
    })
  })

  describe('updateReviewStatus', () => {
    it('应审核通过技能', async () => {
      const updated = { ...mockSkillRow, status: 'approved', version: 2 }
      mockSql.mockResolvedValueOnce([updated])

      const { updateReviewStatus } = await import(
        '../../repositories/evolved-skill.repository'
      )

      const result = await updateReviewStatus(
        mockSkillRow.id, 'approve', 'user-001', '质量良好'
      )

      expect(result).toBeDefined()
      expect(result!.status).toBe('approved')
      expect(result!.version).toBe(2)
    })

    it('非 pending_review 状态时返回 null', async () => {
      mockSql.mockResolvedValueOnce([])

      const { updateReviewStatus } = await import(
        '../../repositories/evolved-skill.repository'
      )

      const result = await updateReviewStatus(
        mockSkillRow.id, 'approve', 'user-001'
      )

      expect(result).toBeNull()
    })
  })

  describe('softDelete', () => {
    it('应软删除技能', async () => {
      mockSql.mockResolvedValueOnce([{ id: mockSkillRow.id }])

      const { softDelete } = await import(
        '../../repositories/evolved-skill.repository'
      )

      const result = await softDelete(mockSkillRow.id, 'user-001')
      expect(result).toBe(true)
    })

    it('已删除的技能返回 false', async () => {
      mockSql.mockResolvedValueOnce([])

      const { softDelete } = await import(
        '../../repositories/evolved-skill.repository'
      )

      const result = await softDelete(uuid(), 'user-001')
      expect(result).toBe(false)
    })
  })

  describe('findByEmbedding', () => {
    it('应返回相似技能列表', async () => {
      const withSimilarity = { ...mockSkillRow, similarity: 0.92 }
      mockSql.mockResolvedValueOnce([withSimilarity])

      const { findByEmbedding } = await import(
        '../../repositories/evolved-skill.repository'
      )

      const results = await findByEmbedding(
        Array(1536).fill(0.1), testOrgId, 5
      )

      expect(results).toHaveLength(1)
      expect(results[0].similarity).toBe(0.92)
    })
  })

  describe('incrementUseCount', () => {
    it('应递增使用计数', async () => {
      mockSql.mockResolvedValueOnce([])

      const { incrementUseCount } = await import(
        '../../repositories/evolved-skill.repository'
      )

      await incrementUseCount(mockSkillRow.id)
      expect(mockSql).toHaveBeenCalledTimes(1)
    })
  })

  describe('incrementSuccessCount', () => {
    it('应递增成功计数', async () => {
      mockSql.mockResolvedValueOnce([])

      const { incrementSuccessCount } = await import(
        '../../repositories/evolved-skill.repository'
      )

      await incrementSuccessCount(mockSkillRow.id)
      expect(mockSql).toHaveBeenCalledTimes(1)
    })
  })

  describe('getStatsByAgent', () => {
    it('应返回进化统计数据', async () => {
      mockSql.mockResolvedValueOnce([{
        total: '15',
        approved: '10',
        rejected: '2',
        pending: '2',
        auto_approved: '1',
        total_reuse: '50',
        avg_quality: '0.78',
      }])

      const { getStatsByAgent } = await import(
        '../../repositories/evolved-skill.repository'
      )

      const result = await getStatsByAgent(testAgentId, testOrgId)
      expect(result.total).toBe(15)
      expect(result.approved).toBe(10)
      expect(result.avgQuality).toBeCloseTo(0.78)
    })
  })

  describe('findByIds', () => {
    it('空数组返回空结果', async () => {
      const { findByIds } = await import(
        '../../repositories/evolved-skill.repository'
      )

      const result = await findByIds([])
      expect(result).toHaveLength(0)
      expect(mockSql).not.toHaveBeenCalled()
    })

    it('应返回批量查询结果', async () => {
      mockSql.mockResolvedValueOnce([mockSkillRow])

      const { findByIds } = await import(
        '../../repositories/evolved-skill.repository'
      )

      const result = await findByIds([mockSkillRow.id])
      expect(result).toHaveLength(1)
    })
  })
})
