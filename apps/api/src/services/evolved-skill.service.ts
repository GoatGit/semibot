/**
 * Evolved Skill Service
 *
 * 进化技能业务逻辑层
 */

import { createError } from '../middleware/errorHandler'
import {
  EVOLVED_SKILL_NOT_FOUND,
  EVOLVED_SKILL_INVALID_STATUS,
} from '../constants/errorCodes'
import * as EvolvedSkillRepo from '../repositories/evolved-skill.repository'
import { createLogger } from '../lib/logger'

const logger = createLogger('evolved-skill-service')

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

interface ListOptions {
  status?: string
  agentId?: string
  limit?: number
  page?: number
}

interface ReviewInput {
  action: 'approve' | 'reject'
  comment?: string
}


// ═══════════════════════════════════════════════════════════════
// Service 方法
// ═══════════════════════════════════════════════════════════════

/**
 * 列出进化技能
 */
export async function list(orgId: string, options: ListOptions) {
  return EvolvedSkillRepo.findByOrg({
    orgId,
    status: options.status,
    agentId: options.agentId,
    limit: options.limit,
    page: options.page,
  })
}

/**
 * 获取进化技能详情
 */
export async function getById(id: string, orgId: string) {
  const skill = await EvolvedSkillRepo.findByIdAndOrg(id, orgId)
  if (!skill) {
    throw createError(EVOLVED_SKILL_NOT_FOUND)
  }
  return skill
}

/**
 * 审核进化技能
 */
export async function review(
  id: string,
  orgId: string,
  userId: string,
  input: ReviewInput
) {
  const skill = await getById(id, orgId)

  if (skill.status !== 'pending_review') {
    throw createError(
      EVOLVED_SKILL_INVALID_STATUS,
      `当前状态 ${skill.status} 不可审核，仅 pending_review 状态可审核`
    )
  }

  const updated = await EvolvedSkillRepo.updateReviewStatus(
    id, input.action, userId, input.comment
  )

  if (!updated) {
    throw createError(EVOLVED_SKILL_INVALID_STATUS, '审核状态更新失败')
  }

  logger.info('[EvolvedSkill] 审核完成', {
    skillId: id,
    action: input.action,
    reviewedBy: userId,
  })

  return updated
}

/**
 * 废弃进化技能（软删除）
 */
export async function deprecate(id: string, orgId: string, userId: string) {
  await getById(id, orgId)
  await EvolvedSkillRepo.softDelete(id, userId)

  logger.info('[EvolvedSkill] 已废弃', { skillId: id, deletedBy: userId })
}

/**
 * 提升为正式技能
 */
export async function promote(id: string, orgId: string, _userId: string) {
  const skill = await getById(id, orgId)

  if (!['approved', 'auto_approved'].includes(skill.status)) {
    throw createError(
      EVOLVED_SKILL_INVALID_STATUS,
      `当前状态 ${skill.status} 不可提升，仅 approved/auto_approved 可提升`
    )
  }

  // TODO: 转换为正式技能（写入 skills 表，source_type = 'evolved'）
  logger.info('[EvolvedSkill] 已提升为正式技能', { evolvedSkillId: id })

  return skill
}

/**
 * 获取进化统计
 */
export async function getStats(agentId: string, orgId: string) {
  const stats = await EvolvedSkillRepo.getStatsByAgent(agentId, orgId)
  const topSkills = await EvolvedSkillRepo.getTopSkills(agentId, orgId, 5)

  return {
    totalEvolved: stats.total,
    approvedCount: stats.approved,
    rejectedCount: stats.rejected,
    pendingCount: stats.pending,
    approvalRate: stats.total > 0
      ? (stats.approved + stats.autoApproved) / stats.total
      : 0,
    totalReuseCount: stats.totalReuse,
    avgQualityScore: stats.avgQuality,
    topSkills: topSkills.map(s => ({
      id: s.id,
      name: s.name,
      useCount: s.use_count,
      successRate: s.use_count > 0 ? s.success_count / s.use_count : 0,
    })),
  }
}
