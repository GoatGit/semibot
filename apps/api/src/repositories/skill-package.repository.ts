/**
 * Skill Package Repository — 本地文件存储代理
 */

import * as local from '../lib/skill-local-store'

export type { SkillPackageStatus, SkillPackageSourceType } from '../lib/skill-local-store'

export interface SkillPackageRow {
  id: string
  skill_definition_id: string
  source_type: local.SkillPackageSourceType
  source_url: string | null
  package_path: string
  file_size_bytes: number
  checksum_sha256: string
  status: local.SkillPackageStatus
  validation_result: Record<string, unknown>
  tools: Record<string, unknown>[]
  config: Record<string, unknown>
  installed_at: string | null
  created_at: string
  updated_at: string
}

export interface CreateSkillPackageData {
  skillDefinitionId: string
  sourceType: local.SkillPackageSourceType
  sourceUrl?: string
  packagePath: string
  packageSizeBytes?: number
  checksumSha256: string
  status?: local.SkillPackageStatus
  validationResult?: Record<string, unknown>
  tools?: Record<string, unknown>[]
  config?: Record<string, unknown>
}

export interface UpdateSkillPackageData {
  status?: local.SkillPackageStatus
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
  sourceType: local.SkillPackageSourceType
  sourceUrl?: string
  packagePath: string
  packageSizeBytes: number
  checksumSha256: string
  status: local.SkillPackageStatus
  validationResult: Record<string, unknown>
  tools: Record<string, unknown>[]
  config: Record<string, unknown>
  installedAt?: string
  createdAt: string
  updatedAt: string
}

function rowToSkillPackage(row: local.LocalSkillPackageRow): SkillPackage {
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

export async function create(data: CreateSkillPackageData): Promise<SkillPackage> {
  const row = await local.localCreateSkillPackage(data)
  return rowToSkillPackage(row)
}

export async function findById(id: string): Promise<SkillPackage | null> {
  const row = await local.localFindSkillPackageById(id)
  return row ? rowToSkillPackage(row) : null
}

export async function findByDefinition(skillDefinitionId: string): Promise<SkillPackage | null> {
  const row = await local.localFindSkillPackageByDefinition(skillDefinitionId)
  return row ? rowToSkillPackage(row) : null
}

export async function findAllByDefinition(skillDefinitionId: string): Promise<SkillPackage[]> {
  const rows = await local.localFindAllSkillPackagesByDefinition(skillDefinitionId)
  return rows.map(rowToSkillPackage)
}

export async function findActiveByDefinition(skillDefinitionId: string): Promise<SkillPackage[]> {
  const rows = await local.localFindActiveSkillPackagesByDefinition(skillDefinitionId)
  return rows.map(rowToSkillPackage)
}

export async function findAll(options: {
  page?: number
  pageSize?: number
  status?: local.SkillPackageStatus
  sourceType?: local.SkillPackageSourceType
}): Promise<{ data: SkillPackage[]; total: number; page: number; pageSize: number }> {
  const result = await local.localFindAllSkillPackages(options)
  return { ...result, data: result.data.map(rowToSkillPackage) }
}

export async function update(id: string, data: UpdateSkillPackageData): Promise<SkillPackage> {
  const row = await local.localUpdateSkillPackage(id, data)
  if (!row) throw new Error(`SkillPackage not found: ${id}`)
  return rowToSkillPackage(row)
}

export async function softDelete(id: string): Promise<boolean> {
  return local.localSoftDeleteSkillPackage(id)
}

export async function remove(id: string): Promise<boolean> {
  return local.localRemoveSkillPackage(id)
}

export async function removeByDefinition(skillDefinitionId: string): Promise<number> {
  return local.localRemoveSkillPackagesByDefinition(skillDefinitionId)
}

export async function count(options?: {
  skillDefinitionId?: string
  status?: local.SkillPackageStatus
}): Promise<number> {
  return local.localCountSkillPackages(options)
}
