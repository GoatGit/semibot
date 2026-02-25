/**
 * Skill Definition Repository
 *
 * 处理 SkillDefinition 的数据库 CRUD 操作
 */

import { sql } from '../lib/db'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/config'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════���═══

export interface SkillDefinitionRow {
  id: string
  skill_id: string
  name: string
  description: string | null
  trigger_keywords: string[]
  is_active: boolean
  is_public: boolean
  created_by: string
  created_at: string
  updated_at: string
}

export interface CreateSkillDefinitionData {
  skillId: string
  name: string
  description?: string
  protocol?: string
  sourceType?: string
  sourceUrl?: string
  triggerKeywords?: string[]
  isActive?: boolean
  isPublic?: boolean
  status?: string
  createdBy?: string
}

export interface UpdateSkillDefinitionData {
  name?: string
  description?: string
  triggerKeywords?: string[]
  isActive?: boolean
  isPublic?: boolean
}

export interface SkillDefinition {
  id: string
  skillId: string
  name: string
  description?: string
  triggerKeywords: string[]
  isActive: boolean
  isPublic: boolean
  createdBy: string
  createdAt: string
  updatedAt: string
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

function rowToSkillDefinition(row: SkillDefinitionRow): SkillDefinition {
  return {
    id: row.id,
    skillId: row.skill_id,
    name: row.name,
    description: row.description || undefined,
    triggerKeywords: row.trigger_keywords,
    isActive: row.is_active,
    isPublic: row.is_public,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ═══════════════════════════════════════════════════════════════
// CRUD 操作
// ═══════════════════════════════════════════════════════════════

/**
 * 创建技能定义
 */
export async function create(data: CreateSkillDefinitionData): Promise<SkillDefinition> {
  const result = await sql<SkillDefinitionRow[]>`
    INSERT INTO skill_definitions (
      skill_id,
      name,
      description,
      trigger_keywords,
      is_active,
      is_public,
      created_by
    ) VALUES (
      ${data.skillId},
      ${data.name},
      ${data.description || null},
      ${data.triggerKeywords || []},
      ${data.isActive ?? true},
      ${data.isPublic ?? false},
      ${data.createdBy || null}
    )
    RETURNING *
  `

  return rowToSkillDefinition(result[0])
}

/**
 * 根据 ID 查找技能定义
 */
export async function findById(id: string): Promise<SkillDefinition | null> {
  const rows = await sql<SkillDefinitionRow[]>`
    SELECT * FROM skill_definitions
    WHERE id = ${id}
    LIMIT 1
  `

  return rows.length > 0 ? rowToSkillDefinition(rows[0]) : null
}

/**
 * 根据 skill_id 查找技能定义
 */
export async function findBySkillId(skillId: string): Promise<SkillDefinition | null> {
  const rows = await sql<SkillDefinitionRow[]>`
    SELECT * FROM skill_definitions
    WHERE skill_id = ${skillId}
    LIMIT 1
  `

  return rows.length > 0 ? rowToSkillDefinition(rows[0]) : null
}

/**
 * 查找所有技能定义（分页）
 */
export async function findAll(options: {
  page?: number
  pageSize?: number
  isActive?: boolean
  isPublic?: boolean
  search?: string
}): Promise<{ data: SkillDefinition[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, options.page || 1)
  const pageSize = Math.min(options.pageSize || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  const offset = (page - 1) * pageSize

  // 使用 postgres.js fragment 构建动态 WHERE 条件
  const conditions = []

  if (options.isActive !== undefined) {
    conditions.push(sql`is_active = ${options.isActive}`)
  }

  if (options.isPublic !== undefined) {
    conditions.push(sql`is_public = ${options.isPublic}`)
  }

  if (options.search) {
    const pattern = `%${options.search}%`
    conditions.push(sql`(name ILIKE ${pattern} OR description ILIKE ${pattern})`)
  }

  const whereClause = conditions.length > 0
    ? sql`WHERE ${conditions.reduce((acc, cond, i) => i === 0 ? cond : sql`${acc} AND ${cond}`)}`
    : sql``

  // 查询总数
  const countResult = await sql<[{ count: string }]>`
    SELECT COUNT(*) as count
    FROM skill_definitions
    ${whereClause}
  `
  const total = parseInt(countResult[0].count, 10)

  // 查询数据
  const rows = await sql<SkillDefinitionRow[]>`
    SELECT * FROM skill_definitions
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT ${pageSize}
    OFFSET ${offset}
  `

  return {
    data: rows.map(rowToSkillDefinition),
    total,
    page,
    pageSize,
  }
}

/**
 * 更新技能定义
 */
export async function update(id: string, data: UpdateSkillDefinitionData): Promise<SkillDefinition | null> {
  const rows = await sql<SkillDefinitionRow[]>`
    SELECT * FROM skill_definitions WHERE id = ${id} LIMIT 1
  `
  if (rows.length === 0) return null

  const current = rows[0]

  const result = await sql<SkillDefinitionRow[]>`
    UPDATE skill_definitions
    SET name = ${data.name ?? current.name},
        description = ${data.description ?? current.description},
        trigger_keywords = ${data.triggerKeywords ?? current.trigger_keywords},
        is_active = ${data.isActive ?? current.is_active},
        is_public = ${data.isPublic ?? current.is_public},
        updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `

  return result.length > 0 ? rowToSkillDefinition(result[0]) : null
}

/**
 * 软删除技能定义（设置 is_active = false）
 * 注：skill_definitions 表使用 is_active 标记而非 deleted_at
 */
export async function softDelete(id: string): Promise<boolean> {
  const result = await sql`
    UPDATE skill_definitions
    SET is_active = false, updated_at = NOW()
    WHERE id = ${id} AND is_active = true
    RETURNING id
  `

  return result.length > 0
}

/**
 * 删除技能定义
 * @deprecated 使用 softDelete 代替，以保留数据审计
 */
export async function remove(id: string): Promise<boolean> {
  const result = await sql`
    DELETE FROM skill_definitions
    WHERE id = ${id}
  `

  return result.count > 0
}

/**
 * 统计技能定义数量
 */
export async function count(options?: { isActive?: boolean; isPublic?: boolean }): Promise<number> {
  const conditions = []

  if (options?.isActive !== undefined) {
    conditions.push(sql`is_active = ${options.isActive}`)
  }

  if (options?.isPublic !== undefined) {
    conditions.push(sql`is_public = ${options.isPublic}`)
  }

  const whereClause = conditions.length > 0
    ? sql`WHERE ${conditions.reduce((acc, cond, i) => i === 0 ? cond : sql`${acc} AND ${cond}`)}`
    : sql``

  const result = await sql<[{ count: string }]>`
    SELECT COUNT(*) as count
    FROM skill_definitions
    ${whereClause}
  `

  return parseInt(result[0].count, 10)
}

/**
 * 检查 skill_id 是否已存在
 */
export async function existsBySkillId(skillId: string): Promise<boolean> {
  const result = await sql<[{ exists: boolean }]>`
    SELECT EXISTS(
      SELECT 1 FROM skill_definitions
      WHERE skill_id = ${skillId}
    ) as exists
  `

  return result[0].exists
}
