/**
 * evolved-skill.service promote() 单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock 依赖模块
const mockFindByIdAndOrg = vi.fn()
const mockSqlBegin = vi.fn()
const mockSqlJson = vi.fn((val: unknown) => val)

vi.mock('../repositories/evolved-skill.repository', () => ({
  findByIdAndOrg: (...args: unknown[]) => mockFindByIdAndOrg(...args),
}))

vi.mock('../lib/db', () => ({
  sql: {
    begin: (...args: unknown[]) => mockSqlBegin(...args),
    json: (...args: unknown[]) => mockSqlJson(...args),
  },
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
  })

  it('should throw EVOLVED_SKILL_NOT_FOUND when skill does not exist', async () => {
    mockFindByIdAndOrg.mockResolvedValue(null)

    await expect(promote('es-999', 'org-001', 'user-001'))
      .rejects.toMatchObject({ code: EVOLVED_SKILL_NOT_FOUND })
  })

  it('should throw EVOLVED_SKILL_INVALID_STATUS when status is pending_review', async () => {
    mockFindByIdAndOrg.mockResolvedValue(makeEvolvedSkill({ status: 'pending_review' }))

    await expect(promote('es-001', 'org-001', 'user-001'))
      .rejects.toMatchObject({ code: EVOLVED_SKILL_INVALID_STATUS })
  })

  it('should throw EVOLVED_SKILL_INVALID_STATUS when status is rejected', async () => {
    mockFindByIdAndOrg.mockResolvedValue(makeEvolvedSkill({ status: 'rejected' }))

    await expect(promote('es-001', 'org-001', 'user-001'))
      .rejects.toMatchObject({ code: EVOLVED_SKILL_INVALID_STATUS })
  })

  it('should promote approved skill via transaction', async () => {
    const evolvedSkill = makeEvolvedSkill({ status: 'approved' })
    mockFindByIdAndOrg.mockResolvedValue(evolvedSkill)

    const newSkill = { id: 'skill-001', name: '测试技能' }
    // sql.begin receives a callback; we invoke it with a mock tx
    mockSqlBegin.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      const mockTx = Object.assign(
        // tagged template function
        () => [newSkill],
        { json: (v: unknown) => v },
      )
      return cb(mockTx)
    })

    const result = await promote('es-001', 'org-001', 'user-001')

    expect(result.skill).toEqual(newSkill)
    expect(result.evolvedSkill.status).toBe('promoted')
    expect(mockSqlBegin).toHaveBeenCalledOnce()
  })

  it('should promote auto_approved skill', async () => {
    const evolvedSkill = makeEvolvedSkill({ status: 'auto_approved' })
    mockFindByIdAndOrg.mockResolvedValue(evolvedSkill)

    const newSkill = { id: 'skill-002', name: '自动审批技能' }
    mockSqlBegin.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      const mockTx = Object.assign(
        () => [newSkill],
        { json: (v: unknown) => v },
      )
      return cb(mockTx)
    })

    const result = await promote('es-001', 'org-001', 'user-001')

    expect(result.skill).toEqual(newSkill)
    expect(result.evolvedSkill.status).toBe('promoted')
  })

  it('should pass correct orgId to findByIdAndOrg', async () => {
    mockFindByIdAndOrg.mockResolvedValue(null)

    await expect(promote('es-001', 'org-xyz', 'user-001')).rejects.toThrow()

    expect(mockFindByIdAndOrg).toHaveBeenCalledWith('es-001', 'org-xyz')
  })
})
