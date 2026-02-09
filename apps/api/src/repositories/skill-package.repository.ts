/**
 * Skill Package Repository
 *
 * 处理 SkillPackage 的数据库 CRUD 操作
 */

import { sql } from '../lib/db'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/config'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export type SkillPackageStatus = 'pending' | 'downloading' | 'validating' | 'installing' | 'active' | 'deprecated' | 'failed'
export type SkillPackageSourceType = 'anthropic' | 'codex' | 'local'

export interface SkillPackageRow {
  id: string
  skill_definition_id: string
  version: string
  source_type: SkillPackageSourceType
  source_url: string | null
  package_path: string
  package_size_bytes: number
  checksum_sha256: string
  status: SkillPackageStatus
  validation_result: Record<string, unknown>
  tools: Record<string, unknown>[]
  config: Record<string, unknown>
  installed_at: string | null
  created_at: string
  updated_at: string
}

export interface CreateSkillPackageData {
  skillDefinitionId: string
  version: string
  sourceType: SkillPackageSourceType
  sourceUrl?: string
  packagePath: string
  packageSizeBytes?: number
  checksumSha256: string
  status?: SkillPackageStatus
  validationResult?: Record<string, unknown>
  tools?: Record<string, unknown>[]
  config?: Record<string, unknown>
}

export interface UpdateSkillPackageData {
  status?: SkillPackageStatus
  packageSizeBytes?: number
  checksumSha256?: string
  validationResult?: Record<string, unknown>
  tools?: Record<string, unknown>[]
  config?: Record<string, unknown>
  installedAt?: Date
}

export interface SkillPackage {
  id: string
  skillDefinitionId: string
  version: string
  sourceType: SkillPackageSourceType
  sourceUrl?: string
  packagePath: string
  packageSizeBytes: number
  checksumSha256: string
  status: SkillPackageStatus
  validationResult: Record<string, unknown>
  tools: Record<string, unknown>[]
  config: Record<string, unknown>
  installedAt?: string
  createdAt: string
  updatedAt: string
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

function rowToSkillPackage(row: SkillPackageRow): SkillPackage {
  return {
    id: row.id,
    skillDefinitionId: row.skill_definition_id,
    version: row.version,
    sourceType: row.source_type,
    sourceUrl: row.source_url || undefined,
    packagePath: row.package_path,
    packageSizeBytes: row.package_size_bytes,
    checksumSha256: row.checksum_sha256,
    status: row.status,
    validationResult: row.validation_result,
    tools: row.tools,
    config: row.config,
    installedAt: row.installed_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ═══════════════════════════════════════════════════════════════
// CRUD 操作
// ═══════════════════════════════════════════════════════════════

/**
 * 创建技能包
 */
export async function create(data: CreateSkillPackageData): Promise<SkillPackage> {
  const rows = await sql<SkillPackageRow[]>`
    INSERT INTO skill_packages (
      skill_definition_id,
      version,
      source_type,
      source_url,
      package_path,
      package_size_bytes,
      checksum_sha256,
      status,
      validation_result,
      tools,
      config
    ) VALUES (
      ${data.skillDefinitionId},
      ${data.version},
      ${data.sourceType},
      ${data.sourceUrl || null},
      ${data.packagePath},
      ${data.packageSizeBytes || 0},
      ${data.checksumSha256},
      ${data.status || 'pending'},
      ${JSON.stringify(data.validationResult || {})},
      ${JSON.stringify(data.tools || [])},
      ${JSON.stringify(data.config || {})}
    )
    RETURNING *
  `

  return rowToSkillPackage(rows[0])
}

/**
 * 根据 ID 查找技能包
 */
export async function findById(id: string): Promise<SkillPackage | null> {
  const rows = await sql<SkillPackageRow[]>`
    SELECT * FROM skill_packages
    WHERE id = ${id}
    LIMIT 1
  `

  return rows.length > 0 ? rowToSkillPackage(rows[0]) : null
}

/**
 * 根据技能定义 ID 和版本查找技能包
 */
export async function findByDefinitionAndVersion(
  skillDefinitionId: string,
  version: string
): Promise<SkillPackage | null> {
  const rows = await sql<SkillPackageRow[]>`
    SELECT * FROM skill_packages
    WHERE skill_definition_id = ${skillDefinitionId}
    AND version = ${version}
    LIMIT 1
  `

  return rows.length > 0 ? rowToSkillPackage(rows[0]) : null
}

/**
 * 查找技能定义的所有包
 */
export async function findAllByDefinition(skillDefinitionId: string): Promise<SkillPackage[]> {
  const rows = await sql<SkillPackageRow[]>`
    SELECT * FROM skill_packages
    WHERE skill_definition_id = ${skillDefinitionId}
    ORDER BY created_at DESC
  `

  return rows.map(rowToSkillPackage)
}

/**
 * 查找技能定义的所有 active 包
 */
export async function findActiveByDefinition(skillDefinitionId: string): Promise<SkillPackage[]> {
  const rows = await sql<SkillPackageRow[]>`
    SELECT * FROM skill_packages
    WHERE skill_definition_id = ${skillDefinitionId}
    AND status = 'active'
    ORDER BY created_at DESC
  `

  return rows.map(rowToSkillPackage)
}

/**
 * 查找所有技能包（分页）
 */
export async function findAll(options: {
  page?: number
  pageSize?: number
  status?: SkillPackageStatus
  sourceType?: SkillPackageSourceType
}): Promise<{ data: SkillPackage[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, options.page || 1)
  const pageSize = Math.min(options.pageSize || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  const offset = (page - 1) * pageSize

  // 构建查询条件
  const conditions: string[] = []

  if (options.status) {
    conditions.push(`status = '${options.status}'`)
  }

  if (options.sourceType) {
    conditions.push(`source_type = '${options.sourceType}'`)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  // 查询总数
  const countResult = await sql<[{ count: string }]>`
    SELECT COUNT(*) as count
    FROM skill_packages
    ${sql.unsafe(whereClause)}
  `
  const total = parseInt(countResult[0].count, 10)

  // 查询数据
  const rows = await sql<SkillPackageRow[]>`
    SELECT * FROM skill_packages
    ${sql.unsafe(whereClause)}
    ORDER BY created_at DESC
    LIMIT ${pageSize}
    OFFSET ${offset}
  `

  return {
    data: rows.map(rowToSkillPackage),
    total,
    page,
    pageSize,
  }
}

/**
 * 更新技能包
 */
export async function update(id: string, data: UpdateSkillPackageData): Promise<SkillPackage> {
  const updates: string[] = []
  const params: any[] = []
  let paramIndex = 1

  if (data.status !== undefined) {
    updates.push(`status = $${paramIndex++}`)
    params.push(data.status)
  }

  if (data.packageSizeBytes !== undefined) {
    updates.push(`package_size_bytes = $${paramIndex++}`)
    params.push(data.packageSizeBytes)
  }

  if (data.checksumSha256 !== undefined) {
    updates.push(`checksum_sha256 = $${paramIndex++}`)
    params.push(data.checksumSha256)
  }

  if (data.validationResult !== undefined) {
    updates.push(`validation_result = $${paramIndex++}`)
    params.push(JSON.stringify(data.validationResult))
  }

  if (data.tools !== undefined) {
    updates.push(`tools = $${paramIndex++}`)
    params.push(JSON.stringify(data.tools))
  }

  if (data.config !== undefined) {
    updates.push(`config = $${paramIndex++}`)
    params.push(JSON.stringify(data.config))
  }

  if (data.installedAt !== undefined) {
    updates.push(`installed_at = $${paramIndex++}`)
    params.push(data.installedAt)
  }

  updates.push(`updated_at = NOW()`)
  params.push(id)

  const rows = await sql<SkillPackageRow[]>`
    UPDATE skill_packages
    SET ${sql.unsafe(updates.join(', '))}
    WHERE id = $${paramIndex}
    RETURNING *
  `

  return rowToSkillPackage(rows[0])
}

/**
 * 软删除技能包（设置 status = 'deprecated'）
 * 注：skill_packages 表使用 status 标记而非 deleted_at
 */
export async function softDelete(id: string, reason?: string): Promise<boolean> {
  const result = await sql`
    UPDATE skill_packages
    SET status = 'deprecated',
        deprecated_at = NOW(),
        deprecated_reason = ${reason ?? null},
        updated_at = NOW()
    WHERE id = ${id} AND status != 'deprecated'
    RETURNING id
  `

  return result.length > 0
}

/**
 * 删除技能包
 * @deprecated 使用 softDelete 代替，以保留数据审计
 */
export async function remove(id: string): Promise<boolean> {
  const result = await sql`
    DELETE FROM skill_packages
    WHERE id = ${id}
  `

  return result.count > 0
}

/**
 * 统计技能包数量
 */
export async function count(options?: {
  skillDefinitionId?: string
  status?: SkillPackageStatus
}): Promise<number> {
  const conditions: string[] = []

  if (options?.skillDefinitionId) {
    conditions.push(`skill_definition_id = '${options.skillDefinitionId}'`)
  }

  if (options?.status) {
    conditions.push(`status = '${options.status}'`)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const result = await sql<[{ count: string }]>`
    SELECT COUNT(*) as count
    FROM skill_packages
    ${sql.unsafe(whereClause)}
  `

  return parseInt(result[0].count, 10)
}

/**
 * 检查版本是否已存在
 */
export async function existsByDefinitionAndVersion(
  skillDefinitionId: string,
  version: string
): Promise<boolean> {
  const result = await sql<[{ exists: boolean }]>`
    SELECT EXISTS(
      SELECT 1 FROM skill_packages
      WHERE skill_definition_id = ${skillDefinitionId}
      AND version = ${version}
    ) as exists
  `

  return result[0].exists
}

/**
 * 获取最新版本
 */
export async function getLatestVersion(skillDefinitionId: string): Promise<SkillPackage | null> {
  const rows = await sql<SkillPackageRow[]>`
    SELECT * FROM skill_packages
    WHERE skill_definition_id = ${skillDefinitionId}
    AND status = 'active'
    ORDER BY created_at DESC
    LIMIT 1
  `

  return rows.length > 0 ? rowToSkillPackage(rows[0]) : null
}
