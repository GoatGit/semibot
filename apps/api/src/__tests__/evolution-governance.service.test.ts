/**
 * evolution-governance.service 单元测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { v4 as uuid } from 'uuid'

const mockEvolvedSkillRepo = {
  findLowSuccessRate: vi.fn(),
  findStaleSkills: vi.fn(),
  updateStatus: vi.fn(),
}

vi.mock('../repositories/evolved-skill.repository', () => mockEvolvedSkillRepo)

vi.mock('../lib/logger', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

const testOrgId = uuid()

const makeSkill = (overrides = {}) => ({
  id: uuid(),
  org_id: testOrgId,
  name: '测试技能',
  description: '测试描述',
  status: 'approved',
  use_count: 10,
  success_count: 8,
  version: 1,
  ...overrides,
})

describe('evolution-governance.service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  describe('checkQualityDegradation', () => {
    it('应废弃低成功率技能', async () => {
      const lowQuality = makeSkill({ use_count: 10, success_count: 2 })
      mockEvolvedSkillRepo.findLowSuccessRate.mockResolvedValue([lowQuality])
      mockEvolvedSkillRepo.findStaleSkills.mockResolvedValue([])
      mockEvolvedSkillRepo.updateStatus.mockResolvedValue(true)

      const { checkQualityDegradation } = await import(
        '../services/evolution-governance.service'
      )

      const result = await checkQualityDegradation(testOrgId)
      expect(result.deprecatedCount).toBe(1)
      expect(mockEvolvedSkillRepo.updateStatus).toHaveBeenCalledWith(
        lowQuality.id, 'deprecated'
      )
    })

    it('应统计长期未使用技能', async () => {
      const staleSkill = makeSkill({ use_count: 0 })
      mockEvolvedSkillRepo.findLowSuccessRate.mockResolvedValue([])
      mockEvolvedSkillRepo.findStaleSkills.mockResolvedValue([staleSkill])

      const { checkQualityDegradation } = await import(
        '../services/evolution-governance.service'
      )

      const result = await checkQualityDegradation(testOrgId)
      expect(result.staleCount).toBe(1)
      expect(result.deprecatedCount).toBe(0)
    })

    it('无问题技能时返回 0', async () => {
      mockEvolvedSkillRepo.findLowSuccessRate.mockResolvedValue([])
      mockEvolvedSkillRepo.findStaleSkills.mockResolvedValue([])

      const { checkQualityDegradation } = await import(
        '../services/evolution-governance.service'
      )

      const result = await checkQualityDegradation(testOrgId)
      expect(result.deprecatedCount).toBe(0)
      expect(result.staleCount).toBe(0)
    })

    it('多个低质量技能全部废弃', async () => {
      const skills = [
        makeSkill({ use_count: 10, success_count: 1 }),
        makeSkill({ use_count: 20, success_count: 3 }),
      ]
      mockEvolvedSkillRepo.findLowSuccessRate.mockResolvedValue(skills)
      mockEvolvedSkillRepo.findStaleSkills.mockResolvedValue([])
      mockEvolvedSkillRepo.updateStatus.mockResolvedValue(true)

      const { checkQualityDegradation } = await import(
        '../services/evolution-governance.service'
      )

      const result = await checkQualityDegradation(testOrgId)
      expect(result.deprecatedCount).toBe(2)
      expect(mockEvolvedSkillRepo.updateStatus).toHaveBeenCalledTimes(2)
    })
  })

  describe('shouldAutoApprove', () => {
    it('高质量 + autoApprove 启用时返回 true', async () => {
      const { shouldAutoApprove } = await import(
        '../services/evolution-governance.service'
      )

      const result = shouldAutoApprove(0.85, { autoApprove: true })
      expect(result).toBe(true)
    })

    it('质量不足时返回 false', async () => {
      const { shouldAutoApprove } = await import(
        '../services/evolution-governance.service'
      )

      const result = shouldAutoApprove(0.7, { autoApprove: true })
      expect(result).toBe(false)
    })

    it('autoApprove 未启用时返回 false', async () => {
      const { shouldAutoApprove } = await import(
        '../services/evolution-governance.service'
      )

      const result = shouldAutoApprove(0.9, { autoApprove: false })
      expect(result).toBe(false)
    })

    it('autoApprove 未配置时返回 false', async () => {
      const { shouldAutoApprove } = await import(
        '../services/evolution-governance.service'
      )

      const result = shouldAutoApprove(0.9, {})
      expect(result).toBe(false)
    })

    it('边界值 0.8 应返回 true', async () => {
      const { shouldAutoApprove } = await import(
        '../services/evolution-governance.service'
      )

      const result = shouldAutoApprove(0.8, { autoApprove: true })
      expect(result).toBe(true)
    })
  })
})
