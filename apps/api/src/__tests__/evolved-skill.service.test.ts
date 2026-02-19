/**
 * evolved-skill.service 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { v4 as uuid } from 'uuid'

const mockEvolvedSkillRepo = {
  create: vi.fn(),
  findByIdAndOrg: vi.fn(),
  findByOrg: vi.fn(),
  updateReviewStatus: vi.fn(),
  softDelete: vi.fn(),
  updateStatus: vi.fn(),
  incrementUseCount: vi.fn(),
  incrementSuccessCount: vi.fn(),
  updateEmbedding: vi.fn(),
  findByEmbedding: vi.fn(),
  getStatsByAgent: vi.fn(),
  getTopSkills: vi.fn(),
  findLowSuccessRate: vi.fn(),
  findStaleSkills: vi.fn(),
  findByIds: vi.fn(),
}
const mockSqlBegin = vi.fn()
const mockSqlJson = vi.fn((val: unknown) => val)

vi.mock('../repositories/evolved-skill.repository', () => mockEvolvedSkillRepo)
vi.mock('../lib/db', () => ({
  sql: {
    begin: (...args: unknown[]) => mockSqlBegin(...args),
    json: (...args: unknown[]) => mockSqlJson(...args),
  },
}))

vi.mock('../middleware/errorHandler', () => ({
  createError: vi.fn((code: string, msg?: string) => {
    const err = new Error(msg || code) as Error & { code: string }
    err.code = code
    return err
  }),
}))

vi.mock('../constants/errorCodes', () => ({
  EVOLVED_SKILL_NOT_FOUND: 'EVOLVED_SKILL_NOT_FOUND',
  EVOLVED_SKILL_INVALID_STATUS: 'EVOLVED_SKILL_INVALID_STATUS',
  EVOLVED_SKILL_REVIEW_FAILED: 'EVOLVED_SKILL_REVIEW_FAILED',
}))

vi.mock('../lib/logger', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

const testOrgId = uuid()
const testAgentId = uuid()
const testSkillId = uuid()
const testUserId = uuid()

const mockSkillRow = {
  id: testSkillId,
  org_id: testOrgId,
  agent_id: testAgentId,
  name: '查询订单状态',
  description: '根据订单号查询订单当前状态',
  status: 'pending_review',
  use_count: 10,
  success_count: 8,
  version: 1,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  deleted_at: null,
}

describe('evolved-skill.service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    mockSqlBegin.mockImplementation(async (cb: (tx: unknown) => Promise<unknown> | unknown) => {
      const tx = () => [{ id: 'skill-promoted-1', name: 'promoted-skill' }]
      return cb(tx)
    })
  })

  describe('list', () => {
    it('应返回分页技能列表', async () => {
      mockEvolvedSkillRepo.findByOrg.mockResolvedValue({
        data: [mockSkillRow],
        meta: { total: 1, page: 1, limit: 10, totalPages: 1 },
      })

      const { list } = await import('../services/evolved-skill.service')

      const result = await list(testOrgId, { page: 1, limit: 10 })
      expect(result.meta.total).toBe(1)
      expect(result.data).toHaveLength(1)
    })

    it('按状态过滤', async () => {
      mockEvolvedSkillRepo.findByOrg.mockResolvedValue({
        data: [],
        meta: { total: 0, page: 1, limit: 10, totalPages: 0 },
      })

      const { list } = await import('../services/evolved-skill.service')

      await list(testOrgId, { status: 'approved' })
      expect(mockEvolvedSkillRepo.findByOrg).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'approved' })
      )
    })
  })

  describe('getById', () => {
    it('应返回指定技能', async () => {
      mockEvolvedSkillRepo.findByIdAndOrg.mockResolvedValue(mockSkillRow)

      const { getById } = await import('../services/evolved-skill.service')

      const result = await getById(testSkillId, testOrgId)
      expect(result.id).toBe(testSkillId)
    })

    it('技能不存在时抛出 EVOLVED_SKILL_NOT_FOUND', async () => {
      mockEvolvedSkillRepo.findByIdAndOrg.mockResolvedValue(null)

      const { getById } = await import('../services/evolved-skill.service')

      await expect(
        getById(uuid(), testOrgId)
      ).rejects.toMatchObject({ code: 'EVOLVED_SKILL_NOT_FOUND' })
    })
  })

  describe('review', () => {
    it('应审核通过 pending_review 状态的技能', async () => {
      mockEvolvedSkillRepo.findByIdAndOrg.mockResolvedValue(mockSkillRow)
      mockEvolvedSkillRepo.updateReviewStatus.mockResolvedValue({
        ...mockSkillRow,
        status: 'approved',
        version: 2,
      })

      const { review } = await import('../services/evolved-skill.service')

      const result = await review(testSkillId, testOrgId, testUserId, {
        action: 'approve',
        comment: '质量良好',
      })
      expect(result.status).toBe('approved')
    })

    it('应拒绝 pending_review 状态的技能', async () => {
      mockEvolvedSkillRepo.findByIdAndOrg.mockResolvedValue(mockSkillRow)
      mockEvolvedSkillRepo.updateReviewStatus.mockResolvedValue({
        ...mockSkillRow,
        status: 'rejected',
        version: 2,
      })

      const { review } = await import('../services/evolved-skill.service')

      const result = await review(testSkillId, testOrgId, testUserId, {
        action: 'reject',
      })
      expect(result.status).toBe('rejected')
    })

    it('非 pending_review 状态时抛出 EVOLVED_SKILL_INVALID_STATUS', async () => {
      mockEvolvedSkillRepo.findByIdAndOrg.mockResolvedValue({
        ...mockSkillRow,
        status: 'approved',
      })

      const { review } = await import('../services/evolved-skill.service')

      await expect(
        review(testSkillId, testOrgId, testUserId, { action: 'approve' })
      ).rejects.toMatchObject({ code: 'EVOLVED_SKILL_INVALID_STATUS' })
    })

    it('技能不存在时抛出 EVOLVED_SKILL_NOT_FOUND', async () => {
      mockEvolvedSkillRepo.findByIdAndOrg.mockResolvedValue(null)

      const { review } = await import('../services/evolved-skill.service')

      await expect(
        review(uuid(), testOrgId, testUserId, { action: 'approve' })
      ).rejects.toMatchObject({ code: 'EVOLVED_SKILL_NOT_FOUND' })
    })

    it('updateReviewStatus 返回 null 时抛出错误', async () => {
      mockEvolvedSkillRepo.findByIdAndOrg.mockResolvedValue(mockSkillRow)
      mockEvolvedSkillRepo.updateReviewStatus.mockResolvedValue(null)

      const { review } = await import('../services/evolved-skill.service')

      await expect(
        review(testSkillId, testOrgId, testUserId, { action: 'approve' })
      ).rejects.toMatchObject({ code: 'EVOLVED_SKILL_INVALID_STATUS' })
    })
  })

  describe('deprecate', () => {
    it('应软删除技能', async () => {
      mockEvolvedSkillRepo.findByIdAndOrg.mockResolvedValue(mockSkillRow)
      mockEvolvedSkillRepo.softDelete.mockResolvedValue(true)

      const { deprecate } = await import('../services/evolved-skill.service')

      await deprecate(testSkillId, testOrgId, testUserId)
      expect(mockEvolvedSkillRepo.softDelete).toHaveBeenCalledWith(
        testSkillId, testUserId
      )
    })

    it('技能不存在时抛出 EVOLVED_SKILL_NOT_FOUND', async () => {
      mockEvolvedSkillRepo.findByIdAndOrg.mockResolvedValue(null)

      const { deprecate } = await import('../services/evolved-skill.service')

      await expect(
        deprecate(uuid(), testOrgId, testUserId)
      ).rejects.toMatchObject({ code: 'EVOLVED_SKILL_NOT_FOUND' })
    })
  })

  describe('promote', () => {
    it('应提升 approved 状态的技能', async () => {
      mockEvolvedSkillRepo.findByIdAndOrg.mockResolvedValue({
        ...mockSkillRow,
        status: 'approved',
      })

      const { promote } = await import('../services/evolved-skill.service')

      const result = await promote(testSkillId, testOrgId, testUserId)
      expect(result.evolvedSkill.status).toBe('promoted')
      expect(result.skill.id).toBe('skill-promoted-1')
    })

    it('非 approved/auto_approved 状态时抛出错误', async () => {
      mockEvolvedSkillRepo.findByIdAndOrg.mockResolvedValue(mockSkillRow)

      const { promote } = await import('../services/evolved-skill.service')

      await expect(
        promote(testSkillId, testOrgId, testUserId)
      ).rejects.toMatchObject({ code: 'EVOLVED_SKILL_INVALID_STATUS' })
    })
  })

  describe('getStats', () => {
    it('应返回进化统计数据', async () => {
      mockEvolvedSkillRepo.getStatsByAgent.mockResolvedValue({
        total: 15,
        approved: 10,
        rejected: 2,
        pending: 2,
        autoApproved: 1,
        totalReuse: 50,
        avgQuality: 0.78,
      })
      mockEvolvedSkillRepo.getTopSkills.mockResolvedValue([
        { id: 's-1', name: '技能1', use_count: 20, success_count: 18 },
      ])

      const { getStats } = await import('../services/evolved-skill.service')

      const result = await getStats(testAgentId, testOrgId)
      expect(result.totalEvolved).toBe(15)
      expect(result.approvedCount).toBe(10)
      expect(result.topSkills).toHaveLength(1)
      expect(result.topSkills[0].successRate).toBeCloseTo(0.9)
    })

    it('无数据时 approvalRate 为 0', async () => {
      mockEvolvedSkillRepo.getStatsByAgent.mockResolvedValue({
        total: 0,
        approved: 0,
        rejected: 0,
        pending: 0,
        autoApproved: 0,
        totalReuse: 0,
        avgQuality: 0,
      })
      mockEvolvedSkillRepo.getTopSkills.mockResolvedValue([])

      const { getStats } = await import('../services/evolved-skill.service')

      const result = await getStats(testAgentId, testOrgId)
      expect(result.approvalRate).toBe(0)
      expect(result.topSkills).toHaveLength(0)
    })
  })
})
