/**
 * evolved-skill.service promote() 单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock 依赖模块
const mockFindByIdAndOrg = vi.fn()
const mockUpdateStatus = vi.fn()
const mockExistsBySkillId = vi.fn()
const mockCreateSkillDefinition = vi.fn()

vi.mock('../repositories/evolved-skill.repository', () => ({
  findByIdAndOrg: (...args: unknown[]) => mockFindByIdAndOrg(...args),
  updateStatus: (...args: unknown[]) => mockUpdateStatus(...args),
}))

vi.mock('../repositories/skill-definition.repository', () => ({
  existsBySkillId: (...args: unknown[]) => mockExistsBySkillId(...args),
  create: (...args: unknown[]) => mockCreateSkillDefinition(...args),
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import { promote } from '../services/evolved-skill.service'
import { EVOLVED_SKILL_NOT_FOUND, EVOLVED_SKILL_INVALID_STATUS } from '../constants/errorCodes'

// ═══════════════════════════════════════════════════════════════
// 测试数据
// ═══════════════════════════════════════════════════════════════

function makeEvolvedSkill(overrides: Record<string, unknown> = {}) {
  return {
    id: 'es-001',
    org_id: 'org-001',
    agent_id: 'agent-001',
    name: '测试技能',
    description: '一个测试技能',
    trigger_keywords: ['test'],
    tools_used: ['tool-a'],
    parameters: { key: 'value' },
    preconditions: { env: 'prod' },
    expected_outcome: '成功执行',
    quality_score: 0.9,
    status: 'approved',
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════════
// 测试用例
// ═══════════════════════════════════════════════════════════════

describe('evolved-skill.service.promote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsBySkillId.mockResolvedValue(false)
  })

  it('should throw EVOLVED_SKILL_NOT_FOUND when skill does not exist', async () => {
    mockFindByIdAndOrg.mockResolvedValue(null)

    await expect(promote('es-999', 'user-001'))
      .rejects.toMatchObject({ code: EVOLVED_SKILL_NOT_FOUND })
  })

  it('should throw EVOLVED_SKILL_INVALID_STATUS when status is pending_review', async () => {
    mockFindByIdAndOrg.mockResolvedValue(makeEvolvedSkill({ status: 'pending_review' }))

    await expect(promote('es-001', 'user-001'))
      .rejects.toMatchObject({ code: EVOLVED_SKILL_INVALID_STATUS })
  })

  it('should throw EVOLVED_SKILL_INVALID_STATUS when status is rejected', async () => {
    mockFindByIdAndOrg.mockResolvedValue(makeEvolvedSkill({ status: 'rejected' }))

    await expect(promote('es-001', 'user-001'))
      .rejects.toMatchObject({ code: EVOLVED_SKILL_INVALID_STATUS })
  })

  it('should promote approved skill via transaction', async () => {
    const evolvedSkill = makeEvolvedSkill({ status: 'approved' })
    mockFindByIdAndOrg.mockResolvedValue(evolvedSkill)

    const newSkill = { id: 'skill-001', name: '测试技能' }
    mockCreateSkillDefinition.mockResolvedValue(newSkill)
    mockUpdateStatus.mockResolvedValue(true)

    const result = await promote('es-001', 'user-001')

    expect(result.skill).toEqual(newSkill)
    expect(result.evolvedSkill.status).toBe('promoted')
    expect(mockCreateSkillDefinition).toHaveBeenCalledOnce()
    expect(mockUpdateStatus).toHaveBeenCalledWith('es-001', 'promoted')
  })

  it('should promote auto_approved skill', async () => {
    const evolvedSkill = makeEvolvedSkill({ status: 'auto_approved' })
    mockFindByIdAndOrg.mockResolvedValue(evolvedSkill)

    const newSkill = { id: 'skill-002', name: '自动审批技能' }
    mockCreateSkillDefinition.mockResolvedValue(newSkill)
    mockUpdateStatus.mockResolvedValue(true)

    const result = await promote('es-001', 'user-001')

    expect(result.skill).toEqual(newSkill)
    expect(result.evolvedSkill.status).toBe('promoted')
  })

  it('should query evolved skill by id only', async () => {
    mockFindByIdAndOrg.mockResolvedValue(null)

    await expect(promote('es-001', 'user-001')).rejects.toThrow()

    expect(mockFindByIdAndOrg).toHaveBeenCalledWith('es-001')
  })
})
