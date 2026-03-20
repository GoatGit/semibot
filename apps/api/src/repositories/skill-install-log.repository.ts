/**
 * Skill Install Log Repository — 本地文件存储代理
 */

import * as local from '../lib/skill-local-store'

export type { InstallOperation, InstallStatus } from '../lib/skill-local-store'

export interface SkillInstallLogRow {
  id: string
  skill_definition_id: string
  skill_package_id: string | null
  operation: local.InstallOperation
  status: local.InstallStatus
  error_message: string | null
  metadata: Record<string, unknown> | null
  started_at: string
  completed_at: string | null
  created_at: string
}

export interface CreateSkillInstallLogData {
  skillDefinitionId: string
  skillPackageId?: string
  operation: local.InstallOperation
  status?: local.InstallStatus
  errorMessage?: string
  startedAt?: Date
}

export interface UpdateSkillInstallLogData {
  skillPackageId?: string
  status?: local.InstallStatus
  errorMessage?: string
  completedAt?: Date
}

export interface SkillInstallLog {
  id: string
  skillDefinitionId: string
  skillPackageId?: string
  operation: local.InstallOperation
  status: local.InstallStatus
  errorMessage?: string
  startedAt: string
  completedAt?: string
  createdAt: string
}

function rowToSkillInstallLog(row: local.LocalSkillInstallLogRow): SkillInstallLog {
  return {
    id: row.id,
    skillDefinitionId: row.skill_definition_id,
    skillPackageId: row.skill_package_id || undefined,
    operation: row.operation,
    status: row.status,
    errorMessage: row.error_message || undefined,
    startedAt: row.started_at,
    completedAt: row.completed_at || undefined,
    createdAt: row.created_at,
  }
}

export async function create(data: CreateSkillInstallLogData): Promise<SkillInstallLog> {
  const row = await local.localCreateSkillInstallLog(data)
  return rowToSkillInstallLog(row)
}

export async function findByDefinition(skillDefinitionId: string): Promise<SkillInstallLog[]> {
  const rows = await local.localFindSkillInstallLogsByDefinition(skillDefinitionId)
  return rows.map(rowToSkillInstallLog)
}

export async function findAll(options: {
  page?: number
  pageSize?: number
  skillDefinitionId?: string
  status?: local.InstallStatus
  operation?: local.InstallOperation
}): Promise<{ data: SkillInstallLog[]; total: number; page: number; pageSize: number }> {
  const result = await local.localFindAllSkillInstallLogs(options)
  return { ...result, data: result.data.map(rowToSkillInstallLog) }
}

export async function update(id: string, data: UpdateSkillInstallLogData): Promise<SkillInstallLog | null> {
  const row = await local.localUpdateSkillInstallLog(id, data)
  return row ? rowToSkillInstallLog(row) : null
}

export async function remove(id: string): Promise<boolean> {
  return local.localRemoveSkillInstallLog(id)
}

export async function removeByDefinition(skillDefinitionId: string): Promise<number> {
  return local.localRemoveSkillInstallLogsByDefinition(skillDefinitionId)
}

export async function getLatest(
  skillDefinitionId: string,
  operation?: local.InstallOperation
): Promise<SkillInstallLog | null> {
  const row = await local.localGetLatestSkillInstallLog(skillDefinitionId, operation)
  return row ? rowToSkillInstallLog(row) : null
}

export async function getFailedLogs(skillDefinitionId: string, limit = 10): Promise<SkillInstallLog[]> {
  const rows = await local.localGetFailedSkillInstallLogs(skillDefinitionId, limit)
  return rows.map(rowToSkillInstallLog)
}

export async function getSuccessLogs(skillDefinitionId: string, limit = 10): Promise<SkillInstallLog[]> {
  const rows = await local.localGetSuccessSkillInstallLogs(skillDefinitionId, limit)
  return rows.map(rowToSkillInstallLog)
}

export async function count(options?: {
  skillDefinitionId?: string
  status?: local.InstallStatus
  operation?: local.InstallOperation
}): Promise<number> {
  return local.localCountSkillInstallLogs(options)
}
