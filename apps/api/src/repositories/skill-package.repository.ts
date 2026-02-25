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
export type SkillPackageSourceType = 'anthropic' | 'codex' | 'local' | 'upload'

export interface SkillPackageRow {
  id: string
  skill_definition_id: string
  source_type: SkillPackageSourceType
  source_url: string | null
  package_path: string
  file_size_bytes: number
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
    sourceType: row.source_type,
    sourceUrl: row.source_url || undefined,
    packagePath: row.package_path,
    packageSizeBytes: row.file_size_bytes,
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
 * 创建或覆盖技能包（upsert）
 * 一个 skill_definition 只保留一个 package，重复安装时覆盖
 */
export async function create(data: CreateSkillPackageData): Promise<SkillPackage> {
  const rows = await sql<SkillPackageRow[]>`
    INSERT INTO skill_packages (
      skill_definition_id,
      source_type,
      source_url,
      package_path,
      file_size_bytes,
      checksum_sha256,
      status,
      validation_result,
      tools,
      config
    ) VALUES (
      ${data.skillDefinitionId},
      ${data.sourceType},
      ${data.sourceUrl || null},
      ${data.packagePath},
      ${data.packageSizeBytes || 0},
      ${data.checksumSha256},
      ${data.status || 'pending'},
      ${sql.json((data.validationResult || {}) as Parameters<typeof sql.json>[0])},
      ${sql.json((data.tools || []) as Parameters<typeof sql.json>[0])},
      ${sql.json((data.config || {}) as Parameters<typeof sql.json>[0])}
    )
    ON CONFLICT (skill_definition_id) DO UPDATE SET
      source_type = EXCLUDED.source_type,
      source_url = EXCLUDED.source_url,
      package_path = EXCLUDED.package_path,
      file_size_bytes = EXCLUDED.file_size_bytes,
      checksum_sha256 = EXCLUDED.checksum_sha256,
      status = EXCLUDED.status,
      validation_result = EXCLUDED.validation_result,
      tools = EXCLUDED.tools,
      config = EXCLUDED.config,
      updated_at = NOW()
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
 * 根据技能定义 ID 查找唯一的技能包（无版本控制，一个 definition 只有一个 package）
 */
export async function findByDefinition(skillDefinitionId: string): Promise<SkillPackage | null> {
  const rows = await sql<SkillPackageRow[]>`
    SELECT * FROM skill_packages
    WHERE skill_definition_id = ${skillDefinitionId}
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

  // 构建查询条件（使用 sql fragment 防止 SQL 注入）
  const conditions = []

  if (options.status) {
    conditions.push(sql`status = ${options.status}`)
  }

  if (options.sourceType) {
    conditions.push(sql`source_type = ${options.sourceType}`)
  }

  const whereClause = conditions.length > 0
    ? sql`WHERE ${conditions.reduce((acc, cond, i) => i === 0 ? cond : sql`${acc} AND ${cond}`)}`
    : sql``

  // 查询总数
  const countResult = await sql<[{ count: string }]>`
    SELECT COUNT(*) as count
    FROM skill_packages
    ${whereClause}
  `
  const total = parseInt(countResult[0].count, 10)

  // 查询数据
  const rows = await sql<SkillPackageRow[]>`
    SELECT * FROM skill_packages
    ${whereClause}
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
  const existing = await findById(id)
  if (!existing) {
    throw new Error(`SkillPackage not found: ${id}`)
  }

  const rows = await sql<SkillPackageRow[]>`
    UPDATE skill_packages
    SET status = ${data.status ?? existing.status},
        file_size_bytes = ${data.packageSizeBytes ?? existing.packageSizeBytes},
        checksum_sha256 = ${data.checksumSha256 ?? existing.checksumSha256},
        validation_result = ${sql.json((data.validationResult ?? existing.validationResult) as Parameters<typeof sql.json>[0])},
        tools = ${sql.json((data.tools ?? existing.tools) as Parameters<typeof sql.json>[0])},
        config = ${sql.json((data.config ?? existing.config) as Parameters<typeof sql.json>[0])},
        installed_at = ${data.installedAt ?? existing.installedAt ?? null},
        updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `

  return rowToSkillPackage(rows[0])
}

/**
 * 软删除技能包（设置 status = 'deprecated'）
 * 注：skill_packages 表使用 status 标记而非 deleted_at
 */
export async function softDelete(id: string): Promise<boolean> {
  const result = await sql`
    UPDATE skill_packages
    SET status = 'deprecated',
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
  const conditions = []

  if (options?.skillDefinitionId) {
    conditions.push(sql`skill_definition_id = ${options.skillDefinitionId}`)
  }

  if (options?.status) {
    conditions.push(sql`status = ${options.status}`)
  }

  const whereClause = conditions.length > 0
    ? sql`WHERE ${conditions.reduce((acc, cond, i) => i === 0 ? cond : sql`${acc} AND ${cond}`)}`
    : sql``

  const result = await sql<[{ count: string }]>`
    SELECT COUNT(*) as count
    FROM skill_packages
    ${whereClause}
  `

  return parseInt(result[0].count, 10)
}
