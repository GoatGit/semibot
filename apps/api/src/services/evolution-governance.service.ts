/**
 * Evolution Governance Service
 *
 * 进化系统质量治理：退化检查、自动审批判定、定时清理
 */

import * as EvolvedSkillRepo from '../repositories/evolved-skill.repository'
import { createLogger } from '../lib/logger'

const logger = createLogger('evolution-governance')

// ═══════════════════════════════════════════════════════════════
// 质量退化阈值常量
// ═══════════════════════════════════════════════════════════════

const DEPRECATION_MIN_USE_COUNT = 5
const DEPRECATION_MAX_SUCCESS_RATE = 0.5
const STALE_SKILL_DAYS = 30

// ═══════════════════════════════════════════════════════════════
// Service 方法
// ═══════════════════════════════════════════════════════════════

/**
 * 质量退化检查 — 定时任务调用
 */
export async function checkQualityDegradation(orgId: string): Promise<{
  deprecatedCount: number
  staleCount: number
}> {
  let deprecatedCount = 0
  let staleCount = 0

  // 1. 低成功率自动废弃
  const lowSuccessSkills = await EvolvedSkillRepo.findLowSuccessRate(
    orgId, DEPRECATION_MAX_SUCCESS_RATE, DEPRECATION_MIN_USE_COUNT
  )
  for (const skill of lowSuccessSkills) {
    await EvolvedSkillRepo.updateStatus(skill.id, 'deprecated')
    deprecatedCount++
    logger.warn(
      `[Governance] 技能因低成功率自动废弃`,
      {
        skillId: skill.id,
        skillName: skill.name,
        successRate: skill.use_count > 0 ? skill.success_count / skill.use_count : 0,
        useCount: skill.use_count,
      }
    )
  }

  // 2. 长期未使用标记候选清理
  const staleSkills = await EvolvedSkillRepo.findStaleSkills(orgId, STALE_SKILL_DAYS)
  for (const skill of staleSkills) {
    staleCount++
    logger.info(
      `[Governance] 技能长期未使用，标记为候选清理`,
      {
        skillId: skill.id,
        skillName: skill.name,
        createdAt: skill.created_at,
      }
    )
  }

  return { deprecatedCount, staleCount }
}

/**
 * 自动审批判定 — 在 REGISTER 阶段调用
 */
export function shouldAutoApprove(
  qualityScore: number,
  evolutionConfig: { autoApprove?: boolean }
): boolean {
  return qualityScore >= 0.8 && (evolutionConfig.autoApprove ?? false)
}
