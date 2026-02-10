/**
 * Skill Install Log Repository
 *
 * 处理 SkillInstallLog 的数据库 CRUD 操作
 */

import { sql } from '../lib/db'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/config'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export type InstallOperation = 'install' | 'rollback' | 'upgrade'
export type InstallStatus = 'pending' | 'in_progress' | 'success' | 'failed'

export interface SkillInstallLogRow {
  id: string
  skill_definition_id: string
  skill_package_id: string | null
  version: string
  operation: InstallOperation
  status: InstallStatus
  error_message: string | null
  started_at: string
  completed_at: string | null
  created_at: string
  updated_at: string
}

export interface CreateSkillInstallLogData {
  skillDefinitionId: string
  skillPackageId?: string
  version: string
  operation: InstallOperation
  status?: InstallStatus
  errorMessage?: string
  startedAt?: Date
}

export interface UpdateSkillInstallLogData {
  skillPackageId?: string
  status?: InstallStatus
  errorMessage?: string
  completedAt?: Date
}

export interface SkillInstallLog {
  id: string
  skillDefinitionId: string
  skillPackageId?: string
  version: string
  operation: InstallOperation
  status: InstallStatus
  errorMessage?: string
  startedAt: string
  completedAt?: string
  createdAt: string
  updatedAt: string
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

function rowToSkillInstallLog(row: SkillInstallLogRow): SkillInstallLog {
  return {
    id: row.id,
    skillDefinitionId: row.skill_definition_id,
    skillPackageId: row.skill_package_id || undefined,
    version: row.version,
    operation: row.operation,
    status: row.status,
    errorMessage: row.error_message || undefined,
    startedAt: row.started_at,
    completedAt: row.completed_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ═══════════════════════════════════════════════════════════════
// CRUD 操作
// ═══════════════════════════════════════════════════════════════

/**
 * 创建安装日志
 */
export async function create(data: CreateSkillInstallLogData): Promise<SkillInstallLog> {
  const rows = await sql<SkillInstallLogRow[]>`
    INSERT INTO skill_install_logs (
      skill_definition_id,
      skill_package_id,
      version,
      operation,
      status,
      error_message,
      started_at
    ) VALUES (
      ${data.skillDefinitionId},
      ${data.skillPackageId || null},
      ${data.version},
      ${data.operation},
      ${data.status || 'pending'},
      ${data.errorMessage || null},
      ${data.startedAt || new Date()}
    )
    RETURNING *
  `

  return rowToSkillInstallLog(rows[0])
}

/**
 * 根据 ID 查找安装日志
 */
export async function findById(id: string): Promise<SkillInstallLog | null> {
  const rows = await sql<SkillInstallLogRow[]>`
    SELECT * FROM skill_install_logs
    WHERE id = ${id}
    LIMIT 1
  `

  return rows.length > 0 ? rowToSkillInstallLog(rows[0]) : null
}

/**
 * 根据技能定义 ID 查找所有日志
 */
export async function findByDefinition(skillDefinitionId: string): Promise<SkillInstallLog[]> {
  const rows = await sql<SkillInstallLogRow[]>`
    SELECT * FROM skill_install_logs
    WHERE skill_definition_id = ${skillDefinitionId}
    ORDER BY started_at DESC
  `

  return rows.map(rowToSkillInstallLog)
}

/**
 * 根据技能包 ID 查找所有日志
 */
export async function findByPackage(skillPackageId: string): Promise<SkillInstallLog[]> {
  const rows = await sql<SkillInstallLogRow[]>`
    SELECT * FROM skill_install_logs
    WHERE skill_package_id = ${skillPackageId}
    ORDER BY started_at DESC
  `

  return rows.map(rowToSkillInstallLog)
}

/**
 * 查找所有安装日志（分页）
 */
export async function findAll(options: {
  page?: number
  pageSize?: number
  skillDefinitionId?: string
  status?: InstallStatus
  operation?: InstallOperation
}): Promise<{ data: SkillInstallLog[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, options.page || 1)
  const pageSize = Math.min(options.pageSize || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  const offset = (page - 1) * pageSize

  // 构建查询条件
  const conditions: string[] = []

  if (options.skillDefinitionId) {
    conditions.push(`skill_definition_id = '${options.skillDefinitionId}'`)
  }

  if (options.status) {
    conditions.push(`status = '${options.status}'`)
  }

  if (options.operation) {
    conditions.push(`operation = '${options.operation}'`)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  // 查询总数
  const countResult = await sql<[{ count: string }]>`
    SELECT COUNT(*) as count
    FROM skill_install_logs
    ${sql.unsafe(whereClause)}
  `
  const total = parseInt(countResult[0].count, 10)

  // 查询数据
  const rows = await sql<SkillInstallLogRow[]>`
    SELECT * FROM skill_install_logs
    ${sql.unsafe(whereClause)}
    ORDER BY started_at DESC
    LIMIT ${pageSize}
    OFFSET ${offset}
  `

  return {
    data: rows.map(rowToSkillInstallLog),
    total,
    page,
    pageSize,
  }
}

/**
 * 更新安装日志
 */
export async function update(id: string, data: UpdateSkillInstallLogData): Promise<SkillInstallLog | null> {
  const rows = await sql<SkillInstallLogRow[]>`
    SELECT * FROM skill_install_logs WHERE id = ${id} LIMIT 1
  `
  if (rows.length === 0) return null

  const current = rows[0]

  const result = await sql<SkillInstallLogRow[]>`
    UPDATE skill_install_logs
    SET skill_package_id = ${data.skillPackageId ?? current.skill_package_id},
        status = ${data.status ?? current.status},
        error_message = ${data.errorMessage ?? current.error_message},
        completed_at = ${data.completedAt ?? current.completed_at},
        updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `

  return result.length > 0 ? rowToSkillInstallLog(result[0]) : null
}

/**
 * 删除安装日志
 * 注：审计日志表保留物理删除，仅用于清理过期日志
 */
export async function remove(id: string): Promise<boolean> {
  const result = await sql`
    DELETE FROM skill_install_logs
    WHERE id = ${id}
  `

  return result.count > 0
}

/**
 * 统计安装日志数量
 */
export async function count(options?: {
  skillDefinitionId?: string
  status?: InstallStatus
  operation?: InstallOperation
}): Promise<number> {
  const conditions: string[] = []

  if (options?.skillDefinitionId) {
    conditions.push(`skill_definition_id = '${options.skillDefinitionId}'`)
  }

  if (options?.status) {
    conditions.push(`status = '${options.status}'`)
  }

  if (options?.operation) {
    conditions.push(`operation = '${options.operation}'`)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const result = await sql<[{ count: string }]>`
    SELECT COUNT(*) as count
    FROM skill_install_logs
    ${sql.unsafe(whereClause)}
  `

  return parseInt(result[0].count, 10)
}

/**
 * 获取最近的安装日志
 */
export async function getLatest(
  skillDefinitionId: string,
  operation?: InstallOperation
): Promise<SkillInstallLog | null> {
  const operationClause = operation ? `AND operation = '${operation}'` : ''

  const rows = await sql<SkillInstallLogRow[]>`
    SELECT * FROM skill_install_logs
    WHERE skill_definition_id = ${skillDefinitionId}
    ${sql.unsafe(operationClause)}
    ORDER BY started_at DESC
    LIMIT 1
  `

  return rows.length > 0 ? rowToSkillInstallLog(rows[0]) : null
}

/**
 * 获取失败的安装日志
 */
export async function getFailedLogs(
  skillDefinitionId: string,
  limit: number = 10
): Promise<SkillInstallLog[]> {
  const rows = await sql<SkillInstallLogRow[]>`
    SELECT * FROM skill_install_logs
    WHERE skill_definition_id = ${skillDefinitionId}
    AND status = 'failed'
    ORDER BY started_at DESC
    LIMIT ${limit}
  `

  return rows.map(rowToSkillInstallLog)
}

/**
 * 获取成功的安装日志
 */
export async function getSuccessLogs(
  skillDefinitionId: string,
  limit: number = 10
): Promise<SkillInstallLog[]> {
  const rows = await sql<SkillInstallLogRow[]>`
    SELECT * FROM skill_install_logs
    WHERE skill_definition_id = ${skillDefinitionId}
    AND status = 'success'
    ORDER BY started_at DESC
    LIMIT ${limit}
  `

  return rows.map(rowToSkillInstallLog)
}
