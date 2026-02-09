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
  current_version: string | null
  is_active: boolean
  is_public: boolean
  metadata: Record<string, unknown>
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
  metadata?: Record<string, unknown>
  createdBy?: string
}

export interface UpdateSkillDefinitionData {
  name?: string
  description?: string
  triggerKeywords?: string[]
  currentVersion?: string
  isActive?: boolean
  isPublic?: boolean
  metadata?: Record<string, unknown>
}

export interface SkillDefinition {
  id: string
  skillId: string
  name: string
  description?: string
  triggerKeywords: string[]
  currentVersion?: string
  isActive: boolean
  isPublic: boolean
  metadata: Record<string, unknown>
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
    currentVersion: row.current_version || undefined,
    isActive: row.is_active,
    isPublic: row.is_public,
    metadata: row.metadata,
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
      metadata,
      created_by
    ) VALUES (
      ${data.skillId},
      ${data.name},
      ${data.description || null},
      ${data.triggerKeywords || []},
      ${data.isActive ?? true},
      ${data.isPublic ?? false},
      ${JSON.stringify(data.metadata || {})},
      ${data.createdBy || 'system'}
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

  // 构建查询条件
  const conditions: string[] = []
  const params: any[] = []

  if (options.isActive !== undefined) {
    conditions.push(`is_active = $${params.length + 1}`)
    params.push(options.isActive)
  }

  if (options.isPublic !== undefined) {
    conditions.push(`is_public = $${params.length + 1}`)
    params.push(options.isPublic)
  }

  if (options.search) {
    conditions.push(`(name ILIKE $${params.length + 1} OR description ILIKE $${params.length + 1})`)
    params.push(`%${options.search}%`)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  // 查询总数
  const countResult = await sql<[{ count: string }]>`
    SELECT COUNT(*) as count
    FROM skill_definitions
    ${sql.unsafe(whereClause)}
  `
  const total = parseInt(countResult[0].count, 10)

  // 查询数据
  const rows = await sql<SkillDefinitionRow[]>`
    SELECT * FROM skill_definitions
    ${sql.unsafe(whereClause)}
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
export async function update(id: string, data: UpdateSkillDefinitionData): Promise<SkillDefinition> {
  const updates: string[] = []
  const params: any[] = []
  let paramIndex = 1

  if (data.name !== undefined) {
    updates.push(`name = $${paramIndex++}`)
    params.push(data.name)
  }

  if (data.description !== undefined) {
    updates.push(`description = $${paramIndex++}`)
    params.push(data.description)
  }

  if (data.triggerKeywords !== undefined) {
    updates.push(`trigger_keywords = $${paramIndex++}`)
    params.push(data.triggerKeywords)
  }

  if (data.currentVersion !== undefined) {
    updates.push(`current_version = $${paramIndex++}`)
    params.push(data.currentVersion)
  }

  if (data.isActive !== undefined) {
    updates.push(`is_active = $${paramIndex++}`)
    params.push(data.isActive)
  }

  if (data.isPublic !== undefined) {
    updates.push(`is_public = $${paramIndex++}`)
    params.push(data.isPublic)
  }

  if (data.metadata !== undefined) {
    updates.push(`metadata = $${paramIndex++}`)
    params.push(JSON.stringify(data.metadata))
  }

  updates.push(`updated_at = NOW()`)
  params.push(id)

  const rows = await sql<SkillDefinitionRow[]>`
    UPDATE skill_definitions
    SET ${sql.unsafe(updates.join(', '))}
    WHERE id = $${paramIndex}
    RETURNING *
  `

  return rowToSkillDefinition(rows[0])
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
  const conditions: string[] = []

  if (options?.isActive !== undefined) {
    conditions.push(`is_active = ${options.isActive}`)
  }

  if (options?.isPublic !== undefined) {
    conditions.push(`is_public = ${options.isPublic}`)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const result = await sql<[{ count: string }]>`
    SELECT COUNT(*) as count
    FROM skill_definitions
    ${sql.unsafe(whereClause)}
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
