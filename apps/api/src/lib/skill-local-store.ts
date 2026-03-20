/**
 * Skill SQLite 存储
 */

import { randomUUID } from 'crypto'
import { getLocalDb } from './db-local'
import { createLogger } from './logger'

const logger = createLogger('skill-local-store')

export type SkillPackageStatus = 'pending' | 'downloading' | 'validating' | 'installing' | 'active' | 'deprecated' | 'failed'
export type SkillPackageSourceType = 'anthropic' | 'codex' | 'local' | 'upload'
export type InstallOperation = 'install' | 'rollback' | 'upgrade'
export type InstallStatus = 'pending' | 'in_progress' | 'success' | 'failed'

export interface LocalSkillDefinitionRow {
  id: string
  skill_id: string
  name: string
  description: string | null
  trigger_keywords: string[]
  is_active: boolean
  is_public: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface LocalSkillPackageRow {
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

export interface LocalSkillInstallLogRow {
  id: string
  skill_definition_id: string
  skill_package_id: string | null
  operation: InstallOperation
  status: InstallStatus
  error_message: string | null
  metadata: Record<string, unknown> | null
  started_at: string
  completed_at: string | null
  created_at: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function rowToDef(row: Record<string, unknown>): LocalSkillDefinitionRow {
  return {
    id: row.id as string,
    skill_id: (row.skill_id as string) ?? (row.id as string),
    name: row.name as string,
    description: (row.description as string) ?? null,
    trigger_keywords: JSON.parse((row.tags_json as string) ?? '[]'),
    is_active: (row.is_active as number) === 1,
    is_public: 0 === 0, // all skills are public in single-user mode
    created_by: null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}

function rowToPkg(row: Record<string, unknown>): LocalSkillPackageRow {
  return {
    id: row.id as string,
    skill_definition_id: row.skill_id as string,
    source_type: (row.source_type as SkillPackageSourceType) ?? 'local',
    source_url: (row.source_url as string) ?? null,
    package_path: (row.package_path as string) ?? '',
    file_size_bytes: (row.file_size_bytes as number) ?? 0,
    checksum_sha256: (row.checksum as string) ?? '',
    status: (row.status as SkillPackageStatus) ?? 'active',
    validation_result: JSON.parse((row.metadata_json as string) ?? '{}'),
    tools: [],
    config: JSON.parse((row.config_json as string) ?? '{}'),
    installed_at: (row.installed_at as string) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}

function rowToLog(row: Record<string, unknown>): LocalSkillInstallLogRow {
  return {
    id: row.id as string,
    skill_definition_id: row.skill_id as string,
    skill_package_id: (row.package_id as string) ?? null,
    operation: (row.action as InstallOperation) ?? 'install',
    status: (row.status as InstallStatus) ?? 'pending',
    error_message: (row.error_message as string) ?? null,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json as string) : null,
    started_at: row.created_at as string,
    completed_at: null,
    created_at: row.created_at as string,
  }
}

// ─── Skill Definitions ────────────────────────────────────────

export function localCreateSkillDefinition(data: {
  skillId: string
  name: string
  description?: string
  triggerKeywords?: string[]
  isActive?: boolean
  isPublic?: boolean
  createdBy?: string
}): LocalSkillDefinitionRow {
  const db = getLocalDb()
  const now = nowIso()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO skill_definitions (id, name, description, tags_json, is_active, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '1.0.0', ?, ?)
  `).run(id, data.name, data.description ?? null, JSON.stringify(data.triggerKeywords ?? []), data.isActive !== false ? 1 : 0, now, now)
  logger.debug('创建 skill definition', { id })
  return rowToDef(db.prepare('SELECT * FROM skill_definitions WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localFindSkillDefinitionById(id: string): LocalSkillDefinitionRow | null {
  const row = getLocalDb().prepare('SELECT * FROM skill_definitions WHERE id = ? AND deleted_at IS NULL').get(id)
  return row ? rowToDef(row as Record<string, unknown>) : null
}

export function localFindSkillDefinitionBySkillId(skillId: string): LocalSkillDefinitionRow | null {
  // In the new schema, id IS the skill_id
  return localFindSkillDefinitionById(skillId)
}

export function localFindAllSkillDefinitions(options: {
  page?: number
  pageSize?: number
  isActive?: boolean
  isPublic?: boolean
  search?: string
}): { data: LocalSkillDefinitionRow[]; total: number; page: number; pageSize: number } {
  const db = getLocalDb()
  let where = 'WHERE deleted_at IS NULL'
  const binds: unknown[] = []
  if (options.isActive !== undefined) { where += ' AND is_active = ?'; binds.push(options.isActive ? 1 : 0) }
  if (options.search) {
    where += ' AND (name LIKE ? OR description LIKE ?)'
    binds.push(`%${options.search}%`, `%${options.search}%`)
  }
  const page = Math.max(1, options.page ?? 1)
  const pageSize = Math.min(options.pageSize ?? 20, 100)
  const total = (db.prepare(`SELECT COUNT(*) as c FROM skill_definitions ${where}`).get(...binds) as { c: number }).c
  const rows = db.prepare(`SELECT * FROM skill_definitions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...binds, pageSize, (page - 1) * pageSize)
  return { data: rows.map((r) => rowToDef(r as Record<string, unknown>)), total, page, pageSize }
}

export function localUpdateSkillDefinition(id: string, data: {
  name?: string
  description?: string
  triggerKeywords?: string[]
  isActive?: boolean
  isPublic?: boolean
}): LocalSkillDefinitionRow | null {
  const db = getLocalDb()
  const sets: string[] = ['updated_at = ?']
  const vals: unknown[] = [nowIso()]
  if (data.name !== undefined) { sets.push('name = ?'); vals.push(data.name) }
  if (data.description !== undefined) { sets.push('description = ?'); vals.push(data.description) }
  if (data.triggerKeywords !== undefined) { sets.push('tags_json = ?'); vals.push(JSON.stringify(data.triggerKeywords)) }
  if (data.isActive !== undefined) { sets.push('is_active = ?'); vals.push(data.isActive ? 1 : 0) }
  vals.push(id)
  const result = db.prepare(`UPDATE skill_definitions SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...vals)
  if ((result.changes ?? 0) === 0) return null
  return rowToDef(db.prepare('SELECT * FROM skill_definitions WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localSoftDeleteSkillDefinition(id: string): boolean {
  const result = getLocalDb().prepare(
    'UPDATE skill_definitions SET deleted_at = ?, is_active = 0, updated_at = ? WHERE id = ? AND deleted_at IS NULL'
  ).run(nowIso(), nowIso(), id)
  return (result.changes ?? 0) > 0
}

export function localRemoveSkillDefinition(id: string): boolean {
  const result = getLocalDb().prepare('DELETE FROM skill_definitions WHERE id = ?').run(id)
  return (result.changes ?? 0) > 0
}

export function localSkillDefinitionExistsBySkillId(skillId: string): boolean {
  const row = getLocalDb().prepare('SELECT id FROM skill_definitions WHERE id = ? AND deleted_at IS NULL').get(skillId)
  return row !== undefined
}

export function localCountSkillDefinitions(options?: { isActive?: boolean; isPublic?: boolean }): number {
  let where = 'WHERE deleted_at IS NULL'
  const binds: unknown[] = []
  if (options?.isActive !== undefined) { where += ' AND is_active = ?'; binds.push(options.isActive ? 1 : 0) }
  return ((getLocalDb().prepare(`SELECT COUNT(*) as c FROM skill_definitions ${where}`).get(...binds) as { c: number }).c)
}

// ─── Skill Packages ───────────────────────────────────────────

export function localCreateSkillPackage(data: {
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
}): LocalSkillPackageRow {
  const db = getLocalDb()
  const now = nowIso()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO skill_packages (id, skill_id, version, runtime, entry_point, package_path, checksum, metadata_json, is_active, created_at, updated_at)
    VALUES (?, ?, '1.0.0', 'python', NULL, ?, ?, ?, 1, ?, ?)
  `).run(id, data.skillDefinitionId, data.packagePath, data.checksumSha256,
    JSON.stringify(data.validationResult ?? {}), now, now)
  return rowToPkg(db.prepare('SELECT * FROM skill_packages WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localFindSkillPackageById(id: string): LocalSkillPackageRow | null {
  const row = getLocalDb().prepare('SELECT * FROM skill_packages WHERE id = ? AND deleted_at IS NULL').get(id)
  return row ? rowToPkg(row as Record<string, unknown>) : null
}

export function localFindSkillPackageByDefinition(skillDefinitionId: string): LocalSkillPackageRow | null {
  const row = getLocalDb().prepare(
    'SELECT * FROM skill_packages WHERE skill_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1'
  ).get(skillDefinitionId)
  return row ? rowToPkg(row as Record<string, unknown>) : null
}

export function localFindAllSkillPackagesByDefinition(skillDefinitionId: string): LocalSkillPackageRow[] {
  const rows = getLocalDb().prepare(
    'SELECT * FROM skill_packages WHERE skill_id = ? AND deleted_at IS NULL ORDER BY created_at DESC'
  ).all(skillDefinitionId)
  return rows.map((r) => rowToPkg(r as Record<string, unknown>))
}

export function localFindActiveSkillPackagesByDefinition(skillDefinitionId: string): LocalSkillPackageRow[] {
  const rows = getLocalDb().prepare(
    'SELECT * FROM skill_packages WHERE skill_id = ? AND is_active = 1 AND deleted_at IS NULL ORDER BY created_at DESC'
  ).all(skillDefinitionId)
  return rows.map((r) => rowToPkg(r as Record<string, unknown>))
}

export function localFindAllSkillPackages(options: {
  page?: number
  pageSize?: number
  status?: SkillPackageStatus
  sourceType?: SkillPackageSourceType
}): { data: LocalSkillPackageRow[]; total: number; page: number; pageSize: number } {
  const db = getLocalDb()
  let where = 'WHERE deleted_at IS NULL'
  const binds: unknown[] = []
  if (options.status) { where += ' AND is_active = ?'; binds.push(options.status === 'active' ? 1 : 0) }
  const page = Math.max(1, options.page ?? 1)
  const pageSize = Math.min(options.pageSize ?? 20, 100)
  const total = (db.prepare(`SELECT COUNT(*) as c FROM skill_packages ${where}`).get(...binds) as { c: number }).c
  const rows = db.prepare(`SELECT * FROM skill_packages ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...binds, pageSize, (page - 1) * pageSize)
  return { data: rows.map((r) => rowToPkg(r as Record<string, unknown>)), total, page, pageSize }
}

export function localUpdateSkillPackage(id: string, data: {
  status?: SkillPackageStatus
  packageSizeBytes?: number
  checksumSha256?: string
  validationResult?: Record<string, unknown>
  tools?: Record<string, unknown>[]
  config?: Record<string, unknown>
  installedAt?: Date | string | null
}): LocalSkillPackageRow | null {
  const db = getLocalDb()
  const sets: string[] = ['updated_at = ?']
  const vals: unknown[] = [nowIso()]
  if (data.status !== undefined) { sets.push('is_active = ?'); vals.push(data.status === 'active' ? 1 : 0) }
  if (data.checksumSha256 !== undefined) { sets.push('checksum = ?'); vals.push(data.checksumSha256) }
  if (data.validationResult !== undefined) { sets.push('metadata_json = ?'); vals.push(JSON.stringify(data.validationResult)) }
  vals.push(id)
  const result = db.prepare(`UPDATE skill_packages SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...vals)
  if ((result.changes ?? 0) === 0) return null
  return rowToPkg(db.prepare('SELECT * FROM skill_packages WHERE id = ? AND deleted_at IS NULL').get(id) as Record<string, unknown>)
}

export function localSoftDeleteSkillPackage(id: string): boolean {
  const result = getLocalDb().prepare(
    'UPDATE skill_packages SET deleted_at = ?, is_active = 0, updated_at = ? WHERE id = ? AND deleted_at IS NULL'
  ).run(nowIso(), nowIso(), id)
  return (result.changes ?? 0) > 0
}

export function localRemoveSkillPackage(id: string): boolean {
  const result = getLocalDb().prepare('DELETE FROM skill_packages WHERE id = ?').run(id)
  return (result.changes ?? 0) > 0
}

export function localRemoveSkillPackagesByDefinition(skillDefinitionId: string): number {
  const result = getLocalDb().prepare('DELETE FROM skill_packages WHERE skill_id = ?').run(skillDefinitionId)
  return result.changes ?? 0
}

export function localCountSkillPackages(options?: { skillDefinitionId?: string; status?: SkillPackageStatus }): number {
  let where = 'WHERE deleted_at IS NULL'
  const binds: unknown[] = []
  if (options?.skillDefinitionId) { where += ' AND skill_id = ?'; binds.push(options.skillDefinitionId) }
  if (options?.status) { where += ' AND is_active = ?'; binds.push(options.status === 'active' ? 1 : 0) }
  return ((getLocalDb().prepare(`SELECT COUNT(*) as c FROM skill_packages ${where}`).get(...binds) as { c: number }).c)
}

// ─── Skill Install Logs ───────────────────────────────────────

export function localCreateSkillInstallLog(data: {
  skillDefinitionId: string
  skillPackageId?: string
  operation: InstallOperation
  status?: InstallStatus
  errorMessage?: string
  startedAt?: Date
}): LocalSkillInstallLogRow {
  const db = getLocalDb()
  const now = nowIso()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO skill_install_logs (id, skill_id, package_id, action, status, error_message, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '{}', ?)
  `).run(id, data.skillDefinitionId, data.skillPackageId ?? null, data.operation, data.status ?? 'pending', data.errorMessage ?? null, now)
  return rowToLog(db.prepare('SELECT * FROM skill_install_logs WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localFindSkillInstallLogsByDefinition(skillDefinitionId: string): LocalSkillInstallLogRow[] {
  const rows = getLocalDb().prepare(
    'SELECT * FROM skill_install_logs WHERE skill_id = ? ORDER BY created_at DESC'
  ).all(skillDefinitionId)
  return rows.map((r) => rowToLog(r as Record<string, unknown>))
}

export function localFindAllSkillInstallLogs(options: {
  page?: number
  pageSize?: number
  skillDefinitionId?: string
  status?: InstallStatus
  operation?: InstallOperation
}): { data: LocalSkillInstallLogRow[]; total: number; page: number; pageSize: number } {
  const db = getLocalDb()
  let where = 'WHERE 1=1'
  const binds: unknown[] = []
  if (options.skillDefinitionId) { where += ' AND skill_id = ?'; binds.push(options.skillDefinitionId) }
  if (options.status) { where += ' AND status = ?'; binds.push(options.status) }
  if (options.operation) { where += ' AND action = ?'; binds.push(options.operation) }
  const page = Math.max(1, options.page ?? 1)
  const pageSize = Math.min(options.pageSize ?? 20, 100)
  const total = (db.prepare(`SELECT COUNT(*) as c FROM skill_install_logs ${where}`).get(...binds) as { c: number }).c
  const rows = db.prepare(`SELECT * FROM skill_install_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...binds, pageSize, (page - 1) * pageSize)
  return { data: rows.map((r) => rowToLog(r as Record<string, unknown>)), total, page, pageSize }
}

export function localUpdateSkillInstallLog(id: string, data: {
  skillPackageId?: string
  status?: InstallStatus
  errorMessage?: string
  completedAt?: Date
}): LocalSkillInstallLogRow | null {
  const db = getLocalDb()
  const sets: string[] = []
  const vals: unknown[] = []
  if (data.skillPackageId !== undefined) { sets.push('package_id = ?'); vals.push(data.skillPackageId) }
  if (data.status !== undefined) { sets.push('status = ?'); vals.push(data.status) }
  if (data.errorMessage !== undefined) { sets.push('error_message = ?'); vals.push(data.errorMessage) }
  if (sets.length === 0) return rowToLog(db.prepare('SELECT * FROM skill_install_logs WHERE id = ?').get(id) as Record<string, unknown>)
  vals.push(id)
  db.prepare(`UPDATE skill_install_logs SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  return rowToLog(db.prepare('SELECT * FROM skill_install_logs WHERE id = ?').get(id) as Record<string, unknown>)
}

export function localRemoveSkillInstallLog(id: string): boolean {
  const result = getLocalDb().prepare('DELETE FROM skill_install_logs WHERE id = ?').run(id)
  return (result.changes ?? 0) > 0
}

export function localRemoveSkillInstallLogsByDefinition(skillDefinitionId: string): number {
  const result = getLocalDb().prepare('DELETE FROM skill_install_logs WHERE skill_id = ?').run(skillDefinitionId)
  return result.changes ?? 0
}

export function localGetLatestSkillInstallLog(skillDefinitionId: string, operation?: InstallOperation): LocalSkillInstallLogRow | null {
  let query = 'SELECT * FROM skill_install_logs WHERE skill_id = ?'
  const binds: unknown[] = [skillDefinitionId]
  if (operation) { query += ' AND action = ?'; binds.push(operation) }
  query += ' ORDER BY created_at DESC LIMIT 1'
  const row = getLocalDb().prepare(query).get(...binds)
  return row ? rowToLog(row as Record<string, unknown>) : null
}

export function localGetFailedSkillInstallLogs(skillDefinitionId: string, limit = 10): LocalSkillInstallLogRow[] {
  const rows = getLocalDb().prepare(
    'SELECT * FROM skill_install_logs WHERE skill_id = ? AND status = \'failed\' ORDER BY created_at DESC LIMIT ?'
  ).all(skillDefinitionId, limit)
  return rows.map((r) => rowToLog(r as Record<string, unknown>))
}

export function localGetSuccessSkillInstallLogs(skillDefinitionId: string, limit = 10): LocalSkillInstallLogRow[] {
  const rows = getLocalDb().prepare(
    'SELECT * FROM skill_install_logs WHERE skill_id = ? AND status = \'success\' ORDER BY created_at DESC LIMIT ?'
  ).all(skillDefinitionId, limit)
  return rows.map((r) => rowToLog(r as Record<string, unknown>))
}

export function localCountSkillInstallLogs(options?: { skillDefinitionId?: string; status?: InstallStatus; operation?: InstallOperation }): number {
  let where = 'WHERE 1=1'
  const binds: unknown[] = []
  if (options?.skillDefinitionId) { where += ' AND skill_id = ?'; binds.push(options.skillDefinitionId) }
  if (options?.status) { where += ' AND status = ?'; binds.push(options.status) }
  if (options?.operation) { where += ' AND action = ?'; binds.push(options.operation) }
  return ((getLocalDb().prepare(`SELECT COUNT(*) as c FROM skill_install_logs ${where}`).get(...binds) as { c: number }).c)
}
