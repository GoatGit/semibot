/**
 * Skill 服务层
 *
 * 使用数据库持久化实现 Skill CRUD
 */

import { createError } from '../middleware/errorHandler'
import { SKILL_NOT_FOUND, SKILL_LIMIT_EXCEEDED, SKILL_BUILTIN_READONLY } from '../constants/errorCodes'
import * as skillRepository from '../repositories/skill.repository'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface Skill {
  id: string
  orgId: string | null
  name: string
  description?: string
  triggerKeywords: string[]
  tools: SkillTool[]
  config: SkillConfig
  isBuiltin: boolean
  isActive: boolean
  createdBy?: string
  createdAt: string
  updatedAt: string
}

export interface SkillTool {
  name: string
  type: 'function' | 'mcp'
  config?: Record<string, unknown>
}

export interface SkillConfig {
  maxExecutionTime?: number
  retryAttempts?: number
  requiresApproval?: boolean
  [key: string]: unknown
}

export interface CreateSkillInput {
  name: string
  description?: string
  triggerKeywords?: string[]
  tools?: SkillTool[]
  config?: SkillConfig
}

export interface UpdateSkillInput {
  name?: string
  description?: string
  triggerKeywords?: string[]
  tools?: SkillTool[]
  config?: SkillConfig
  isActive?: boolean
}

export interface ListSkillsOptions {
  page?: number
  limit?: number
  search?: string
  includeBuiltin?: boolean
}

export interface PaginatedResult<T> {
  data: T[]
  meta: {
    total: number
    page: number
    limit: number
    totalPages: number
  }
}

// ═══════════════════════════════════════════════════════════════
// 常量配置
// ═══════════════════════════════════════════════════════════════

const MAX_SKILLS_PER_ORG = 50

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 将数据库行转换为 Skill 对象
 */
function rowToSkill(row: skillRepository.SkillRow): Skill {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    description: row.description ?? undefined,
    triggerKeywords: row.trigger_keywords ?? [],
    tools: row.tools as SkillTool[],
    config: row.config as SkillConfig,
    isBuiltin: row.is_builtin,
    isActive: row.is_active,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ═══════════════════════════════════════════════════════════════
// 服务方法
// ═══════════════════════════════════════════════════════════════

/**
 * 创建 Skill
 */
export async function createSkill(
  orgId: string,
  userId: string,
  input: CreateSkillInput
): Promise<Skill> {
  // 检查配额
  const existingSkills = await skillRepository.findAll({ orgId, includeBuiltin: false })

  if (existingSkills.meta.total >= MAX_SKILLS_PER_ORG) {
    console.warn(
      `[SkillService] Skill 数量已达上限 - 组织: ${orgId}, 当前: ${existingSkills.meta.total}, 限制: ${MAX_SKILLS_PER_ORG}`
    )
    throw createError(SKILL_LIMIT_EXCEEDED)
  }

  const row = await skillRepository.create({
    orgId,
    name: input.name,
    description: input.description,
    triggerKeywords: input.triggerKeywords,
    tools: input.tools,
    config: input.config,
    isBuiltin: false,
    createdBy: userId,
  })

  return rowToSkill(row)
}

/**
 * 获取 Skill
 */
export async function getSkill(orgId: string, skillId: string): Promise<Skill> {
  const row = await skillRepository.findById(skillId)

  if (!row) {
    throw createError(SKILL_NOT_FOUND)
  }

  // 检查权限：必须是该组织的 Skill 或内置 Skill
  if (row.org_id !== orgId && !row.is_builtin) {
    throw createError(SKILL_NOT_FOUND)
  }

  return rowToSkill(row)
}

/**
 * 列出 Skills
 */
export async function listSkills(
  orgId: string,
  options: ListSkillsOptions = {}
): Promise<PaginatedResult<Skill>> {
  const result = await skillRepository.findAll({
    orgId,
    includeBuiltin: options.includeBuiltin ?? true,
    page: options.page,
    limit: options.limit,
    search: options.search,
  })

  return {
    data: result.data.map(rowToSkill),
    meta: result.meta,
  }
}

/**
 * 更新 Skill
 */
export async function updateSkill(
  orgId: string,
  skillId: string,
  input: UpdateSkillInput
): Promise<Skill> {
  // 先获取现有 Skill
  const existing = await getSkill(orgId, skillId)

  // 内置 Skill 不可修改
  if (existing.isBuiltin) {
    throw createError(SKILL_BUILTIN_READONLY)
  }

  // 确保只能更新自己组织的 Skill
  if (existing.orgId !== orgId) {
    throw createError(SKILL_NOT_FOUND)
  }

  const row = await skillRepository.update(skillId, {
    name: input.name,
    description: input.description,
    triggerKeywords: input.triggerKeywords,
    tools: input.tools,
    config: input.config,
    isActive: input.isActive,
  })

  if (!row) {
    throw createError(SKILL_NOT_FOUND)
  }

  return rowToSkill(row)
}

/**
 * 删除 Skill (软删除)
 */
export async function deleteSkill(orgId: string, skillId: string): Promise<void> {
  // 先检查权限
  const existing = await getSkill(orgId, skillId)

  // 内置 Skill 不可删除
  if (existing.isBuiltin) {
    throw createError(SKILL_BUILTIN_READONLY)
  }

  // 确保只能删除自己组织的 Skill
  if (existing.orgId !== orgId) {
    throw createError(SKILL_NOT_FOUND)
  }

  const deleted = await skillRepository.softDelete(skillId)

  if (!deleted) {
    throw createError(SKILL_NOT_FOUND)
  }
}
