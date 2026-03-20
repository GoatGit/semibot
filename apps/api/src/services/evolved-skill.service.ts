/**
 * Evolved Skill Service
 *
 * 进化技能业务逻辑层
 */

import { createError } from '../middleware/errorHandler'
import {
  EVOLVED_SKILL_NOT_FOUND,
  EVOLVED_SKILL_INVALID_STATUS,
  RESOURCE_CONFLICT,
} from '../constants/errorCodes'
import * as EvolvedSkillRepo from '../repositories/evolved-skill.repository'
import * as skillDefinitionRepo from '../repositories/skill-definition.repository'
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
export async function list(options: ListOptions) {
  return EvolvedSkillRepo.findByOrg({
    status: options.status,
    agentId: options.agentId,
    limit: options.limit,
    page: options.page,
  })
}

/**
 * 获取进化技能详情
 */
export async function getById(id: string) {
  const skill = await EvolvedSkillRepo.findByIdAndOrg(id)
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
  userId: string,
  input: ReviewInput
) {
  const skill = await getById(id)

  if (skill.status !== 'pending_review') {
    throw createError(
      EVOLVED_SKILL_INVALID_STATUS,
      `当前状态 ${skill.status} 不可审核，仅 pending_review 状态可审核`
    )
  }

  const updated = await EvolvedSkillRepo.update(
    id, {
      status: input.action === 'approve' ? 'approved' : 'rejected',
      reviewedBy: userId,
      reviewedAt: new Date().toISOString(),
      reviewComment: input.comment,
    }
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
export async function deprecate(id: string, userId: string) {
  await getById(id)
  await EvolvedSkillRepo.softDelete(id, userId)

  logger.info('[EvolvedSkill] 已废弃', { skillId: id, deletedBy: userId })
}

/**
 * 提升为正式技能
 */
export async function promote(id: string, userId: string) {
  const evolvedSkill = await getById(id)

  if (!['approved', 'auto_approved'].includes(evolvedSkill.status)) {
    throw createError(
      EVOLVED_SKILL_INVALID_STATUS,
      `当前状态 ${evolvedSkill.status} 不可提升，仅 approved/auto_approved 可提升`
    )
  }

  // 1. 检查 skillId 是否已存在
  const existing = await skillDefinitionRepo.existsBySkillId(evolvedSkill.id)
  if (existing) {
    logger.warn('[EvolvedSkill] 提升失败：skillId 已存在', {
      evolvedSkillId: id,
      skillId: evolvedSkill.id,
    })
    throw createError(
      RESOURCE_CONFLICT,
      '该技能 ID 已存在正式技能定义，无法重复提升'
    )
  }

  // 2. 创建正式技能定义
  const newSkillDef = await skillDefinitionRepo.create({
    skillId: evolvedSkill.id,
    name: evolvedSkill.name,
    description: evolvedSkill.description,
    triggerKeywords: evolvedSkill.trigger_keywords ?? [],
    isActive: true,
    createdBy: userId,
  })

  // 3. 更新进化技能状态为 promoted
  await EvolvedSkillRepo.updateStatus(id, 'promoted')

  logger.info('[EvolvedSkill] 已提升为正式技能', {
    evolvedSkillId: id,
    newSkillId: newSkillDef.id,
    name: evolvedSkill.name,
    promotedBy: userId,
  })

  return { evolvedSkill: { ...evolvedSkill, status: 'promoted' }, skill: newSkillDef }
}

/**
 * 获取进化统计
 */
export async function getStats(agentId: string) {
  const stats = await EvolvedSkillRepo.getStatsByAgent(agentId)
  const topSkills = await EvolvedSkillRepo.getTopSkills(agentId, 5)

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
